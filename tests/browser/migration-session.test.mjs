import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { chromium } from '@playwright/test';
import { ArtifactStore } from '../../packages/engine/dist/artifacts.js';
import { prepareMigration } from '../../packages/engine/dist/migration-operations.js';
import { startMigrationSession, verifyMigrationSession, inspectMigrationSession } from '../../packages/engine/dist/migration-session.js';
import { buildWorkspace, write } from '../helpers/build-workspace.mjs';

const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const good = 'document.querySelector("button").onclick=()=>{document.querySelector("p").hidden=false};';
const broken = 'document.querySelector("button").onclick=()=>{};';
async function fixture(t, maxRepairAttempts = 3) {
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch { t.skip('Chromium unavailable'); return; }
  finally { await browser?.close(); }
  const { root, config } = await buildWorkspace();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(new ArtifactStore(join(root, 'artifacts/prepared')).privateRoot, { recursive: true, force: true });
  });
  config.profile = 'standard'; config.limits.maxDurationMs = 120000;
  config.limits.maxRepairAttempts = maxRepairAttempts;
  config.target.writePaths = ['page.js', 'page.css', 'assets'];
  for (const side of ['source', 'target']) {
    config[side].relevantFiles.push('page.js');
    await write(root, `${side}/page.js`, good);
    await write(root, `${side}/build.mjs`, `import {mkdirSync,writeFileSync,copyFileSync,readFileSync} from 'node:fs';
if(readFileSync('page.js','utf8').includes('FAIL_BUILD')) process.exit(1);
mkdirSync('dist',{recursive:true});
writeFileSync('dist/index.html','<!doctype html><html lang="en"><head><title>Session fixture</title></head><body><button>Save</button><p role="alert" aria-label="Saved" hidden>Saved</p><script src="/app.js"></script></body></html>');
copyFileSync('page.js','dist/app.js');
if(readFileSync('page.js','utf8').includes('MUTATE_DURING_BUILD')) writeFileSync('page.css','p {color:red}');`);
  }
  config.scenarios[0].definition.steps = [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }];
  config.requirements = [{ id: 'confirmation', scenarioId: 'boot', description: 'Save confirmation', origin: 'SPECIFICATION', sourceReference: 'fixture', required: true,
    assertion: { checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NODE_PRESENT', role: 'alert', name: 'Saved' } } }];
  const input = { config, workspaceRoot: root };
  const preparation = await prepareMigration({ ...input, artifactPath: 'artifacts/prepared', allowProjectCommands: true });
  assert.equal(preparation.status, 'PASS');
  return { root, config, input, preparation };
}

test('standard session repairs real implementation failure and checks the entire current candidate', async t => {
  const f = await fixture(t, 1); if (!f) return;
  await write(f.root, 'target/user.txt', 'preexisting uncommitted work');
  await write(f.root, 'migration.json', JSON.stringify(f.config));
  const started = await exec(process.execPath, [cli, 'start-migration-session', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root,
    '--preparation', join(f.root, 'artifacts/prepared/preparation.json')]);
  assert.equal(JSON.parse(started.stdout).kind, 'MIGRATION_SESSION_STARTED');
  await write(f.root, 'target/page.js', broken);
  await write(f.root, 'target/page.css', 'p { color: green; }');
  await write(f.root, 'target/assets/logo.bin', Buffer.from([0, 255, 1]));
  const failed = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(failed.decision, 'REPAIR_IMPLEMENTATION');
  assert.equal(failed.outcome, 'FAIL'); assert.equal(failed.report.requirements, 'FAIL');
  assert.equal(failed.attemptsUsed, 1);
  assert.ok(failed.report.diagnostics.some(item => item.code === 'REQUIREMENT_VIOLATED'));
  await write(f.root, 'target/page.js', good);
  const passed = await exec(process.execPath, [cli, 'verify-migration', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root, '--allow-project-commands']);
  assert.match(passed.stdout, /MIGRATION_SESSION_RESULT: COMPLETE/);
  let status = await inspectMigrationSession(f.input);
  assert.equal(status.attemptsUsed, 2); assert.equal(status.lastReportMatchesWorkspace, true);
  assert.equal(status.stop, 'STOP_LIMIT');
  const completedStatus = await exec(process.execPath, [cli, 'migration-session-status', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root]);
  assert.equal(JSON.parse(completedStatus.stdout).lastReportMatchesWorkspace, true);
  assert.deepEqual(status.attempts.map(item => item.outcome), ['FAIL', 'PASS']);
  assert.equal(await readFile(join(f.root, 'target/user.txt'), 'utf8'), 'preexisting uncommitted work');
  await write(f.root, 'target/page.js', broken);
  assert.equal((await inspectMigrationSession(f.input)).lastReportMatchesWorkspace, false);
  await write(f.root, 'target/page.js', good);
  const reportPath = status.attempts.at(-1).reportPath;
  const report = JSON.parse(await readFile(join(f.root, reportPath), 'utf8')); report.evaluatedAt = '2020-01-01T00:00:00.000Z';
  await write(f.root, reportPath, JSON.stringify(report));
  await assert.rejects(inspectMigrationSession(f.input), /SESSION_REPORT_INVALID/);
});

test('a passing behavioral report cannot approve candidate edits made during verification', async t => {
  const f = await fixture(t); if (!f) return;
  await startMigrationSession({ ...f.input, preparation: f.preparation });
  await write(f.root, 'target/page.js', `${good}\n// MUTATE_DURING_BUILD`);
  const result = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(result.report.status, 'PASS');
  assert.equal(result.decision, 'REFUSED_SCOPE'); assert.equal(result.outcome, 'REFUSED_SCOPE');
  assert.equal(result.errorCode, 'CANDIDATE_CHANGED_DURING_VERIFICATION');
  assert.equal((await inspectMigrationSession(f.input)).lastReportMatchesWorkspace, false);
});

test('identical real failed candidates stop without resetting the persisted counter', async t => {
  const f = await fixture(t); if (!f) return;
  await startMigrationSession({ ...f.input, preparation: f.preparation });
  await write(f.root, 'target/page.js', broken);
  const first = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(first.decision, 'REPAIR_IMPLEMENTATION');
  const second = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(second.decision, 'STOP_NO_PROGRESS'); assert.equal(second.attemptsUsed, 2);
  const stopped = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(stopped.decision, 'STOP_NO_PROGRESS'); assert.equal(stopped.attemptsUsed, 2);
  await assert.rejects(startMigrationSession({ ...f.input, preparation: f.preparation }), /SESSION_ALREADY_EXISTS/);
});

test('target build failures and missing controls request implementation repair, never blanket reference review', async t => {
  const f = await fixture(t); if (!f) return;
  await startMigrationSession({ ...f.input, preparation: f.preparation });
  await write(f.root, 'target/page.js', `${good}\n// FAIL_BUILD`);
  const build = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(build.decision, 'REPAIR_IMPLEMENTATION');
  assert.equal(build.report.projectChecks, 'FAIL');
  assert.notEqual(build.outcome, 'PASS');
  await write(f.root, 'target/page.js', 'document.querySelector("button").remove();');
  const control = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(control.decision, 'REPAIR_IMPLEMENTATION');
  assert.ok(control.report.diagnostics.some(item => item.side === 'target' && item.detailCode === 'STEP_FAILED'));
  assert.notEqual(control.outcome, 'PASS');
  await write(f.root, 'target/page.js', good);
  assert.equal((await verifyMigrationSession({ ...f.input, allowProjectCommands: true })).decision, 'COMPLETE');
});
