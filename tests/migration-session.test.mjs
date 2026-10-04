import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { startMigrationSession, inspectMigrationSession, verifyMigrationSession, migrationSessionPath } from '../packages/engine/dist/migration-session.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';
import { digest, journal } from './helpers/session.mjs';

// Session bookkeeping after the kill switch (PLAN-V2 §8.2): engine-level invariants only. The
// budget/stop matrix is owned by tests/v2-polish-refusals.test.mjs (journal + exit 3) and the
// session-owned reference/output invariant by tests/characterization-profiles.test.mjs — no
// duplicate of either lives here; the journal writer itself is tests/helpers/session.mjs.
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
