import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  MAX_REFERENCE_INPUT_BYTES, classifyReferenceChange, migrationConfigHash, migrationReferenceHash,
  parseMigrationReference, parseReferenceVerification,
} from '../packages/core/dist/index.js';
import { collectMigrationReference, verifyMigrationReference, ReferenceWeakeningError } from '../packages/engine/dist/migration-reference.js';
import { approveContract } from '../packages/contract-review/dist/index.js';
import { buildMigrationReport } from '../packages/quality-gates/dist/migration-report.js';

const time = '2026-09-06T12:00:00.000Z';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const observations = { status: 'STABLE', runs: 2, executionHashes: [sha256('run-1'), sha256('run-2')] };
const roots = [];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'harness-reference-'));
  roots.push(root);
  for (const [path, content] of [
    ['apps/angular/src/page.ts', 'export const page = 1;\n'],
    ['apps/angular/package.json', '{ "name": "angular" }\n'],
    ['apps/angular/.git/HEAD', 'ref: refs/heads/main\n'],
    ['apps/angular/.git/refs/heads/main', `${'1'.repeat(40)}\n`],
    ['apps/react/src/page.tsx', 'export const Page = () => null;\n'],
    ['apps/react/package.json', '{ "name": "react" }\n'],
    ['apps/react/src/auth/guard.ts', 'export const guard = true;\n'],
    ['migrations/customer/scenarios/fixtures/customer.json', '{ "id": 1 }\n'],
  ]) await write(root, path, content);
  return root;
}
async function write(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
function config() {
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'customer',
    source: {
      root: 'apps/angular', baseUrl: 'http://localhost:4200', relevantFiles: ['src/page.ts', 'package.json'],
      commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
    },
    target: {
      root: 'apps/react', baseUrl: 'http://localhost:5173', relevantFiles: ['src/page.tsx', 'package.json'],
      commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
      writePaths: ['src/page.tsx'], protectedPaths: ['src/auth'],
    },
    scenarios: [scenario('update-customer')],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [{ id: 'saved-value', scenarioId: 'update-customer', description: 'Save the edited value', origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true }],
    acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 3, maxRepairAttempts: 3, maxDurationMs: 600000 },
  };
}
function scenario(scenarioId) {
  return {
    definition: {
      scenarioId, unitId: 'customer', name: 'Save', description: 'Synthetic save',
      entryUrl: 'http://localhost:4200/customers/1',
      preconditions: { mockInitialApiResponses: [{ urlPattern: '**/api/customers/1', method: 'GET', statusCode: 200, fixturePath: 'customer.json' }] },
      testDataProfile: 'standard', steps: [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }],
    },
    required: true, fixtureRoot: 'migrations/customer/scenarios/fixtures',
    bindings: {
      source: { entryUrl: 'http://localhost:4200/customers/1', steps: [] },
      target: { entryUrl: 'http://localhost:5173/clientes/1', steps: [{ stepId: 'save', targetRole: 'button', targetName: 'Salvar' }] },
    },
  };
}
const collect = (root, extra = {}) => collectMigrationReference({ config: config(), workspaceRoot: root, createdAt: time, sourceObservations: observations, ...extra });
const verify = (root, reference, configuration = config()) => verifyMigrationReference({ reference, config: configuration, workspaceRoot: root, verifiedAt: time });
const codes = verification => verification.findings.map(item => item.code);

test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

