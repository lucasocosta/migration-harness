import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { migrationSessionPath, startMigrationSession } from '../packages/engine/dist/migration-session.js';
import { ERROR_CATALOG } from '../packages/cli/dist/errors.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';
import { digest } from './helpers/session.mjs';

// Reference verification status on the CLI v2 surface (PLAN-V2 §8.2 — characterization rewritten
// against v2): `status` projects what `verifyMigrationReference` answers for the session's prepared
// reference. VERIFIED keeps the recorded disposition (READY before any attempt); anything else
// answers REVIEW_REFERENCE + SESSION_REFERENCE_NOT_VERIFIED — a processed read, never an
// evaluation (`outcome` is absent), never PASS, never an attempt, and the recommendation it makes
// is a proposal, never an adoption. Fixtures are evaluation inputs outside the source/target scope
// walk, so a stale reference is a reference problem and never an OUTSIDE_WRITE_SCOPE refusal.
//
// Owners next door, deliberately not duplicated here: the reference status lifecycle itself is
// tests/migration-reference.test.mjs, the decision × exit matrix is tests/v2-decisions.test.mjs,
// the healthy READY read (and scope/stop precedence) is tests/v2-commands.test.mjs, and the frozen
// table is tests/v2-envelope.test.mjs.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const read = async args => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { timeout: 180_000 });
    return { code: 0, stdout, stderr };
  } catch (error) { return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }; }
};
const json = run => JSON.parse(run.stdout);

/** Standard-profile workspace with a started session over a reference that records a real fixture. */
async function fixture(t) {
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  t.after(() => rm(root, { recursive: true, force: true }));
  // The declared fixture root exists, so the reference fingerprints its files: this is the
  // evaluation input a later edit can invalidate without touching source or target.
  await write(root, 'fixtures/seed.json', '{"seed":1}\n');
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
  return { root, config, sessionPath: migrationSessionPath(config),
    status: () => read(['status', '--config', join(root, 'migration.json'), '--workspace-root', root, '--json']) };
}

test('a reference that still verifies keeps the read an unevaluated disposition, exit 0', async t => {
  const f = await fixture(t);
  const run = await f.status();
  assert.equal(run.code, 0, run.stderr);
  const envelope = json(run);
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.decision, 'READY');
  assert.equal('outcome' in envelope, false, 'reading state is not an evaluation');
  assert.equal(envelope.report.kind, 'MIGRATION_SESSION_STATUS');
  assert.equal(envelope.report.referenceStatus, 'VERIFIED');
  assert.equal(envelope.report.attemptsUsed, 0, 'reading state never spends an attempt');
});

test('an evaluation input that no longer matches the reference reports REVIEW_REFERENCE, never a pass', async t => {
  const f = await fixture(t);
  assert.equal(json(await f.status()).report.referenceStatus, 'VERIFIED');

  // Edit a declared fixture: `verifyMigrationReference` answers STALE (BLOCKING FIXTURE_CHANGED)
  // while the scope snapshot — source and target trees only — stays untouched.
  await write(f.root, 'fixtures/seed.json', '{"seed":2}\n');
  const run = await f.status();
  assert.equal(run.code, 0, `REVIEW_REFERENCE is a processed read: ${run.stderr}`);
  const envelope = json(run);
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.decision, 'REVIEW_REFERENCE');
  assert.equal('outcome' in envelope, false, 'a stale reference never invents an evaluation');
  assert.equal(envelope.report.referenceStatus, 'STALE');
  assert.equal(envelope.report.scope, 'PASS', 'fixtures are evaluation inputs, not workspace scope');
  assert.equal(envelope.report.attemptsUsed, 0, 'a stale reference is discovered without spending an attempt');
  assert.equal(envelope.diagnostics[0].code, 'SESSION_REFERENCE_NOT_VERIFIED');
  assert.equal(envelope.diagnostics[0].category, ERROR_CATALOG.SESSION_REFERENCE_NOT_VERIFIED.category);
  assert.equal(envelope.diagnostics[0].retryable, ERROR_CATALOG.SESSION_REFERENCE_NOT_VERIFIED.retryable);
  assert.ok(envelope.diagnostics[0].action.length > 0, 'the catalog action travels with the diagnostic');

  // The recommendation is a proposal: it names `reference` with the artifact path this invocation
  // would use, carries the owner authorization the operation requires and never the decision itself
  // (PLAN-V2 §3.1 — REVIEW_REFERENCE never authorizes an adoption).
  const action = envelope.nextActions[0];
  assert.equal(action.operation, 'reference');
  assert.equal(action.requiresApproval, 'requires_authorization');
  assert.ok(action.args['--artifact-path'], 'the proposal is executable as printed');
  assert.equal('--owner-decision' in action.args, false, 'a proposal never pre-fills the owner decision');
});

test('the diagnostic is the published catalog entry, not an ad-hoc message', () => {
  const entry = ERROR_CATALOG.SESSION_REFERENCE_NOT_VERIFIED;
  assert.equal(entry.category, 'STATE');
  assert.equal(entry.retryable, false);
  assert.match(entry.action, /re-prepare/i);
});
