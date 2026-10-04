import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exitCodeFor } from '../packages/cli/dist/v2/envelope.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';

// Canonical owner of the decision × exit matrix (PLAN-V2 §11.1 item 3, kill switch §8.2): what the
// CLI v2 `verify` answers for each standard-session decision, observed on real runs — COMPLETE → 0,
// REPAIR_IMPLEMENTATION + FAIL → 4, FIX_ENVIRONMENT + INCONCLUSIVE → 5 and
// REPAIR_IMPLEMENTATION + INCONCLUSIVE → 5 (exit codes follow the outcome, never the decision).
// Asserts are decision/outcome/report status only; the frozen table itself is
// tests/v2-envelope.test.mjs, session refusals are tests/v2-commands.test.mjs and budget stops are
// tests/v2-polish-refusals.test.mjs — this file never re-derives them.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const read = async (args) => {
  try { const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { timeout: 180_000 }); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }; }
};
const json = run => JSON.parse(run.stdout);
/** The envelope's `report` is the session result; the migration report is nested inside it. */
const migrationReport = envelope => envelope.report.report;

// The four rows below run complete prepare/verify chains (real Chromium captures), so on a host
// without Chromium every test skips explicitly instead of failing — same pattern as
// tests/perf-browser-cleanup.test.mjs.
let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }
const withoutChromium = t => {
  if (!chromiumIssue) return false;
  t.skip(`Chromium unavailable: ${chromiumIssue}`);
  return true;
};

const appScript = storageStatement => `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', ${JSON.stringify(`document.querySelector("button").onclick=()=>{document.querySelector("output").textContent="Saved";${storageStatement}};`)});
writeFileSync('dist/app.js.map', '{}');`;

const completionSignal = { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'ready', timeoutMs: 2500 };
const storageStep = { stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' };

/**
 * Real v2 prepare (which opens the resumable session) plus a v2 verify, over the served-build
 * workspace. The target's declared behavior and the placement of the completion signal choose the
 * decision under test; source behavior is always the same, so the reference stays verified.
 */
async function verifyFixture(t, { targetStorage, signalPlacement = 'definition' }) {
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  config.limits = { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 600000 };
  config.policy = { sanitization: { allowedStorageKeys: ['ready'] } };
  config.scenarios[0].definition.steps = signalPlacement === 'step'
    ? [{ ...storageStep, completionSignal }] : [storageStep];
  if (signalPlacement === 'definition') config.scenarios[0].definition.completionSignal = completionSignal;
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'source/build.mjs', appScript('localStorage.setItem("ready","yes");'));
  await write(root, 'target/build.mjs', appScript(targetStorage));
  await write(root, 'migration.json', JSON.stringify(config));
  const artifactPath = 'artifacts/prepared';
  t.after(() => rm(new ArtifactStore(join(root, artifactPath)).privateRoot, { recursive: true, force: true }));
  const base = ['--config', join(root, 'migration.json'), '--workspace-root', root];
  const prepared = await read(['prepare', ...base, '--artifact-path', artifactPath, '--allow-project-commands', '--json']);
  assert.equal(prepared.code, 0, `prepare must open the session: ${prepared.stdout}${prepared.stderr}`);
  assert.equal(json(prepared).decision, 'READY');
  assert.equal(json(prepared).outcome, 'PASS');
  const verify = () => read(['verify', ...base, '--allow-project-commands', '--json']);
  return { root, verify };
}

test('an equivalent candidate completes the session: decision COMPLETE, PASS report, exit 0', async t => {
  if (withoutChromium(t)) return;
  const f = await verifyFixture(t, { targetStorage: 'localStorage.setItem("ready","yes");' });
  const run = await f.verify();
  const envelope = json(run);
  assert.equal(run.code, 0, 'COMPLETE maps to exit 0');
  assert.equal(run.code, exitCodeFor(envelope.operationStatus, envelope.decision, envelope.outcome), 'the CLI exit code is the frozen table');
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.decision, 'COMPLETE');
  assert.equal(envelope.outcome, 'PASS');
  assert.equal(envelope.report.kind, 'MIGRATION_SESSION_RESULT');
  const report = migrationReport(envelope);
  assert.equal(report.status, 'PASS');
  assert.equal(report.preservation, 'PASS');
  assert.equal(report.projectChecks, 'PASS');
  assert.equal(report.referenceStatus, 'VERIFIED');
  assert.equal(report.requiredCoverage.scenarios.received, report.requiredCoverage.scenarios.expected);
  assert.ok(report.scenarios.every(item => item.status === 'PASS'));
});

