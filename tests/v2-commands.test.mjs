import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { migrationSessionPath, startMigrationSession } from '../packages/engine/dist/migration-session.js';
import { ArtifactStore } from '../packages/engine/dist/index.js';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// CLI v2 (PLAN-V2 §3): the six commands are the whole CLI surface — they map onto existing engine
// operations and answer with one envelope whose {operationStatus, decision, outcome} trio — and
// therefore whose exit code — must come from the frozen table in tests/v2-envelope.test.mjs. The
// compatibility commands were retired by the kill switch: a retired name is an unknown command and
// `nextActions` can never recommend one.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

// The two tests that reach a full preflight PASS (doctor exit 0, prepare READY) probe Chromium
// first (measured 2026-10-03: without a browser both stop at `BROWSER_UNAVAILABLE` / exit 5;
// the other seven — refusals, replay, init, status, text mode — stay green). Per-test guard.
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
const json = result => JSON.parse(result.stdout);

/** Standard-profile config for a different source/target pair: its session identity does not exist. */
const bareConfig = (config, id) => ({ ...config, migrationId: id,
  source: { ...config.source, root: `${config.source.root}-bare` },
  target: { ...config.target, root: `${config.target.root}-bare` } });

/** Standard-profile workspace with a started session, without running any capture. */
async function syntheticSession(t) {
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { config, workspaceRoot: root };
  const reference = await collectMigrationReference({ ...input,
    sourceObservations: { status: 'STABLE', runs: 2, executionHashes: [digest('source'), digest('source')] } });
  const baseline = await runProjectChecks({ ...input, phase: 'baseline', allowProjectCommands: true });
  const preparation = { kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS', reference,
    referenceHash: migrationReferenceHash(reference), artifactPath: 'artifacts/prepared', keyId: digest('dummy'),
    sourceEvidence: [], baseline,
    sourceBuild: { kind: 'SERVED_BUILD', version: '1', side: 'source', runId: randomUUID(), origin: config.source.baseUrl,
      configurationHash: migrationConfigHash(config), inputHash: digest('input'), buildHash: digest('build'), fileCount: 1, totalBytes: 1 } };
  await startMigrationSession({ ...input, preparation });
  await write(root, 'migration.json', JSON.stringify(config));
  return { root, config, sessionPath: migrationSessionPath(config) };
}

test('init writes a schema-valid minimal config, points at the missing decisions and overwrites nothing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'v2-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'migration.json');

  const created = await run(['init', '--out', out, '--json']);
  assert.equal(created.code, 0, created.stderr);
  const envelope = json(created);
  assert.equal(envelope.schemaVersion, '1');
  assert.equal(envelope.operation, 'init');
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal('decision' in envelope, false, 'init evaluates nothing');
  assert.equal('outcome' in envelope, false);
  assert.deepEqual(envelope.diagnostics, []);
  assert.equal(envelope.report.kind, 'MIGRATION_CONFIG_INIT');
  assert.ok(envelope.report.missingDecisions.length >= 10);
  for (const item of envelope.report.missingDecisions) {
    assert.match(item.fieldPath, /^[A-Za-z]+(\.[A-Za-z]+)*$/);
    assert.equal(typeof item.decision, 'string');
  }
  assert.equal(envelope.nextActions.length, 1);
  assert.equal(envelope.nextActions[0].operation, 'doctor');
  assert.equal(envelope.nextActions[0].requiresApproval, 'after_correction');
  assert.equal(envelope.nextActions[0].preconditions[0], 'MISSING_DECISIONS_RESOLVED');

  // The written document is schema-valid (the doctor below parses it) and authorizes nothing.
  const written = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(written.kind, 'MIGRATION_CONFIG');
  assert.equal(written.profile, 'standard');
  assert.doesNotMatch(JSON.stringify(written), /allow-project-commands|allowInsecure/, 'init authorizes nothing');

  const again = await run(['init', '--out', out, '--json']);
  assert.equal(again.code, 1, 'init never overwrites an existing configuration');
  assert.equal(json(again).operationStatus, 'refused');
  assert.equal(json(again).diagnostics[0].code, 'OUTPUT_EXISTS');
  assert.equal(json(again).nextActions[0].operation, 'doctor');

  // doctor reads the skeleton: without the workspace it can only answer "not ready" (exit 5), never PASS.
  const checked = await run(['doctor', '--config', out, '--workspace-root', root, '--json']);
  assert.equal(checked.code, 5, 'an unfinished workspace is INCONCLUSIVE, not a failure of the operation');
  const preflight = json(checked);
  assert.equal(preflight.operationStatus, 'processed');
  assert.equal(preflight.outcome, 'INCONCLUSIVE');
  assert.equal(preflight.report.kind, 'MIGRATION_PREFLIGHT');
  assert.ok(preflight.diagnostics.length > 0);
  assert.ok(preflight.diagnostics.every(item => typeof item.code === 'string' && item.action && item.category));
  assert.equal(preflight.nextActions[0].requiresApproval, 'after_correction');

  const help = await run(['init', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^init /);
  const index = json(await run(['help', '--json']));
  for (const command of ['init', 'doctor', 'prepare', 'verify', 'status', 'reference']) {
    assert.ok(index.commands.some(item => item.command === command), `${command} is listed`);
  }
});

