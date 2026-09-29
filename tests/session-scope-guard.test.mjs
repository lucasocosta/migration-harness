import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { prepareMigration } from '../packages/engine/dist/migration-operations.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { startMigrationSession, inspectMigrationSession, verifyMigrationSession, updateMigrationSessionReference,
  migrationSessionPath, SessionScopeRefusalError } from '../packages/engine/dist/migration-session.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const read = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const missing = async promise => (await promise.catch(() => 'missing')) === 'missing';
const cleanPrivate = (t, root, dir) => t.after(() => rm(new ArtifactStore(join(root, dir)).privateRoot, { recursive: true, force: true }));

// Synthetic observation declarations exercise session bookkeeping only; scope guards run before any preparation.
async function scopeFixture(t, setup) {
  const { root, config } = await buildWorkspace(); config.profile = 'standard';
  if (setup) await setup(root, config);
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
  return { root, config, input, sessionPath };
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

test('an out-of-scope target edit refuses the reference update before execution and stays reported by verification', async t => {
  const f = await scopeFixture(t);
  await write(f.root, 'target/user.txt', 'unrelated destination work');
  const config2 = extendedConfig(f.config);
  const classified = error => error instanceof SessionScopeRefusalError
    && error.findings.some(finding => finding.side === 'target' && finding.path === 'user.txt'
      && finding.code === 'OUTSIDE_WRITE_SCOPE' && finding.change === 'ADDED');
  await assert.rejects(updateMigrationSessionReference({ ...f.input, config: config2, artifactPath: 'artifacts/update-guarded',
    allowProjectCommands: true }),
  error => classified(error) && error.code === 'SESSION_REFERENCE_UPDATE_OUT_OF_SCOPE');
  // The expansion opt-in only covers deltas the replacement configuration itself declares writable.
  await assert.rejects(updateMigrationSessionReference({ ...f.input, config: config2, artifactPath: 'artifacts/update-guarded',
    allowProjectCommands: true, allowScopeExpansion: true }),
  error => classified(error) && error.code === 'SESSION_SCOPE_EXPANSION_NOT_AUTHORIZED');
  assert.ok(await missing(readFile(join(f.root, `${f.sessionPath}/generations.json`))), 'refused updates append no generation');
  assert.ok(await missing(readFile(join(f.root, 'artifacts/update-guarded/started.json'))), 'the refusal happens before preparation executes');
  const status = await inspectMigrationSession(f.input);
  assert.equal(status.generation, 0); assert.equal(status.scope, 'REFUSED'); assert.equal(status.attemptsUsed, 0);
  assert.ok(status.findings.some(finding => finding.path === 'user.txt' && finding.code === 'OUTSIDE_WRITE_SCOPE'),
    'the edit was never adopted as baseline');
  const verification = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(verification.decision, 'REFUSED_SCOPE'); assert.equal(verification.attemptsUsed, 0);
  assert.ok(!verification.report, 'a scope refusal never fabricates a report');
  assert.ok(verification.findings.some(finding => finding.path === 'user.txt' && finding.code === 'OUTSIDE_WRITE_SCOPE'),
    'subsequent verification still reports the out-of-scope edit');
});

test('protected destination work refuses a reference update with or without scope expansion', async t => {
  const f = await scopeFixture(t, async (root, config) => {
    config.target.protectedPaths = ['config.json'];
    await write(root, 'target/config.json', JSON.stringify({ owner: 'protected' }));
  });
  await write(f.root, 'target/config.json', JSON.stringify({ owner: 'edited' }));
  const config2 = extendedConfig(f.config);
  for (const allowScopeExpansion of [false, true]) {
    await assert.rejects(updateMigrationSessionReference({ ...f.input, config: config2, artifactPath: 'artifacts/update-protected',
      allowProjectCommands: true, allowScopeExpansion }),
    error => error instanceof SessionScopeRefusalError
      && error.code === (allowScopeExpansion ? 'SESSION_SCOPE_EXPANSION_NOT_AUTHORIZED' : 'SESSION_REFERENCE_UPDATE_OUT_OF_SCOPE')
      && error.findings.some(finding => finding.side === 'target' && finding.path === 'config.json'
        && finding.code === 'OUTSIDE_WRITE_SCOPE' && finding.change === 'MODIFIED'));
  }
  assert.ok(await missing(readFile(join(f.root, `${f.sessionPath}/generations.json`))), 'refused updates append no generation');
  const status = await inspectMigrationSession(f.input);
  assert.equal(status.generation, 0); assert.equal(status.scope, 'REFUSED');
  assert.ok(status.findings.some(finding => finding.path === 'config.json' && finding.code === 'OUTSIDE_WRITE_SCOPE'));
  assert.equal(await readFile(join(f.root, 'target/config.json'), 'utf8'), JSON.stringify({ owner: 'edited' }), 'user work is never reverted');
});

test('a declared scope expansion and coverage update adopt the new scope while attempts and budgets persist', async t => {
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
  for (const dir of ['artifacts/prepared-guard', 'artifacts/update-declared']) cleanPrivate(t, root, dir);
  const preparation = await prepareMigration({ ...input, artifactPath: 'artifacts/prepared-guard', allowProjectCommands: true });
  assert.equal(preparation.kind, 'MIGRATION_PREPARATION'); assert.equal(preparation.status, 'PASS');
  await startMigrationSession({ ...input, preparation });
  // A reserved, finished attempt keeps the preserved budgets non-trivial.
  const envelope = await read(root, `${sessionPath}/session.json`);
  const start = { index: 0, startedAt: new Date().toISOString(), previousHash: envelope.hash,
    candidateHash: digest('candidate'), remainingMs: config.limits.maxDurationMs };
  await write(root, `${sessionPath}/attempts/0000.started.json`, JSON.stringify(start));
  const finish = { index: 0, startHash: digest(start), finishedAt: new Date().toISOString(), durationMs: 1234,
    outcome: 'INCONCLUSIVE', fingerprint: digest('synthetic-attempt'), candidateHash: start.candidateHash,
    findings: [], errorCode: 'SYNTHETIC_FAILURE' };
  await write(root, `${sessionPath}/attempts/0000.finished.json`, JSON.stringify(finish));
  // A writable area the current generation never declared: adopting its bytes needs the explicit opt-in.
  await write(root, 'target/extra.ts', 'export const extra = 1;\n');
  const config2 = extendedConfig(config);
  config2.target.writePaths = [...config.target.writePaths, 'extra.ts'];
  await assert.rejects(updateMigrationSessionReference({ ...input, config: config2, artifactPath: 'artifacts/update-declared',
    allowProjectCommands: true }),
  error => error instanceof SessionScopeRefusalError && error.code === 'SESSION_REFERENCE_UPDATE_OUT_OF_SCOPE'
    && error.findings.some(finding => finding.path === 'extra.ts' && finding.code === 'OUTSIDE_WRITE_SCOPE' && finding.change === 'ADDED'));
  const update = await updateMigrationSessionReference({ ...input, config: config2, artifactPath: 'artifacts/update-declared',
    allowProjectCommands: true, allowScopeExpansion: true });
  assert.equal(update.kind, 'MIGRATION_SESSION_REFERENCE_UPDATED');
  assert.equal(update.generation, 1); assert.equal(update.classification, 'EXTENSION'); assert.equal(update.referenceVersion, 2);
  assert.deepEqual({ attemptsUsed: update.attemptsUsed, attemptsRemaining: update.attemptsRemaining,
    usedMs: update.usedMs, remainingMs: update.remainingMs },
  { attemptsUsed: 1, attemptsRemaining: 3, usedMs: 1234, remainingMs: config.limits.maxDurationMs - 1234 });
  const generations = await read(root, `${sessionPath}/generations.json`);
  assert.equal(generations.entries.length, 1);
  assert.equal(generations.entries[0].previousHash, digest(envelope.session));
  assert.equal(generations.entries[0].scopeHash, digest(generations.entries[0].scope));
  const status = await inspectMigrationSession({ ...input, config: config2 });
  assert.equal(status.generation, 1); assert.equal(status.scope, 'PASS', 'the declared expansion moved into the new baseline');
  assert.equal(status.referenceStatus, 'VERIFIED');
  assert.equal(status.attemptsUsed, 1); assert.equal(status.attemptsRemaining, 3); assert.equal(status.usedMs, 1234);
  assert.equal((await read(root, `${sessionPath}/session.json`)).hash, envelope.hash, 'session.json stays byte-identical');
  assert.equal((await read(root, `${sessionPath}/attempts/0000.started.json`)).index, 0, 'attempt history survives untouched');
});

test('a writePaths expansion on a byte-identical workspace is refused until the opt-in, and only then authorizes edit-second work', async t => {
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
  for (const dir of ['artifacts/prepared-policy', 'artifacts/update-policy']) cleanPrivate(t, root, dir);
  const preparation = await prepareMigration({ ...input, artifactPath: 'artifacts/prepared-policy', allowProjectCommands: true });
  assert.equal(preparation.kind, 'MIGRATION_PREPARATION'); assert.equal(preparation.status, 'PASS');
  await startMigrationSession({ ...input, preparation });
  // Expand-first: no file is touched anywhere, only the writePaths declaration grows.
  const config2 = extendedConfig(config);
  config2.target.writePaths = [...config.target.writePaths, 'extra.ts'];
  await assert.rejects(updateMigrationSessionReference({ ...input, config: config2, artifactPath: 'artifacts/update-policy',
    allowProjectCommands: true }),
  error => error instanceof SessionScopeRefusalError && error.code === 'SESSION_SCOPE_EXPANSION_NOT_AUTHORIZED'
    && error.findings.some(finding => finding.side === 'target' && finding.path === 'extra.ts'
      && finding.code === 'OUTSIDE_WRITE_SCOPE' && finding.change === 'ADDED'));
  assert.equal((await inspectMigrationSession(input)).generation, 0, 'a refused policy delta appends no generation');
  assert.ok(await missing(readFile(join(root, `${sessionPath}/generations.json`))), 'refused updates append no generation');
  assert.ok(await missing(readFile(join(root, 'artifacts/update-policy/started.json'))), 'the refusal happens before preparation executes');
  // The explicit opt-in accepts the declaration delta and the update runs normally.
  const update = await updateMigrationSessionReference({ ...input, config: config2, artifactPath: 'artifacts/update-policy',
    allowProjectCommands: true, allowScopeExpansion: true });
  assert.equal(update.kind, 'MIGRATION_SESSION_REFERENCE_UPDATED');
  assert.equal(update.generation, 1); assert.equal(update.classification, 'EXTENSION'); assert.equal(update.referenceVersion, 2);
  assert.deepEqual({ attemptsUsed: update.attemptsUsed, attemptsRemaining: update.attemptsRemaining,
    usedMs: update.usedMs, remainingMs: update.remainingMs },
  { attemptsUsed: 0, attemptsRemaining: 4, usedMs: 0, remainingMs: config.limits.maxDurationMs });
  // Edit-second: writing into the expanded path is authorized by the new generation...
  await write(root, 'target/extra.ts', 'export const extra = 1;\n');
  let status = await inspectMigrationSession({ ...input, config: config2 });
  assert.equal(status.generation, 1); assert.equal(status.scope, 'PASS', 'the expanded write path is authorized by generation 1');
  // ...while everything still outside the declared scope keeps being refused.
  await write(root, 'target/user.txt', 'still outside the scope');
  status = await inspectMigrationSession({ ...input, config: config2 });
  assert.equal(status.generation, 1); assert.equal(status.scope, 'REFUSED');
  assert.ok(status.findings.some(finding => finding.path === 'user.txt' && finding.code === 'OUTSIDE_WRITE_SCOPE'));
});

test('promoting a relevant but non-writable file into writePaths needs the explicit opt-in', async t => {
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
  for (const dir of ['artifacts/prepared-relevance', 'artifacts/update-relevance']) cleanPrivate(t, root, dir);
  const preparation = await prepareMigration({ ...input, artifactPath: 'artifacts/prepared-relevance', allowProjectCommands: true });
  assert.equal(preparation.kind, 'MIGRATION_PREPARATION'); assert.equal(preparation.status, 'PASS');
  await startMigrationSession({ ...input, preparation });
  // main.ts is inventoried as relevant but never writable: relevance must not authorize writes.
  assert.ok(config.target.relevantFiles.includes('main.ts') && !config.target.writePaths.includes('main.ts'));
  const config2 = extendedConfig(config);
  config2.target.writePaths = [...config.target.writePaths, 'main.ts'];
  // Clean workspace: only the declaration promotes main.ts into the writable set.
  await assert.rejects(updateMigrationSessionReference({ ...input, config: config2, artifactPath: 'artifacts/update-relevance',
    allowProjectCommands: true }),
  error => error instanceof SessionScopeRefusalError && error.code === 'SESSION_SCOPE_EXPANSION_NOT_AUTHORIZED'
    && error.findings.some(finding => finding.side === 'target' && finding.path === 'main.ts'
      && finding.code === 'OUTSIDE_WRITE_SCOPE' && finding.change === 'ADDED'));
  assert.equal((await inspectMigrationSession(input)).generation, 0, 'a refused promotion appends no generation');
  assert.ok(await missing(readFile(join(root, `${sessionPath}/generations.json`))), 'refused updates append no generation');
  assert.ok(await missing(readFile(join(root, 'artifacts/update-relevance/started.json'))), 'the refusal happens before preparation executes');
  // The explicit opt-in accepts the promotion; only then is the later edit authorized by generation 1.
  const update = await updateMigrationSessionReference({ ...input, config: config2, artifactPath: 'artifacts/update-relevance',
    allowProjectCommands: true, allowScopeExpansion: true });
  assert.equal(update.kind, 'MIGRATION_SESSION_REFERENCE_UPDATED');
  assert.equal(update.generation, 1); assert.equal(update.classification, 'EXTENSION'); assert.equal(update.referenceVersion, 2);
  await write(root, 'target/main.ts', 'export const value = 2;\n');
  const status = await inspectMigrationSession({ ...input, config: config2 });
  assert.equal(status.generation, 1); assert.equal(status.scope, 'PASS', 'the promoted path is authorized by generation 1');
});
