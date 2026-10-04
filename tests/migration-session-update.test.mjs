import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference, ReferenceWeakeningError } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { startMigrationSession, inspectMigrationSession, verifyMigrationSession, updateMigrationSessionReference, migrationSessionPath } from '../packages/engine/dist/migration-session.js';
import { prepareMigration } from '../packages/engine/dist/migration-operations.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { timeout: 180_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
const read = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const cleanPrivate = (t, root, dir) => t.after(() => rm(new ArtifactStore(join(root, dir)).privateRoot, { recursive: true, force: true }));

// The two tests that run the real preparation/update gate probe Chromium first (measured
// 2026-10-03: without a browser they stop at `BROWSER_UNAVAILABLE`, the three bookkeeping/CLI
// tests stay green). Per-test guard keeps that bookkeeping coverage running everywhere.
let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }
const withoutChromium = t => {
  if (!chromiumIssue) return false;
  t.skip(`Chromium unavailable: ${chromiumIssue}`);
  return true;
};

// Synthetic observation declarations exercise session bookkeeping only; update itself always runs the real prepareMigration.
async function syntheticFixture(t, { requirement = false } = {}) {
  const { root, config } = await buildWorkspace(); config.profile = 'standard';
  if (requirement) config.requirements = [{ id: 'boot-shell', scenarioId: 'boot', description: 'Fixture output stays present',
    origin: 'EXISTING_TEST', sourceReference: 'fixture', required: true }];
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { config, workspaceRoot: root };
  const reference = await collectMigrationReference({ ...input,
    sourceObservations: { status: 'STABLE', runs: 2, executionHashes: [digest('source'), digest('source')] } });
  const baseline = await runProjectChecks({ ...input, phase: 'baseline', allowProjectCommands: true });
  const preparation = { kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS', reference,
    referenceHash: migrationReferenceHash(reference), artifactPath: 'artifacts/prepared', keyId: digest('dummy'), sourceEvidence: [], baseline,
    sourceBuild: { kind: 'SERVED_BUILD', version: '1', side: 'source', runId: randomUUID(), origin: config.source.baseUrl,
      configurationHash: migrationConfigHash(config), inputHash: digest('input'), buildHash: digest('build'), fileCount: 1, totalBytes: 1 } };
  const sessionPath = migrationSessionPath(config);
  await startMigrationSession({ ...input, preparation });
  return { root, config, input, preparation, sessionPath, generationsPath: join(root, sessionPath, 'generations.json'),
    envelope: async () => read(root, `${sessionPath}/session.json`) };
}

