import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareMigration } from '../packages/engine/dist/migration-operations.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { migrationSessionPath, startMigrationSession } from '../packages/engine/dist/migration-session.js';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// PLAN-V2 §11.2 A7: `runs/*/comparisons/*.json` must let an operator locate a FAIL without diffing
// traces — every divergence diagnostic carries the safe expected/actual projection the comparison
// already publishes (paths, value kinds, fingerprints). Observed values and raw traces never appear:
// the projection is what the pipeline itself exposes, screened by the public artifact writer.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');

let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }
const withoutChromium = t => {
  if (!chromiumIssue) return false;
  t.skip(`Chromium unavailable: ${chromiumIssue}`);
  return true;
};

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { timeout: 180_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

const completionSignal = { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'ready', timeoutMs: 2500 };
const appScript = handlerBody => `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', ${JSON.stringify(`document.querySelector("button").onclick=()=>{document.querySelector("output").textContent="Saved";${handlerBody}};`)});
writeFileSync('dist/app.js.map', '{}');`;

test('a divergent comparison records the safe expected/actual summary in runs/*/comparisons (A7)', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  config.limits = { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 600_000 };
  config.policy = { sanitization: { allowedStorageKeys: ['ready'] } };
  config.scenarios[0].definition.completionSignal = completionSignal;
  config.scenarios[0].definition.steps = [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }];
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionPath = migrationSessionPath(config);
  const touched = ['artifacts/prepared', 'artifacts/prepared/capture', sessionPath,
    ...['runs/0000', 'runs/0000/capture'].map(suffix => `${sessionPath}/${suffix}`)];
  t.after(() => Promise.all(touched.map(path => rm(new ArtifactStore(join(root, path)).privateRoot,
    { recursive: true, force: true }))));

  // Two divergences, both with a published projection: the target stores a different value (source
  // side detail only) and the target performs one extra navigation (both sides), so the artifact has
  // to expose `expected`, `actual`, and `expected` alone — exactly what the comparison publishes.
  await write(root, 'source/build.mjs', appScript('localStorage.setItem("ready","yes");'));
  // The target stores a different value and, on the same click, navigates to one more page: two
  // divergences whose projections the comparison publishes on one or both sides.
  await write(root, 'target/build.mjs', appScript('localStorage.setItem("ready","different");location.href="/after";')
    + "writeFileSync('dist/after.html', '<!doctype html><html lang=\"en\"><body>After</body></html>');\n");
  await write(root, 'migration.json', JSON.stringify(config));

  const input = { config, workspaceRoot: root };
  const preparation = await prepareMigration({ ...input, artifactPath: 'artifacts/prepared', allowProjectCommands: true });
  assert.equal(preparation.kind, 'MIGRATION_PREPARATION');
  assert.equal(preparation.status, 'PASS');
  await startMigrationSession({ ...input, preparation });

  const verified = await run(['verify', '--config', join(root, 'migration.json'), '--workspace-root', root,
    '--allow-project-commands', '--json']);
  assert.equal(verified.code, 4, `a divergent candidate is a FAIL: ${verified.stderr}`);

  const runs = await readdir(join(root, sessionPath, 'runs'));
  assert.equal(runs.length, 1);
  const comparisonDir = join(root, sessionPath, 'runs', runs[0], 'comparisons');
  const files = await readdir(comparisonDir);
  assert.ok(files.length > 0, 'the comparison artifact exists');
  const diagnostics = [].concat(...await Promise.all(files.map(async file =>
    JSON.parse(await readFile(join(comparisonDir, file), 'utf8')).diagnostics)));

  const navigation = diagnostics.find(item => item.detailCode === 'NAVIGATION_MISMATCH');
  assert.ok(navigation, `the divergent navigation is recorded: ${JSON.stringify(diagnostics)}`);
  assert.ok(Array.isArray(navigation.expected) && Array.isArray(navigation.actual),
    'both sides of the divergence are projected');
  assert.equal(navigation.expected.length, 1, 'the source performed the declared navigation');
  assert.ok(navigation.actual.includes('/after'), 'the extra target navigation is named, not implied');

  const storage = diagnostics.find(item => item.detailCode === 'STORAGE_MISMATCH');
  assert.ok(storage, 'the divergent storage key is recorded');
  assert.ok(Array.isArray(storage.expected));
  assert.equal(storage.expected[0].key, 'ready', 'the operator gets the key and the difference kind');
  assert.equal(storage.expected[0].difference, 'VALUE');
  assert.equal('actual' in storage, false, 'a projection without a counterpart stays absent (§4)');

  // Privacy: the diverging observed value, trace tokens and raw traces never reach the artifact.
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes('different'), false, 'an observed value never reaches a public artifact');
  assert.equal(/p_[0-9a-f]{24}/.test(serialized), false, 'no pseudonymized trace token');
  assert.equal(/"events"\s*:/.test(serialized), false, 'no raw trace');

  // The report the operator reads carries the same projection as the artifact on disk.
  const envelope = JSON.parse(verified.stdout);
  const reported = envelope.report.report.scenarios[0].diagnostics;
  const reportedNavigation = reported.find(item => item.detailCode === 'NAVIGATION_MISMATCH');
  assert.ok(reportedNavigation && reportedNavigation.expected && reportedNavigation.actual,
    'the report and the comparison file agree');
});
