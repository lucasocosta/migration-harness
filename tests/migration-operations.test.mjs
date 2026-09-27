import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { migrationReferenceHash, parseMigrationPreparation } from '../packages/core/dist/index.js';
import { preflightMigration, prepareMigration, verifyMigration, summarizeMigration } from '../packages/engine/dist/migration-operations.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { migrationCommand, migrationHelp } from '../packages/cli/dist/migration.js';
import { buildWorkspace } from './helpers/build-workspace.mjs';

const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const hex = digit => digit.repeat(64);
const missing = path => assert.rejects(readFile(path), error => error.code === 'ENOENT');

async function fixture(t) {
  const value = await buildWorkspace();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  return value;
}

function referenceStub(overrides = {}) {
  return {
    kind: 'MIGRATION_REFERENCE', version: '1', migrationId: 'served-builds', referenceVersion: 1,
    createdAt: new Date().toISOString(), configurationHash: hex('1'),
    source: { root: 'source', revision: 'UNVERSIONED', files: [{ path: 'main.ts', sha256: hex('2'), bytes: 22 }] },
    target: { root: 'target', revision: 'UNVERSIONED', files: [{ path: 'main.ts', sha256: hex('2'), bytes: 22 }], protectedFiles: [] },
    criteria: {
      scenarios: [{ scenarioId: 'boot', required: true, semanticHash: hex('4'),
        bindings: { source: hex('5'), target: hex('6') }, fixtures: [] }],
      requirements: [], acceptedDifferences: [],
      checks: [{ id: 'build-target', side: 'target', required: true, digest: hex('7') }],
      policyHash: hex('8'), environmentHash: hex('9'), limitsHash: hex('0'),
    },
    sourceObservations: { status: 'NOT_COLLECTED', runs: 0 },
    change: { classification: 'INITIAL', deltas: [] },
    ...overrides,
  };
}

function preparationStub(overrides = {}) {
  const reference = referenceStub();
  return { kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS', reference,
    referenceHash: migrationReferenceHash(reference), artifactPath: 'artifacts/prepared-fixture',
    keyId: hex('a'), sourceEvidence: [], ...overrides };
}

test('parseMigrationPreparation accepts a valid preparation and enforces the strict schema', () => {
  const preparation = preparationStub();
  assert.deepEqual(parseMigrationPreparation(preparation), preparation);
  const validEntry = { scenarioId: 'boot', runIndex: 0, runId: 'run-1', traceHash: hex('b'), path: 'capture/boot/0.json' };
  assert.equal(parseMigrationPreparation({ ...preparation, sourceEvidence: [validEntry] }).sourceEvidence.length, 1);
  for (const invalid of [
    { ...preparation, kind: 'MIGRATION_CONFIG' }, { ...preparation, version: '2' }, { ...preparation, status: 'DONE' },
    { ...preparation, extra: 'x' },
    { ...preparation, sourceEvidence: [{ ...validEntry, nope: true }] },
    { ...preparation, sourceEvidence: [{ ...validEntry, path: undefined }] },
    { ...preparation, referenceHash: 'not-a-digest' },
    { ...preparation, reference: { ...referenceStub(), extra: 'x' } },
  ]) assert.throws(() => parseMigrationPreparation(invalid));
});

test('prepareMigration and verifyMigration refuse project execution without explicit authorization', async t => {
  const value = await fixture(t);
  for (const allowProjectCommands of [undefined, false]) {
    await assert.rejects(prepareMigration({ config: value.config, workspaceRoot: value.root,
      artifactPath: `artifacts/denied-prepare-${allowProjectCommands}`, allowProjectCommands }), /EXECUTION_NOT_AUTHORIZED/);
    await assert.rejects(verifyMigration({ config: value.config, workspaceRoot: value.root,
      artifactPath: `artifacts/denied-verify-${allowProjectCommands}`, allowProjectCommands, preparation: preparationStub() }), /EXECUTION_NOT_AUTHORIZED/);
  }
  await missing(join(value.root, 'artifacts'));
});

test('reserve refuses artifact outputs overlapping evaluation inputs and private workspaces', async t => {
  const value = await fixture(t);
  for (const artifactPath of ['source/out', 'target', 'fixtures/run']) {
    await assert.rejects(prepareMigration({ config: value.config, workspaceRoot: value.root, artifactPath, preflightOnly: true }), /UNSAFE_OPERATION_OUTPUT/);
  }
  await missing(join(value.root, 'source/out')); await missing(join(value.root, 'fixtures/run'));
  const root = await mkdtemp(join(tmpdir(), 'migration-ops-private-')); t.after(() => rm(root, { recursive: true, force: true }));
  const privateWorkspace = join(root, '.migration-private', 'workspace');
  await mkdir(privateWorkspace, { recursive: true });
  await assert.rejects(prepareMigration({ config: value.config, workspaceRoot: privateWorkspace, artifactPath: 'artifacts/x', preflightOnly: true }), /PRIVATE_WORKSPACE/);
  await missing(join(privateWorkspace, 'artifacts'));
});

