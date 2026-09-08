import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { startMigrationSession, inspectMigrationSession, verifyMigrationSession, migrationSessionPath } from '../packages/engine/dist/migration-session.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
async function fixture(t) {
  const { root, config } = await buildWorkspace(); config.profile = 'standard';
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { config, workspaceRoot: root };
  // Synthetic observation declaration tests session bookkeeping, never migration success.
  const reference = await collectMigrationReference({ ...input,
    sourceObservations: { status: 'STABLE', runs: 2, executionHashes: [digest('source'), digest('source')] } });
  const baseline = await runProjectChecks({ ...input, phase: 'baseline', allowProjectCommands: true });
  const preparation = { kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS', reference,
    referenceHash: migrationReferenceHash(reference), artifactPath: 'artifacts/prepared', keyId: digest('dummy'), sourceEvidence: [], baseline,
    sourceBuild: { kind: 'SERVED_BUILD', version: '1', side: 'source', runId: randomUUID(), origin: config.source.baseUrl,
      configurationHash: migrationConfigHash(config), inputHash: digest('input'), buildHash: digest('build'), fileCount: 1, totalBytes: 1 } };
  const sessionPath = migrationSessionPath(config);
  return { root, config, input, preparation, sessionPath,
    envelope: async () => JSON.parse(await readFile(join(root, sessionPath, 'session.json'), 'utf8')) };
}

test('session status does not create a missing session; start is exclusive across invocations', async t => {
  const f = await fixture(t);
  await assert.rejects(inspectMigrationSession(f.input), { code: 'ENOENT' });
  const started = await startMigrationSession({ ...f.input, preparation: f.preparation });
  assert.equal(started.maxAttempts, 4);
  await assert.rejects(startMigrationSession({ ...f.input, preparation: f.preparation }), /SESSION_ALREADY_EXISTS/);
  const status = await inspectMigrationSession(f.input);
  assert.equal(status.attemptsUsed, 0); assert.equal(status.lastReportMatchesWorkspace, false);
  assert.equal(status.scope, 'PASS');
  assert.equal(migrationSessionPath({ ...f.config, migrationId: 'new-id' }), f.sessionPath);
  await assert.rejects(inspectMigrationSession({ ...f.input, config: { ...f.config, migrationId: 'new-id' } }), /SESSION_INPUT_MISMATCH/);
});

test('scope and execution refusals run no attempt and never overwrite user work', async t => {
  const f = await fixture(t);
  await write(f.root, 'target/user.txt', 'dirty baseline');
  await startMigrationSession({ ...f.input, preparation: f.preparation });
  await assert.rejects(verifyMigrationSession(f.input), /EXECUTION_NOT_AUTHORIZED/);
  await write(f.root, 'target/user.txt', 'concurrent user change');
  const result = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(result.decision, 'REFUSED_SCOPE'); assert.equal(result.attemptsUsed, 0);
  assert.equal(await readFile(join(f.root, 'target/user.txt'), 'utf8'), 'concurrent user change');
});

test('criteria, scope and limits cannot be altered within a session', async t => {
  const f = await fixture(t); await startMigrationSession({ ...f.input, preparation: f.preparation });
  for (const config of [
    { ...f.config, limits: { ...f.config.limits, maxRepairAttempts: 9 } },
    { ...f.config, target: { ...f.config.target, writePaths: ['page.tsx', 'main.ts'] } },
    { ...f.config, scenarios: [{ ...f.config.scenarios[0], required: false }] },
  ]) await assert.rejects(inspectMigrationSession({ ...f.input, config }));
  const envelope = await f.envelope(); envelope.session.maxAttempts++;
  envelope.hash = digest(envelope.session);
  await write(f.root, `${f.sessionPath}/session.json`, JSON.stringify(envelope));
  await assert.rejects(inspectMigrationSession(f.input), /SESSION_INPUT_MISMATCH/);
});