test('doctor reports environment readiness as an outcome and its recommendations carry explicit approval', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await buildWorkspace();
  config.profile = 'standard'; // A1: without profile standard doctor reports a profile FINDING, not an empty diagnostic list
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'migration.json');
  await write(root, 'migration.json', JSON.stringify(config));

  const ready = await run(['doctor', '--config', configPath, '--workspace-root', root, '--json']);
  assert.equal(ready.code, 0, ready.stderr);
  const envelope = json(ready);
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.outcome, 'PASS');
  assert.equal('decision' in envelope, false, 'doctor opens no session and decides nothing');
  assert.equal('sessionId' in envelope, false);
  assert.equal(envelope.report.kind, 'MIGRATION_PREFLIGHT');
  assert.deepEqual(envelope.diagnostics, []);
  assert.equal(envelope.nextActions.length, 1);
  assert.equal(envelope.nextActions[0].operation, 'prepare');
  assert.equal(envelope.nextActions[0].requiresApproval, 'requires_authorization');
  assert.equal(envelope.nextActions[0].args['--allow-project-commands'], true);
  assert.ok(envelope.nextActions[0].preconditions.includes('ENVIRONMENT_READY'));

  const unknownFlag = await run(['doctor', '--config', configPath, '--workspace-root', root, '--drop-tables', '--json']);
  assert.equal(unknownFlag.code, 1);
  assert.equal(json(unknownFlag).operationStatus, 'refused');
  assert.equal(json(unknownFlag).diagnostics[0].code, 'UNKNOWN_OPTION');

  const incomplete = { ...config };
  delete incomplete.scenarios;
  await write(root, 'broken.json', JSON.stringify(incomplete));
  const invalid = await run(['doctor', '--config', join(root, 'broken.json'), '--workspace-root', root, '--json']);
  assert.equal(invalid.code, 1);
  const refusal = json(invalid);
  assert.equal(refusal.operationStatus, 'refused');
  assert.equal(refusal.diagnostics[0].code, 'INVALID_INPUT');
  assert.equal(refusal.diagnostics[0].fieldPath, 'scenarios', 'the refusal names the offending field, never a payload');
});