test('a target behavior divergence decides REPAIR_IMPLEMENTATION with a FAIL report and exit 4', async t => {
  if (withoutChromium(t)) return;
  // Same completion signal on both sides (the target still satisfies it), different stored value.
  const f = await verifyFixture(t, { targetStorage: 'localStorage.setItem("ready","different");' });
  const run = await f.verify();
  const envelope = json(run);
  assert.equal(run.code, 4, 'a FAIL outcome maps to exit 4');
  assert.equal(run.code, exitCodeFor(envelope.operationStatus, envelope.decision, envelope.outcome), 'the CLI exit code is the frozen table');
  assert.equal(envelope.decision, 'REPAIR_IMPLEMENTATION');
  assert.equal(envelope.outcome, 'FAIL');
  const report = migrationReport(envelope);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.preservation, 'FAIL');
  assert.ok(report.scenarios.some(item => item.status === 'FAIL'));
  assert.ok(report.diagnostics.some(item => item.code === 'BEHAVIOR_DIVERGENCE' && item.detailCode === 'STORAGE_MISMATCH'),
    'the FAIL is attributed to the divergent storage evidence');
  assert.ok(!report.diagnostics.some(item => item.code === 'WEAK_PRIVATE_PERMISSIONS' || item.code === 'DEGRADED_ISOLATION'),
    'strict privacy reports carry no disclosure noise');
  assert.equal(envelope.report.attemptsUsed, 1);
});

test('an unsatisfied scenario completion decides FIX_ENVIRONMENT: INCONCLUSIVE, never a pass, exit 5', async t => {
  if (withoutChromium(t)) return;
  // The target keeps the declared control and the click succeeds, but the scenario-level completion
  // signal is never satisfied: evidence stays incomplete while the reference stays verified.
  const f = await verifyFixture(t, { targetStorage: '' });
  const run = await f.verify();
  const envelope = json(run);
  assert.equal(run.code, 5, 'a non-FAIL, non-COMPLETE decision maps to exit 5');
  assert.equal(run.code, exitCodeFor(envelope.operationStatus, envelope.decision, envelope.outcome), 'the CLI exit code is the frozen table');
  assert.equal(envelope.decision, 'FIX_ENVIRONMENT');
  assert.equal(envelope.outcome, 'INCONCLUSIVE');
  const report = migrationReport(envelope);
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.equal(report.referenceStatus, 'VERIFIED', 'incomplete evidence never reclassifies a verified reference');
  assert.ok(report.diagnostics.some(item => item.code === 'EXECUTION_INCOMPLETE'
    && item.detailCode === 'COMPLETION_FAILED' && item.side === 'target'));
  assert.notEqual(report.status, 'PASS', 'incomplete evidence can never become a pass');
});

test('the same failure under a step-level completion signal decides REPAIR_IMPLEMENTATION but still exits 5', async t => {
  if (withoutChromium(t)) return;
  // The identical missing behavior is classified from the runner stage: a step-scoped completion
  // timeout reports STEP_FAILED, so disposition asks for a repair — yet the inconclusive outcome,
  // not the decision, drives the exit code.
  const f = await verifyFixture(t, { targetStorage: '', signalPlacement: 'step' });
  const run = await f.verify();
  const envelope = json(run);
  assert.equal(run.code, 5, 'exit codes follow the outcome, not the decision');
  assert.equal(run.code, exitCodeFor(envelope.operationStatus, envelope.decision, envelope.outcome), 'the CLI exit code is the frozen table');
  assert.equal(envelope.decision, 'REPAIR_IMPLEMENTATION');
  assert.equal(envelope.outcome, 'INCONCLUSIVE');
  assert.equal(migrationReport(envelope).status, 'INCONCLUSIVE');
  assert.ok(migrationReport(envelope).diagnostics.some(item => item.code === 'EXECUTION_INCOMPLETE'
    && item.detailCode === 'STEP_FAILED' && item.side === 'target'));
});