async function journal(f, durations, repeated = false, interrupted = false) {
  let previousHash = (await f.envelope()).hash;
  for (let index = 0; index < durations.length; index++) {
    const prefix = `${f.sessionPath}/attempts/${String(index).padStart(4, '0')}`;
    const start = { index, startedAt: new Date().toISOString(), previousHash,
      candidateHash: digest(repeated ? 'same' : index), remainingMs: f.config.limits.maxDurationMs - durations.slice(0, index).reduce((a, b) => a + b, 0) };
    await write(f.root, `${prefix}.started.json`, JSON.stringify(start));
    if (interrupted && index === durations.length - 1) break;
    const finish = { index, startHash: digest(start), finishedAt: new Date().toISOString(), durationMs: durations[index],
      outcome: 'INCONCLUSIVE', fingerprint: digest('same-error'), candidateHash: start.candidateHash, findings: [], errorCode: 'SYNTHETIC_FAILURE' };
    await write(f.root, `${prefix}.finished.json`, JSON.stringify(finish)); previousHash = digest(finish);
  }
}

for (const [name, durations, repeated, interrupted, decision] of [
  ['attempt count', [1, 1, 1, 1], false, false, 'STOP_LIMIT'],
  ['active time', [15000], false, false, 'STOP_LIMIT'],
  ['no progress', [1, 1], true, false, 'STOP_NO_PROGRESS'],
  ['interrupted reservation', [1], false, true, 'INTERRUPTED'],
]) test(`persistent ${name} stops before executing another candidate`, async t => {
  const f = await fixture(t); await startMigrationSession({ ...f.input, preparation: f.preparation });
  await journal(f, durations, repeated, interrupted);
  assert.equal((await inspectMigrationSession(f.input)).stop, decision);
  assert.equal((await verifyMigrationSession({ ...f.input, allowProjectCommands: true })).decision, decision);
  await write(f.root, 'migration.json', JSON.stringify(f.config));
  await assert.rejects(exec(process.execPath, [cli, 'migration-session-status', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root]),
    error => error.code === 3 && JSON.parse(error.stdout).stop === decision);
});

test('journal gaps and edited hash chains are rejected, never treated as a fresh budget', async t => {
  const f = await fixture(t); await startMigrationSession({ ...f.input, preparation: f.preparation });
  await journal(f, [1, 2]);
  const path = `${f.sessionPath}/attempts/0001.started.json`;
  const start = JSON.parse(await readFile(join(f.root, path), 'utf8')); start.previousHash = digest('tampered');
  await write(f.root, path, JSON.stringify(start));
  await assert.rejects(inspectMigrationSession(f.input), /SESSION_HISTORY_INVALID/);
  await rm(join(f.root, `${f.sessionPath}/attempts/0000.started.json`));
  await assert.rejects(inspectMigrationSession(f.input));
});

test('standard CLI owns reference/output; alternate flags cannot start a fresh verifier', async t => {
  const f = await fixture(t); await write(f.root, 'migration.json', JSON.stringify(f.config));
  for (const extra of [['--artifact-path', 'artifacts/bypass'], ['--preparation', 'fake.json']]) {
    await assert.rejects(exec(process.execPath, [cli, 'verify-migration', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root, '--allow-project-commands', ...extra]),
      error => error.code === 1 && /STANDARD_SESSION_OWNS_REFERENCE_AND_OUTPUT/.test(error.stderr));
  }
  await startMigrationSession({ ...f.input, preparation: f.preparation });
  delete f.config.profile;
  await write(f.root, 'migration.json', JSON.stringify(f.config));
  await assert.rejects(exec(process.execPath, [cli, 'verify-migration', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root,
    '--allow-project-commands', '--artifact-path', 'artifacts/bypass', '--preparation', 'fake.json']),
  error => error.code === 1 && /STANDARD_SESSION_PROFILE_REQUIRED/.test(error.stderr));
});