test('status reports disposition, budget and blocks without ever spending an attempt', async t => {
  const { root, config, sessionPath } = await syntheticSession(t);
  const args = ['status', '--config', join(root, 'migration.json'), '--workspace-root', root, '--json'];

  const healthy = await run(args);
  assert.equal(healthy.code, 0, healthy.stderr);
  const envelope = json(healthy);
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.decision, 'READY');
  assert.equal('outcome' in envelope, false, 'reading state is not an evaluation');
  assert.equal(envelope.sessionId, sessionPath);
  assert.equal(envelope.report.kind, 'MIGRATION_SESSION_STATUS');
  assert.equal(envelope.report.attemptsUsed, 0);
  assert.equal(envelope.report.attemptsRemaining, 4);
  assert.equal(envelope.nextActions[0].operation, 'verify');
  assert.equal(envelope.nextActions[0].requiresApproval, 'requires_authorization');

  // An edit outside the authorized scope: the session is refused, still without consuming an attempt.
  await write(root, 'target/user.txt', 'unrelated destination work');
  const refused = await run(args);
  assert.equal(refused.code, 3, 'a session refusal outranks the successful status read');
  const blocked = json(refused);
  assert.equal(blocked.operationStatus, 'processed');
  assert.equal(blocked.decision, 'REFUSED_SCOPE');
  assert.equal(blocked.report.attemptsUsed, 0);
  assert.ok(blocked.report.findings.some(finding => finding.code === 'OUTSIDE_WRITE_SCOPE'));
  assert.equal(blocked.nextActions[0].preconditions[0], 'SCOPE_RECONCILED');
  assert.equal(await readFile(join(root, 'target/user.txt'), 'utf8'), 'unrelated destination work', 'user work is preserved');

  // No session yet: a structured refusal that points at prepare instead of inventing state.
  await writeFile(join(root, 'other.json'), JSON.stringify(bareConfig(config, 'no-session-yet')));
  const missing = await run(['status', '--config', join(root, 'other.json'), '--workspace-root', root, '--json']);
  assert.equal(missing.code, 1);
  assert.equal(json(missing).diagnostics[0].code, 'STANDARD_SESSION_REQUIRED');
  assert.equal(json(missing).nextActions[0].operation, 'prepare');
});

test('verify refuses before spending an attempt when the session or the authorization is missing', async t => {
  const { root, config, sessionPath } = await syntheticSession(t);
  const configPath = join(root, 'migration.json');

  const noAuth = await run(['verify', '--config', configPath, '--workspace-root', root, '--json']);
  assert.equal(noAuth.code, 1);
  const unauthorized = json(noAuth);
  assert.equal(unauthorized.operationStatus, 'refused');
  assert.equal(unauthorized.sessionId, sessionPath);
  assert.equal(unauthorized.diagnostics[0].code, 'EXECUTION_NOT_AUTHORIZED');
  assert.equal(unauthorized.nextActions[0].operation, 'verify');
  assert.equal(unauthorized.nextActions[0].args['--allow-project-commands'], true);
  assert.equal(unauthorized.nextActions[0].requiresApproval, 'requires_authorization');
  assert.equal(json(await run(['status', '--config', configPath, '--workspace-root', root, '--json'])).report.attemptsUsed, 0,
    'a refused verification consumes no attempt');

  // A standard config without a session points at prepare; the reference command agrees.
  await writeFile(join(root, 'bare.json'), JSON.stringify(bareConfig(config, 'needs-prepare')));
  for (const command of ['verify', 'reference']) {
    const args = [command, '--config', join(root, 'bare.json'), '--workspace-root', root,
      ...(command === 'reference' ? ['--artifact-path', 'artifacts/re-reference'] : []), '--allow-project-commands', '--json'];
    const missing = await run(args);
    assert.equal(missing.code, 1, command);
    const refusal = json(missing);
    assert.equal(refusal.operationStatus, 'refused', command);
    assert.equal(refusal.diagnostics[0].code, 'STANDARD_SESSION_REQUIRED', command);
    assert.equal(refusal.nextActions[0].operation, 'prepare', command);
  }

  const noAuthReference = await run(['reference', '--config', configPath, '--workspace-root', root,
    '--artifact-path', 'artifacts/re-reference', '--json']);
  assert.equal(noAuthReference.code, 1);
  assert.equal(json(noAuthReference).diagnostics[0].code, 'EXECUTION_NOT_AUTHORIZED');
  assert.equal(json(noAuthReference).nextActions[0].operation, 'reference');
});