test('an initial reference fingerprints real working-tree inputs, fixtures and protected destination work', async () => {
  const root = await workspace();
  const reference = await collect(root);
  assert.deepEqual(parseMigrationReference(reference), reference);
  assert.equal(reference.referenceVersion, 1);
  assert.deepEqual(reference.change, { classification: 'INITIAL', deltas: [] });
  assert.equal(reference.configurationHash, migrationConfigHash(config()));
  assert.equal(reference.source.revision, '1'.repeat(40));
  assert.equal(reference.target.revision, 'UNVERSIONED');
  assert.deepEqual(reference.source.files.map(item => item.path), ['package.json', 'src/page.ts']);
  assert.equal(reference.source.files[1].sha256, sha256('export const page = 1;\n'));
  assert.equal(reference.source.files[1].bytes, Buffer.byteLength('export const page = 1;\n'));
  assert.deepEqual(reference.target.protectedFiles.map(item => item.path), ['src/auth/guard.ts']);
  assert.deepEqual(reference.criteria.scenarios[0].fixtures.map(item => item.path), ['migrations/customer/scenarios/fixtures/customer.json']);
  assert.equal(reference.criteria.criticalContract, undefined);
  assert.equal(reference.criteria.scenarios[0].bindings.source === reference.criteria.scenarios[0].bindings.target, false);
  const initial = migrationReferenceHash(reference);
  assert.equal(migrationReferenceHash(await collect(root)), initial);
  assert.equal((await collectMigrationReference({ config: config(), workspaceRoot: root, createdAt: time })).sourceObservations.status, 'NOT_COLLECTED');
  await write(root, 'apps/angular/src/page.ts', 'export const page = 2;\n');
  assert.notEqual(migrationReferenceHash(await collect(root)), initial);
});

test('collection refuses missing, escaping, symlinked and oversized evaluation inputs', async () => {
  const root = await workspace();
  await assert.rejects(collect(root, { config: { ...config(), source: { ...config().source, relevantFiles: ['src/missing.ts'] } } }));
  await symlink(join(root, 'apps/react/src/page.tsx'), join(root, 'apps/angular/src/linked.ts'));
  await assert.rejects(collect(root, { config: { ...config(), source: { ...config().source, relevantFiles: ['src/linked.ts'] } } }));
  const noProtected = config(); noProtected.target.protectedPaths = ['src/absent'];
  await assert.rejects(collect(root, { config: noProtected }));
  const otherFixtures = config(); otherFixtures.scenarios[0].fixtureRoot = 'migrations/customer/scenarios/absent';
  await assert.rejects(collect(root, { config: otherFixtures }));
  await rm(join(root, 'migrations/customer/scenarios/fixtures/customer.json'));
  await write(root, 'migrations/customer/scenarios/fixtures/other.json', '{}\n');
  await assert.rejects(collect(root), /Declared mock fixture is missing/);
  await write(root, 'migrations/customer/scenarios/fixtures/customer.json', Buffer.alloc(MAX_REFERENCE_INPUT_BYTES + 1, 0x20));
  await assert.rejects(collect(root), /size cap/);
});

test('verification confirms untouched inputs and fails closed without stability evidence', async () => {
  const root = await workspace();
  const verified = await verify(root, await collect(root));
  assert.deepEqual(parseReferenceVerification(verified), verified);
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.criticalContract, 'ABSENT');
  assert.equal(verified.criticalContractSha256, undefined);
  assert.deepEqual(verified.findings, []);
  const unstable = await verify(root, await collect(root, { sourceObservations: { ...observations, status: 'UNSTABLE' } }));
  assert.equal(unstable.status, 'UNVERIFIABLE');
  assert.deepEqual(codes(unstable), ['SOURCE_OBSERVATIONS_UNSTABLE']);
  const declared = await verify(root, await collectMigrationReference({ config: config(), workspaceRoot: root, createdAt: time }));
  assert.equal(declared.status, 'UNVERIFIABLE');
  assert.deepEqual(codes(declared), ['SOURCE_OBSERVATIONS_MISSING']);
});