function extendedConfig(config) {
  const next = structuredClone(config);
  const clone = structuredClone(next.scenarios[0]);
  clone.definition.scenarioId = 'repeat';
  next.scenarios.push(clone);
  next.requirements = [...config.requirements, { id: 'repeat-ready', scenarioId: 'repeat', description: 'Clicking Save leaves the confirmation visible',
    origin: 'EXISTING_TEST', sourceReference: 'fixture', required: true,
    assertion: { checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NODE_PRESENT', role: 'status', name: 'Saved' } } }];
  return next;
}

test('reference update refuses open attempts, pair changes and limit edits before executing anything', async t => {
  const f = await syntheticFixture(t);
  await assert.rejects(updateMigrationSessionReference({ ...f.input, artifactPath: 'artifacts/update' }), /EXECUTION_NOT_AUTHORIZED/);
  await assert.rejects(updateMigrationSessionReference({ ...f.input, artifactPath: 'artifacts/update', allowProjectCommands: false }), /EXECUTION_NOT_AUTHORIZED/);
  const envelope = await f.envelope();
  await write(f.root, `${f.sessionPath}/attempts/0000.started.json`, JSON.stringify(
    { index: 0, startedAt: new Date().toISOString(), previousHash: envelope.hash, candidateHash: digest('candidate'), remainingMs: 1000 }));
  await assert.rejects(updateMigrationSessionReference({ ...f.input, artifactPath: 'artifacts/update', allowProjectCommands: true }), /SESSION_ATTEMPT_OPEN/);
  await rm(join(f.root, f.sessionPath, 'attempts', '0000.started.json'));
  await assert.rejects(updateMigrationSessionReference({ ...f.input,
    config: { ...f.config, limits: { ...f.config.limits, maxRepairAttempts: 9 } }, artifactPath: 'artifacts/update', allowProjectCommands: true }), /SESSION_LIMITS_IMMUTABLE/);
  // Different roots resolve to another deterministic directory: fabricate the pair mismatch by relocating the intact session.
  const other = { ...f.config, source: { ...f.config.source, root: 'origins' } };
  await mkdir(join(f.root, migrationSessionPath(other)), { recursive: true });
  await copyFile(join(f.root, f.sessionPath, 'session.json'), join(f.root, migrationSessionPath(other), 'session.json'));
  await assert.rejects(updateMigrationSessionReference({ ...f.input, config: other, artifactPath: 'artifacts/update', allowProjectCommands: true }), /SESSION_PAIR_CHANGED/);
  assert.equal(await readFile(f.generationsPath).catch(() => 'missing'), 'missing');
  assert.equal((await f.envelope()).hash, envelope.hash, 'session.json is never rewritten');
});

test('update classifies reference changes through the real preparation gate: weakening needs an owner decision, an owner decision needs weakening', async t => {
  if (withoutChromium(t)) return;
  const f = await syntheticFixture(t, { requirement: true });
  await assert.rejects(updateMigrationSessionReference({ ...f.input, config: { ...f.config, requirements: [] },
    artifactPath: 'artifacts/update-weakened', allowProjectCommands: true }),
  error => error instanceof ReferenceWeakeningError && /would weaken evaluation criteria/.test(error.message));
  await assert.rejects(updateMigrationSessionReference({ ...f.input, config: extendedConfig(f.config),
    artifactPath: 'artifacts/update-extension', ownerDecisionReference: 'owner-1', allowProjectCommands: true }),
  /Only a weakened reference version records an owner decision/);
  assert.equal(await readFile(f.generationsPath).catch(() => 'missing'), 'missing', 'refused updates append nothing');
  await write(f.root, 'weakened.json', JSON.stringify({ ...f.config, requirements: [] }));
  const refused = await run(['reference', '--config', join(f.root, 'weakened.json'), '--workspace-root', f.root,
    '--artifact-path', 'artifacts/update-cli', '--allow-project-commands', '--json']);
  assert.equal(refused.code, 1, `a weakening is a structured refusal: ${refused.stderr}`);
  const envelope = JSON.parse(refused.stdout);
  assert.equal(envelope.operationStatus, 'refused');
  assert.equal(envelope.diagnostics[0].code, 'REFERENCE_CHANGE_REQUIRES_OWNER_DECISION');
  assert.equal('owner-decision' in (envelope.nextActions[0]?.args ?? {}), false,
    'a recommendation never pre-fills an approval the harness does not have');
  assert.equal(envelope.nextActions[0].requiresApproval, 'requires_authorization');
});

test('generations chain is validated on every load; corruption throws and deletion falls back to generation zero', async t => {
  const f = await syntheticFixture(t);
  const session = (await f.envelope()).session;
  const entry = { index: 1, createdAt: new Date().toISOString(), configurationHash: migrationConfigHash(session.config),
    referenceHash: migrationReferenceHash(f.preparation.reference), scopeHash: digest(session.scope),
    previousHash: digest(session), config: session.config, preparation: f.preparation, scope: session.scope };
  const store = async entries => write(f.root, `${f.sessionPath}/generations.json`,
    JSON.stringify({ kind: 'MIGRATION_SESSION_GENERATIONS', version: '1', sessionHash: digest(session), entries }));
  await store([entry]);
  const status = await inspectMigrationSession(f.input);
  assert.equal(status.generation, 1); assert.equal(status.attemptsUsed, 0); assert.equal(status.lastReportMatchesWorkspace, false);
  await store([{ ...entry, configurationHash: digest('tampered') }]);
  await assert.rejects(inspectMigrationSession(f.input), /SESSION_GENERATIONS_INVALID/);
  await assert.rejects(verifyMigrationSession({ ...f.input, allowProjectCommands: true }), /SESSION_GENERATIONS_INVALID/);
  await store([{ ...entry, previousHash: digest('broken-chain') }]);
  await assert.rejects(inspectMigrationSession(f.input), /SESSION_GENERATIONS_INVALID/);
  await write(f.root, `${f.sessionPath}/generations.json`, 'not json');
  await assert.rejects(inspectMigrationSession(f.input), SyntaxError);
  await rm(f.generationsPath);
  const fallback = await inspectMigrationSession(f.input);
  assert.equal(fallback.generation, 0); assert.equal(fallback.referenceStatus, 'VERIFIED', 'without entries the original session reference is active again');
});

test('v2 reference accepts its flags and rejects the retired interface', async () => {
  const help = await run(['reference', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^reference --config <migration\.json> --workspace-root <dir> --artifact-path <new-relative-dir> \[--owner-decision <reference>\]/);
  assert.match(help.stdout, /--allow-project-commands/);
  // The retired sessionless reference interface is not a flag of this command any more.
  for (const extra of [['--preparation', 'x.json'], ['--previous', 'x.json'], ['--preflight-only']]) {
    const rejected = await run(['reference', ...extra, '--workspace-root', '.', '--config', 'x', '--artifact-path', 'y', '--json']);
    assert.equal(rejected.code, 1, extra.join(' '));
    assert.equal(JSON.parse(rejected.stdout).diagnostics[0].code, 'UNKNOWN_OPTION', extra.join(' '));
  }
  // --owner-decision is session-legal on its own; the missing-flag error names the first absent
  // required flag, which proves the option itself passed validation.
  const missing = await run(['reference', '--owner-decision', 'ref', '--json']);
  assert.equal(missing.code, 1);
  const refusal = JSON.parse(missing.stdout);
  assert.equal(refusal.diagnostics[0].code, 'MISSING_FLAG');
  assert.equal(refusal.diagnostics[0].fieldPath, '--config');
});

test('session reference update preserves identity, attempts and budgets across coverage, binding and owner-approved changes', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await buildWorkspace();
  config.profile = 'standard'; config.limits = { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 600000 };
  const script = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Session fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>{document.querySelector("output").textContent="Saved";localStorage.setItem("ready","yes");};');`;
  for (const side of ['source', 'target']) await write(root, `${side}/build.mjs`, script);
  config.scenarios[0].definition.steps = [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save',
    completionSignal: { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'ready', timeoutMs: 2500 } }];
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { config, workspaceRoot: root }, sessionPath = migrationSessionPath(config);
  for (const dir of ['artifacts/prepared-real', 'artifacts/update-1', 'artifacts/update-2', 'artifacts/update-3']) cleanPrivate(t, root, dir);
  const preparation = await prepareMigration({ ...input, artifactPath: 'artifacts/prepared-real', allowProjectCommands: true });
  assert.equal(preparation.kind, 'MIGRATION_PREPARATION'); assert.equal(preparation.status, 'PASS');
  await startMigrationSession({ ...input, preparation });
  const clean = await verifyMigrationSession({ ...input, allowProjectCommands: true });
  assert.equal(clean.decision, 'COMPLETE');
  let status = await inspectMigrationSession(input);
  assert.equal(status.generation, 0); assert.equal(status.lastReportMatchesWorkspace, true);
  const before = { attemptsUsed: status.attemptsUsed, attemptsRemaining: status.attemptsRemaining };
  await assert.rejects(updateMigrationSessionReference({ ...input, config: { ...config, policy: { sanitization: { allowedPayloadKeys: ['ready'] } } },
    artifactPath: 'artifacts/update-refused', allowProjectCommands: true }), error => error instanceof ReferenceWeakeningError);
  const config2 = extendedConfig(config);
  const update1 = await updateMigrationSessionReference({ ...input, config: config2, artifactPath: 'artifacts/update-1', allowProjectCommands: true });
  assert.equal(update1.kind, 'MIGRATION_SESSION_REFERENCE_UPDATED'); assert.equal(update1.generation, 1);
  assert.equal(update1.classification, 'EXTENSION'); assert.equal(update1.referenceVersion, 2);
  assert.deepEqual({ attemptsUsed: update1.attemptsUsed, attemptsRemaining: update1.attemptsRemaining }, before, 'budgets are unchanged by an update');
  status = await inspectMigrationSession({ ...input, config: config2 });
  assert.equal(status.generation, 1); assert.equal(status.referenceStatus, 'VERIFIED');
  assert.equal(status.lastReportMatchesWorkspace, false, 'an old-generation PASS must not count as current after an update');
  await assert.rejects(inspectMigrationSession(input), /SESSION_INPUT_MISMATCH/, 'the superseded config is no longer the session config');
  const attempt1 = await verifyMigrationSession({ ...input, config: config2, allowProjectCommands: true });
  assert.ok(attempt1.report, 'the new generation runs the complete verifier');
  assert.equal(attempt1.report.identity.configurationHash, migrationConfigHash(config2));
  status = await inspectMigrationSession({ ...input, config: config2 });
  assert.deepEqual(status.attempts.map(item => item.generation), [0, 1], 'mixed generations validate against their own configuration hashes');
  const config3 = structuredClone(config2);
  config3.scenarios[0].bindings.target.entryUrl = `${config3.target.baseUrl}/adapted`;
  const update2 = await updateMigrationSessionReference({ ...input, config: config3, artifactPath: 'artifacts/update-2', allowProjectCommands: true });
  assert.equal(update2.generation, 2); assert.equal(update2.classification, 'BINDING_ADAPTATION', 'binding adaptation needs no owner decision');
  const config4 = { ...config3, scenarios: [config3.scenarios[0]], requirements: config3.requirements.filter(item => item.scenarioId !== 'repeat') };
  const update3 = await updateMigrationSessionReference({ ...input, config: config4, artifactPath: 'artifacts/update-3',
    ownerDecisionReference: 'owner-decision-1', allowProjectCommands: true });
  assert.equal(update3.generation, 3); assert.equal(update3.classification, 'WEAKENING');
  const envelope = await read(root, `${sessionPath}/session.json`);
  const generations = await read(root, `${sessionPath}/generations.json`);
  assert.equal(generations.kind, 'MIGRATION_SESSION_GENERATIONS'); assert.equal(generations.entries.length, 3);
  assert.equal(generations.entries[0].previousHash, digest(envelope.session));
  assert.equal(generations.entries[1].previousHash, digest(generations.entries[0]));
  assert.equal(generations.entries[2].preparation.reference.referenceVersion, 4);
  assert.equal(generations.entries[2].preparation.reference.change.ownerDecisionReference, 'owner-decision-1');
  assert.equal((await read(root, `${sessionPath}/attempts/0000.started.json`)).generation, 0, 'pre-update attempt records survive untouched');
  status = await inspectMigrationSession({ ...input, config: config4 });
  assert.equal(status.generation, 3); assert.equal(status.attemptsUsed, 2); assert.equal(status.attemptsRemaining, 2);
  assert.equal(status.lastReportMatchesWorkspace, false);
  assert.equal(envelope.hash, (await read(root, `${sessionPath}/session.json`)).hash, 'session.json stays byte-identical through three generations');
});