test('a workspace outside the authorized scope refuses verify with exit 3 and no attempt spent', async t => {
  const { root, config } = await syntheticSession(t);
  await write(root, 'target/user.txt', 'unrelated destination work');
  const result = await run(['verify', '--config', join(root, 'migration.json'), '--workspace-root', root,
    '--allow-project-commands', '--json']);
  assert.equal(result.code, 3, 'session refusal maps to exit 3');
  const envelope = json(result);
  assert.equal(envelope.operationStatus, 'refused', 'no attempt ran');
  assert.equal(envelope.decision, 'REFUSED_SCOPE');
  assert.equal('outcome' in envelope, false, 'a refusal never invents an evaluation');
  assert.equal(envelope.report.attemptsUsed, 0);
  assert.ok(envelope.report.findings.some(finding => finding.code === 'OUTSIDE_WRITE_SCOPE'));
  assert.equal(envelope.nextActions[0].operation, 'verify');
  assert.equal(envelope.nextActions[0].requiresApproval, 'requires_authorization');
});

test('an occupied artifact path is a structured replay conflict, never a silent reuse', async t => {
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'migration.json', JSON.stringify(config));
  const args = ['prepare', '--config', join(root, 'migration.json'), '--workspace-root', root,
    '--artifact-path', 'artifacts/prepared', '--allow-project-commands', '--json'];
  const configurationHash = migrationConfigHash(config);
  const sessionPath = migrationSessionPath(config);
  await mkdir(join(root, 'artifacts/prepared'), { recursive: true });

  // Same request, interrupted before its preparation existed: nothing was concluded, nothing may be reused.
  await write(root, 'artifacts/prepared/started.json',
    JSON.stringify({ kind: 'MIGRATION_OPERATION_STARTED', configurationHash, completed: false }));
  const interrupted = await run(args);
  assert.equal(interrupted.code, 1, 'ARTIFACT_NOT_FRESH is a structured refusal, exit 1');
  const envelope = json(interrupted);
  assert.equal(envelope.operationStatus, 'refused');
  assert.equal(envelope.diagnostics[0].code, 'ARTIFACT_NOT_FRESH');
  assert.equal(envelope.diagnostics[0].fieldPath, '--artifact-path');
  assert.match(envelope.diagnostics[0].cause, /interrupted/);
  assert.equal(envelope.requestKey.length, 64);
  assert.equal(envelope.replayOf, envelope.requestKey, 'the envelope names the recorded request it collides with');
  assert.equal(envelope.nextActions[0].operation, 'prepare');
  assert.equal(envelope.nextActions[0].args['--artifact-path'], 'artifacts/prepared-retry', 'nextActions propose a fresh path');
  assert.equal(envelope.nextActions[0].preconditions[0], 'FRESH_ARTIFACT_PATH');

  // The refusal created no session and consumed no attempt: replay detection happens before any work.
  assert.equal(await readFile(join(root, 'migration.json'), 'utf8'), JSON.stringify(config));
  const status = await run(['status', '--config', join(root, 'migration.json'), '--workspace-root', root, '--json']);
  assert.equal(status.code, 1);
  assert.equal(json(status).diagnostics[0].code, 'STANDARD_SESSION_REQUIRED', 'no session was started by the replay');

  // A completed record of this same request is reported as a replay too, without re-running it.
  await write(root, 'artifacts/prepared/preparation.json', JSON.stringify({ kind: 'MIGRATION_PREPARATION' }));
  const replay = await run(args);
  assert.equal(replay.code, 1);
  const replayed = json(replay);
  assert.match(replayed.diagnostics[0].cause, /recorded result/);
  assert.equal(replayed.replayOf, replayed.requestKey);
  assert.notEqual(replayed.runId, envelope.runId, 'each envelope names its own run');

  // Same path, different configuration: a structured conflict, not a replay.
  await write(root, 'artifacts/prepared/started.json',
    JSON.stringify({ kind: 'MIGRATION_OPERATION_STARTED', configurationHash: digest('other-config'), completed: false }));
  const conflict = await run(args);
  assert.equal(conflict.code, 1);
  const conflicted = json(conflict);
  assert.match(conflicted.diagnostics[0].cause, /different configuration/);
  assert.equal('replayOf' in conflicted, false, 'a foreign occupant is never claimed as this request');
  assert.equal(conflicted.requestKey, envelope.requestKey, 'the request key is deterministic across invocations');
});