test('verification separates stale evaluation inputs from expected candidate changes', async () => {
  const root = await workspace();
  const reference = await collect(root);
  await write(root, 'apps/react/src/page.tsx', 'export const Page = () => <form />;\n');
  const candidate = await verify(root, reference);
  assert.equal(candidate.status, 'VERIFIED');
  assert.deepEqual(candidate.findings, [{ code: 'TARGET_INPUT_CHANGED', severity: 'INFORMATIONAL', path: 'src/page.tsx' }]);
  await write(root, 'apps/react/src/auth/session.ts', 'export const session = 1;\n');
  assert.deepEqual(codes(await verify(root, reference)).sort(), ['PROTECTED_INPUT_ADDED', 'TARGET_INPUT_CHANGED']);
  assert.equal((await verify(root, reference)).status, 'VERIFIED');

  for (const [mutate, expected] of [
    [where => write(where, 'apps/angular/src/page.ts', 'export const page = 99;\n'), 'SOURCE_INPUT_CHANGED'],
    [where => rm(join(where, 'apps/angular/package.json')), 'INPUT_MISSING'],
    [where => write(where, 'migrations/customer/scenarios/fixtures/customer.json', '{ "id": 2 }\n'), 'FIXTURE_CHANGED'],
    [where => write(where, 'migrations/customer/scenarios/fixtures/extra.json', '{}\n'), 'FIXTURE_ADDED'],
    [where => write(where, 'apps/react/src/auth/guard.ts', 'export const guard = false;\n'), 'PROTECTED_INPUT_CHANGED'],
  ]) {
    const scratch = await workspace();
    const fresh = await collect(scratch);
    await mutate(scratch);
    const result = await verifyMigrationReference({ reference: fresh, config: config(), workspaceRoot: scratch, verifiedAt: time });
    assert.equal(result.status, 'STALE', expected);
    assert.ok(codes(result).includes(expected), expected);
  }
});

test('verification rejects a configuration or reference that no longer matches its criteria', async () => {
  const root = await workspace();
  const reference = await collect(root);
  const changed = config();
  changed.requirements.push({ id: 'shows-error', scenarioId: 'update-customer', description: 'Show the failure', origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true });
  const mismatch = await verify(root, reference, changed);
  assert.equal(mismatch.status, 'UNVERIFIABLE');
  assert.deepEqual(codes(mismatch), ['CONFIGURATION_MISMATCH']);
  const tampered = structuredClone(reference);
  tampered.criteria.requirements[0].required = false;
  assert.equal((await verify(root, tampered)).status, 'UNVERIFIABLE');
  const relocated = structuredClone(reference);
  relocated.criteria.scenarios[0].semanticHash = sha256('other-semantics');
  assert.deepEqual(codes(await verify(root, relocated)), ['CONFIGURATION_MISMATCH']);
  const foreign = structuredClone(reference);
  foreign.migrationId = 'other';
  assert.deepEqual(codes(await verify(root, foreign)), ['CONFIGURATION_MISMATCH']);
});

test('an approved critical contract is verified from disk and tampering is detected', async () => {
  const root = await workspace();
  const approved = approveContract({
    unitId: 'customer', contractId: 'customer-contract', version: '1.0.0', status: 'REVIEW',
    integrity: { algorithm: 'sha256', contentHash: '' },
    scenarios: [{ scenarioId: 'update-customer', invariants: { network: [], storageDeltas: [] } }],
  }, 'owner@example.test', time);
  const bytes = `${JSON.stringify(approved, null, 2)}\n`;
  await write(root, 'migrations/customer/approved.json', bytes);
  const withContract = config();
  withContract.criticalContract = { path: 'migrations/customer/approved.json', sha256: sha256(bytes) };
  const reference = await collect(root, { config: withContract });
  assert.deepEqual(reference.criteria.criticalContract, {
    path: 'migrations/customer/approved.json', sha256: sha256(bytes), bytes: Buffer.byteLength(bytes),
    contractId: 'customer-contract', contractVersion: '1.0.0',
  });
  const verified = await verify(root, reference, withContract);
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.criticalContract, 'VERIFIED');
  assert.equal(verified.criticalContractSha256, sha256(bytes));

  const wrongDigest = structuredClone(withContract);
  wrongDigest.criticalContract.sha256 = sha256('other');
  await assert.rejects(collect(root, { config: wrongDigest }), /declared digest/);
  const review = structuredClone(approved); review.status = 'REVIEW';
  await write(root, 'migrations/customer/review.json', `${JSON.stringify(review, null, 2)}\n`);
  const notApproved = structuredClone(withContract);
  notApproved.criticalContract = { path: 'migrations/customer/review.json', sha256: sha256(`${JSON.stringify(review, null, 2)}\n`) };
  await assert.rejects(collect(root, { config: notApproved }), /APPROVED/);

  const tampered = structuredClone(approved);
  tampered.scenarios[0].invariants.storageDeltas = [{ id: 'injected', value: [], evidenceTrail: [{ source: 'HUMAN_SPECIFICATION', evidenceConfidenceHeuristic: 1 }], enforcement: 'BLOCKING' }];
  await write(root, 'migrations/customer/approved.json', `${JSON.stringify(tampered, null, 2)}\n`);
  const detected = await verify(root, reference, withContract);
  assert.equal(detected.status, 'UNVERIFIABLE');
  assert.equal(detected.criticalContract, 'MISMATCH');
  assert.deepEqual(codes(detected), ['CRITICAL_CONTRACT_MISMATCH']);
  await rm(join(root, 'migrations/customer/approved.json'));
  const missing = await verify(root, reference, withContract);
  assert.equal(missing.criticalContract, 'UNREADABLE');
  assert.equal(missing.criticalContractSha256, undefined);
});