test('verifyMigration refuses a preparation whose recorded reference hash no longer matches', async t => {
  const value = await fixture(t), preparation = preparationStub();
  const last = Number.parseInt(preparation.referenceHash.at(-1), 16);
  const tampered = { ...preparation, referenceHash: `${preparation.referenceHash.slice(0, -1)}${'0123456789abcdef'[(last + 1) % 16]}` };
  assert.equal(parseMigrationPreparation(tampered).status, 'PASS');
  await assert.rejects(verifyMigration({ config: value.config, workspaceRoot: value.root,
    artifactPath: 'artifacts/tampered', allowProjectCommands: true, preparation: tampered }), /PREPARATION_HASH_MISMATCH/);
  await missing(join(value.root, 'artifacts/tampered'));
});

test('verifyMigration with an unreadable preparation evidence root stays inconclusive with stale-evidence diagnostics', async t => {
  const value = await fixture(t), output = 'artifacts/verify-stale', missingPrep = `missing-prep-${randomUUID().slice(0, 8)}`;
  t.after(() => rm(new ArtifactStore(join(value.root, missingPrep)).privateRoot, { recursive: true, force: true }));
  const report = await verifyMigration({ config: value.config, workspaceRoot: value.root, artifactPath: output,
    allowProjectCommands: true, preparation: preparationStub({ artifactPath: missingPrep }) });
  assert.equal(report.kind, 'MIGRATION_REPORT');
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.notEqual(report.referenceStatus, 'VERIFIED');
  assert.ok(report.diagnostics.some(item => item.code === 'STALE_EVIDENCE' && item.category === 'EVIDENCE'
    && item.detailCode === 'REFERENCE_EVIDENCE_UNAVAILABLE'));
  assert.ok(report.scenarios.length === 1 && report.scenarios.every(item => item.status === 'INCONCLUSIVE'));
  assert.deepEqual(JSON.parse(await readFile(join(value.root, output, 'migration-report.json'), 'utf8')), JSON.parse(JSON.stringify(report)));
  const summary = summarizeMigration(report);
  assert.match(summary, /^Migration served-builds: INCONCLUSIVE$/m);
  assert.ok(summary.split('\n').includes('Scenario boot: INCONCLUSIVE'));
  assert.match(summary, /STALE_EVIDENCE \(REFERENCE_EVIDENCE_UNAVAILABLE\)/);
});

test('preflight reports bounded status and --preflight-only writes preflight evidence without a preparation', async t => {
  const value = await fixture(t);
  const preflight = await preflightMigration({ config: value.config, workspaceRoot: value.root });
  assert.equal(preflight.kind, 'MIGRATION_PREFLIGHT');
  assert.ok(['PASS', 'INCONCLUSIVE'].includes(preflight.status));
  assert.ok(Array.isArray(preflight.diagnostics));
  assert.equal(preflight.checks.kind, 'PROJECT_PREFLIGHT');
  if (preflight.status === 'INCONCLUSIVE') assert.ok(preflight.diagnostics.length > 0);
  const output = `artifacts/preflight-only-${randomUUID().slice(0, 8)}`;
  const result = await prepareMigration({ config: value.config, workspaceRoot: value.root, artifactPath: output, preflightOnly: true });
  assert.equal(result.kind, 'MIGRATION_PREFLIGHT');
  assert.ok(['PASS', 'INCONCLUSIVE'].includes(result.status));
  assert.deepEqual(JSON.parse(await readFile(join(value.root, output, 'preflight.json'), 'utf8')), result);
  await missing(join(value.root, output, 'preparation.json'));
  await missing(join(value.root, output, 'reference.json'));
});

test('migration CLI validates options and help before touching any workspace', async () => {
  const prepare = migrationHelp('prepare-migration'), verify = migrationHelp('verify-migration');
  assert.match(prepare, /--preflight-only/); assert.match(prepare, /--previous <preparation\.json>/); assert.match(prepare, /--owner-decision/);
  assert.match(verify, /--preparation <preparation\.json>/); assert.ok(!verify.includes('--preflight-only'));
  for (const help of [prepare, verify]) { assert.match(help, /--allow-project-commands/); assert.match(help, /Exit codes: 0 PASS; 4 FAIL; 5 INCONCLUSIVE/); assert.match(help, /examples\/validation-first\/README\.md/); }
  await assert.rejects(migrationCommand('prepare-migration', { nope: 'x' }), /UNSUPPORTED_MIGRATION_OPTION/);
  await assert.rejects(migrationCommand('verify-migration', { 'preflight-only': true }), /UNSUPPORTED_MIGRATION_OPTION/);
  await assert.rejects(migrationCommand('prepare-migration', { 'preflight-only': true, 'allow-project-commands': true }), /CONFLICTING_PREFLIGHT_OPTIONS/);
  await assert.rejects(migrationCommand('prepare-migration', { 'owner-decision': 'decision-1' }), /OWNER_DECISION_REQUIRES_PREVIOUS/);
  await assert.rejects(migrationCommand('prepare-migration', {}), /MISSING_WORKSPACE_ROOT/);
  const help = await exec(process.execPath, [cli, 'prepare-migration', '--help']);
  assert.match(help.stdout, /^prepare-migration --config <migration\.json>/);
  await assert.rejects(exec(process.execPath, [cli, 'verify-migration', '--preflight-only']), error => error.code === 1 && /UNSUPPORTED_MIGRATION_OPTION/.test(error.stderr));
});