test('a completed migration flows through the envelope end to end', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  config.limits = { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 600_000 };
  config.policy = { sanitization: { allowedStorageKeys: ['ready'] } };
  const completionSignal = { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'ready', timeoutMs: 2500 };
  config.scenarios[0].definition.completionSignal = completionSignal;
  config.scenarios[0].definition.steps = [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }];
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionPath = migrationSessionPath(config);
  // Private raw/capture domains live outside the workspace: clean every store root this flow touches.
  const cleanPrivate = () => Promise.all(['artifacts/prepared', 'artifacts/prepared/capture', 'artifacts/re-reference',
    ...['runs/0000', 'runs/0000/capture'].map(suffix => `${sessionPath}/${suffix}`)]
    .map(path => rm(new ArtifactStore(join(root, path)).privateRoot, { recursive: true, force: true })));
  t.after(cleanPrivate);
  const app = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>{document.querySelector("output").textContent="Saved";localStorage.setItem("ready","yes");};');
writeFileSync('dist/app.js.map', '{}');`;
  await write(root, 'source/build.mjs', app);
  await write(root, 'target/build.mjs', app);
  await write(root, 'migration.json', JSON.stringify(config));
  const args = ['--config', join(root, 'migration.json'), '--workspace-root', root];

  const prepared = await run(['prepare', ...args, '--artifact-path', 'artifacts/prepared', '--allow-project-commands', '--json']);
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const preparation = json(prepared);
  assert.equal(preparation.operationStatus, 'processed');
  assert.equal(preparation.decision, 'READY', 'prepare opens the resumable session (no separate start)');
  assert.equal(preparation.outcome, 'PASS');
  assert.match(preparation.sessionId, /^artifacts\/sessions\/[0-9a-f]{32}$/);
  assert.equal(preparation.report.kind, 'MIGRATION_PREPARATION');
  assert.equal(preparation.requestKey.length, 64);
  assert.deepEqual(preparation.nextActions.map(item => item.operation), ['status', 'verify']);

  const status = await run(['status', ...args, '--json']);
  assert.equal(status.code, 0);
  assert.equal(json(status).decision, 'READY');
  assert.equal(json(status).report.attemptsUsed, 0);

  const verified = await run(['verify', ...args, '--allow-project-commands', '--json']);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const envelope = json(verified);
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.decision, 'COMPLETE');
  assert.equal(envelope.outcome, 'PASS');
  assert.equal(envelope.report.kind, 'MIGRATION_SESSION_RESULT');
  assert.equal(envelope.report.attemptsUsed, 1);
  assert.deepEqual(envelope.nextActions, [], 'a completed session recommends nothing');

  const final = await run(['status', ...args, '--json']);
  assert.equal(final.code, 0);
  assert.equal(json(final).decision, 'COMPLETE');
  assert.equal(json(final).report.lastReportMatchesWorkspace, true);
  assert.deepEqual(json(final).nextActions, [], 'the recorded PASS still matches the workspace');

  // A binding adaptation is a controlled reference update: same session, budgets and history kept.
  const adapted = JSON.parse(JSON.stringify(config));
  adapted.scenarios[0].bindings.target.steps = [{ stepId: 'save', targetRole: 'button', targetName: 'Gravar' }];
  await writeFile(join(root, 'migration.json'), JSON.stringify(adapted));
  const reference = await run(['reference', ...args, '--artifact-path', 'artifacts/re-reference',
    '--allow-project-commands', '--json']);
  assert.equal(reference.code, 0, reference.stdout + reference.stderr);
  const updated = json(reference);
  assert.equal(updated.operationStatus, 'processed');
  assert.equal(updated.decision, 'READY', 'the session is ready for the next verification');
  assert.equal('outcome' in updated, false, 'a reference update is not a behavioral evaluation');
  assert.equal(updated.sessionId, preparation.sessionId, 'session identity is preserved');
  assert.equal(updated.report.kind, 'MIGRATION_SESSION_REFERENCE_UPDATED');
  assert.equal(updated.report.classification, 'BINDING_ADAPTATION', 'the change is classified, not just accepted');
  assert.equal(updated.report.generation, 1);
  assert.equal(updated.report.attemptsUsed, 1, 'attempt history and budgets are untouched by the update');
  assert.equal(updated.report.attemptsRemaining, 3);

  // The PASS from the superseded generation never presents as current: status says COMPLETE but the
  // report no longer matches the workspace, so the next action is a fresh verification.
  const afterUpdate = await run(['status', ...args, '--json']);
  assert.equal(afterUpdate.code, 0);
  const stale = json(afterUpdate);
  assert.equal(stale.decision, 'COMPLETE');
  assert.equal(stale.report.lastReportMatchesWorkspace, false, 'an old PASS is never the current result');
  assert.equal(stale.nextActions[0].operation, 'verify');
  assert.equal(stale.nextActions[0].requiresApproval, 'requires_authorization');
});

test('outside profile standard the v2 flow refuses with exit 1 and recommends nothing', async t => {
  // The old handover pointed at `prepare-migration`/`update-migration-session`; those commands are
  // retired, so the refusal is terminal: it explains itself and recommends no command at all
  // (kill switch §8.2 — recusa fora de standard SEM handover para o legado).
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'migration.json', JSON.stringify(config)); // no profile: standard
  const base = ['--config', join(root, 'migration.json'), '--workspace-root', root];

  const prepared = await run(['prepare', ...base, '--artifact-path', 'artifacts/prepared', '--allow-project-commands', '--json']);
  assert.equal(prepared.code, 1);
  const refusal = json(prepared);
  assert.equal(refusal.operationStatus, 'refused');
  assert.equal(refusal.diagnostics[0].code, 'STANDARD_PROFILE_REQUIRED');
  assert.deepEqual(refusal.nextActions, [], 'a refusal never hands over to a retired command');

  for (const [command, extra] of [
    ['status', []],
    ['verify', ['--allow-project-commands']],
    ['reference', ['--artifact-path', 'artifacts/re', '--allow-project-commands']],
  ]) {
    const result = await run([command, ...base, ...extra, '--json']);
    assert.equal(result.code, 1, command);
    const envelope = json(result);
    assert.equal(envelope.operationStatus, 'refused', command);
    assert.equal(envelope.diagnostics[0].code, 'STANDARD_PROFILE_REQUIRED', command);
    assert.deepEqual(envelope.nextActions, [], `${command} recommends nothing it can run outside profile standard`);
  }
});

test('text mode prints one human summary on stdout and keeps diagnostics on stderr', async t => {
  const { root } = await syntheticSession(t);
  const ready = await run(['status', '--config', join(root, 'migration.json'), '--workspace-root', root]);
  assert.equal(ready.code, 0);
  assert.match(ready.stdout, /^status: processed \| decision READY \| exit 0/);
  assert.doesNotMatch(ready.stdout.trimStart(), /^\{/, 'text mode never prints JSON');
  assert.equal(ready.stderr, '');

  const missing = await run(['verify', '--config', join(root, 'migration.json'), '--workspace-root', root]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /^verify: refused \| exit 1/);
  assert.match(missing.stderr, /ERROR EXECUTION_NOT_AUTHORIZED/);
});