test('a new reference version records lineage and needs an owner decision only when criteria weaken', async () => {
  const root = await workspace();
  const previous = await collect(root);
  assert.equal(classifyReferenceChange(previous, previous).classification, 'INITIAL');
  await assert.rejects(collect(root, { previous }), /at least one recorded change/);

  const extended = config();
  extended.scenarios.push(scenario('invalid-customer'));
  const extension = await collect(root, { config: extended, previous });
  assert.equal(extension.referenceVersion, 2);
  assert.equal(extension.change.classification, 'EXTENSION');
  assert.deepEqual(extension.change.deltas, [{ kind: 'SCENARIO_ADDED', scenarioId: 'invalid-customer' }]);
  assert.deepEqual(extension.supersedes, { referenceVersion: 1, referenceHash: migrationReferenceHash(previous) });
  await assert.rejects(collect(root, { config: extended, previous, ownerDecisionReference: 'REVIEWS.md#r1' }), /Only a weakened/);

  const adapted = config();
  adapted.scenarios[0].bindings.target.steps[0].targetName = 'Gravar';
  const adaptation = await collect(root, { config: adapted, previous });
  assert.equal(adaptation.change.classification, 'BINDING_ADAPTATION');
  assert.deepEqual(adaptation.change.deltas, [{ kind: 'BINDING_ADAPTED', scenarioId: 'update-customer' }]);
  const scoped = config();
  scoped.scenarios[0].bindings.target.unitScope = { role: 'form', name: 'Formulario do cliente' };
  assert.equal((await collect(root, { config: scoped, previous })).change.classification, 'BINDING_ADAPTATION');

  await write(root, 'apps/angular/src/page.ts', 'export const page = 3;\n');
  const update = await collect(root, { previous });
  assert.equal(update.change.classification, 'INPUT_UPDATE');
  assert.deepEqual(update.change.deltas.map(item => item.kind), ['SOURCE_INPUT_CHANGED']);

  for (const [describe, mutate] of [
    ['demoted scenario', c => { c.scenarios[0].required = false; c.scenarios.push({ ...scenario('invalid-customer'), required: true }); }],
    ['removed requirement', c => { c.requirements = []; }],
    ['changed requirement assertion', c => { c.requirements[0].assertion = { checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NODE_PRESENT', role: 'alert' } }; }],
    ['demoted requirement', c => { c.requirements[0].required = false; }],
    ['accepted difference', c => { c.acceptedDifferences.push({ id: 'shell', scenarioId: 'update-customer', description: 'React shell differs', decisionReference: 'REVIEWS.md#r2' }); }],
    ['broader ignore rules', c => { c.policy.network = { volatilePayloadFields: ['email'] }; }],
    ['changed semantics', c => { c.scenarios[0].definition.steps[0].action = 'focus'; }],
    ['relaxed check', c => { c.checks[0].required = false; c.checks.push({ id: 'other-build', side: 'target', commandId: 'build', required: true }); }],
    ['smaller stability budget', c => { c.limits.sourceRuns = 2; }],
  ]) {
    const scratch = await workspace();
    const base = await collect(scratch);
    const weakened = config(); mutate(weakened);
    await assert.rejects(collectMigrationReference({ config: weakened, workspaceRoot: scratch, createdAt: time, sourceObservations: observations, previous: base }), ReferenceWeakeningError, describe);
    const decided = await collectMigrationReference({ config: weakened, workspaceRoot: scratch, createdAt: time, sourceObservations: observations, previous: base, ownerDecisionReference: 'REVIEWS.md#r3' });
    assert.equal(decided.change.classification, 'WEAKENING', describe);
    assert.equal(decided.change.ownerDecisionReference, 'REVIEWS.md#r3');
    assert.equal(decided.referenceVersion, 2);
  }

  const scratch = await workspace();
  const base = await collect(scratch);
  await write(scratch, 'migrations/customer/scenarios/fixtures/customer.json', '{ "id": 7 }\n');
  await assert.rejects(collect(scratch, { previous: base }), ReferenceWeakeningError);
  await write(scratch, 'apps/react/src/auth/guard.ts', 'export const guard = false;\n');
  const protectedChange = await collect(scratch, { previous: base, ownerDecisionReference: 'REVIEWS.md#r4' });
  assert.ok(protectedChange.change.deltas.some(item => item.kind === 'PROTECTED_INPUT_CHANGED'));
});

test('the aggregate report accepts a critical contract only with a verified reference', async () => {
  const root = await workspace();
  const approved = approveContract({
    unitId: 'customer', contractId: 'customer-contract', version: '1.0.0', status: 'REVIEW',
    integrity: { algorithm: 'sha256', contentHash: '' },
    scenarios: [{ scenarioId: 'update-customer', invariants: { network: [], storageDeltas: [] } }],
  }, 'owner@example.test', time);
  const bytes = `${JSON.stringify(approved, null, 2)}\n`;
  await write(root, 'migrations/customer/approved.json', bytes);
  const configuration = config();
  configuration.criticalContract = { path: 'migrations/customer/approved.json', sha256: sha256(bytes) };
  configuration.requirements[0].origin = 'CRITICAL_CONTRACT';
  const reference = await collect(root, { config: configuration });
  const verification = await verify(root, reference, configuration);
  const identity = {
    migrationId: 'customer', configurationHash: migrationConfigHash(configuration),
    referenceHash: verification.referenceHash, candidateHash: sha256('candidate'), buildHash: sha256('build'),
  };
  const evidence = () => ({
    identity: structuredClone(identity), evaluatedAt: time, referenceVerified: true, reference: structuredClone(verification),
    scenarios: [{ identity: structuredClone(identity), scenarioId: 'update-customer', status: 'PASS', requirements: [{ requirementId: 'saved-value', status: 'PASS' }], diagnostics: [], evidencePaths: [] }],
    checks: [{ identity: structuredClone(identity), checkId: 'target-build', status: 'PASS', diagnostics: [], evidencePaths: [] }],
  });
  const report = buildMigrationReport(configuration, evidence());
  assert.equal(report.status, 'PASS');
  assert.equal(report.referenceStatus, 'VERIFIED');

  const withoutVerification = evidence(); delete withoutVerification.reference;
  const declared = buildMigrationReport(configuration, withoutVerification);
  assert.equal(declared.status, 'INCONCLUSIVE');
  assert.equal(declared.referenceStatus, 'DECLARED');
  assert.ok(declared.diagnostics.some(item => item.code === 'CRITICAL_CONTRACT_UNVERIFIED'));

  const mismatched = evidence(); mismatched.reference.referenceHash = sha256('other-reference');
  const wrongReference = buildMigrationReport(configuration, mismatched);
  assert.equal(wrongReference.status, 'INCONCLUSIVE');
  assert.ok(wrongReference.diagnostics.some(item => item.code === 'REFERENCE_MISMATCH'));

  await write(root, 'migrations/customer/approved.json', `${bytes.slice(0, -1)} \n`);
  const stale = evidence(); stale.reference = await verify(root, reference, configuration);
  const afterTampering = buildMigrationReport(configuration, stale);
  assert.equal(afterTampering.status, 'INCONCLUSIVE');
  assert.equal(afterTampering.referenceStatus, 'UNVERIFIABLE');
  assert.deepEqual(afterTampering.diagnostics.filter(item => item.code !== 'REFERENCE_UNVERIFIED').map(item => item.code), ['CRITICAL_CONTRACT_UNVERIFIED']);
});
