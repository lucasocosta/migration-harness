import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  canonical, migrationConfigHash, migrationReferenceHash, parseMigrationPreparation, scenarioSemanticProjection,
} from '../packages/core/dist/index.js';
import { verifySourceStability } from '../packages/equivalence-validator/dist/index.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import {
  captureStateSnapshot, compareSourceStateEvidence, parseStateSnapshot, readStateSnapshot, readStateSnapshots,
  stateEvidenceKey, stateEvidencePins, verifyStateSourceStability,
} from '../packages/engine/dist/state-capture.js';
import { collectMigrationReference, ReferenceWeakeningError } from '../packages/engine/dist/migration-reference.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const KEY = 'a'.repeat(64);
const BUILD_HASH = 'b'.repeat(64);
const roots = [];
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'state-capture-'));
  roots.push(root);
  return root;
};

/** Fixed domain-state projection: one PII email, one structural name, one undeclared key and one undeclared root. */
const PROBE_SCRIPT = `const email = process.argv[2] ?? 'person@example.test';
process.stdout.write(JSON.stringify({ users: [{ id: 1, email, name: 'Ana Souza', secret: 'INTERNAL_FLAG' }], total: 1, flag: 'DROP_ME' }));\n`;
const BARRIER_SCRIPT = `import { existsSync } from 'node:fs';
process.stdout.write(JSON.stringify({ marker: existsSync('ready.txt') ? 'ready' : 'pending' }));\n`;

async function fixture(scripts) {
  const root = await workspace();
  for (const side of ['source-app', 'target-app']) {
    await mkdir(join(root, 'apps', side), { recursive: true });
    for (const [name, content] of Object.entries(scripts)) await writeFile(join(root, 'apps', side, name), content);
  }
  return root;
}
async function referenceFixture() {
  const root = await workspace();
  for (const [path, content] of [
    ['apps/source-app/src/page.ts', 'export const page = 1;\n'],
    ['apps/source-app/package.json', '{}\n'],
    ['apps/target-app/src/page.tsx', 'export const page = 1;\n'],
    ['apps/target-app/package.json', '{}\n'],
    ['apps/target-app/src/auth/guard.ts', 'export const guard = true;\n'],
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const projection = () => ({
  id: 'db-state',
  comparison: { collections: [{ path: '/users', mode: 'KEYED', keyFields: ['id'] }] },
  privacy: {
    allowedPaths: ['/users/*/id', '/users/*/email', '/users/*/name', '/total', '/marker'],
    fields: [
      { path: '/users/*/email', representation: 'KEYED_EQUALITY' },
      { path: '/users/*/name', representation: 'STRUCTURAL' },
    ],
  },
});
const capture = (id, checkpoint, settle) => ({
  id, projectionId: 'db-state', checkpoint: { kind: checkpoint }, required: true,
  bindings: { source: { commandId: 'probe-state' }, target: { commandId: 'probe-state' } },
  ...(settle ? { settle } : {}),
});

function configuration(options = {}) {
  const { captures = [], projections = null, probeArgv = [process.execPath, 'state-probe.mjs'], stateClaim = null,
    acceptedDifferences = [], sourceFiles = ['state-probe.mjs'], targetFiles = ['state-probe.mjs'],
    writePaths = ['src/app.ts'], protectedPaths = ['src/auth'] } = options;
  const commands = side => [
    { id: 'build', kind: 'build', argv: [process.execPath, '-e', '0'], cwd: '.', timeoutMs: 5000 },
    { id: 'probe-state', kind: 'probe', argv: probeArgv, cwd: '.', timeoutMs: 5000 },
  ];
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'state-capture',
    source: { root: 'apps/source-app', baseUrl: 'http://localhost:4200', relevantFiles: sourceFiles, commands: commands('source') },
    target: { root: 'apps/target-app', baseUrl: 'http://localhost:5173', relevantFiles: targetFiles, commands: commands('target'),
      writePaths, protectedPaths },
    scenarios: [{
      definition: {
        scenarioId: 'boot', unitId: 'state-unit', name: 'Boot', description: 'Synthetic state boot',
        entryUrl: 'http://localhost:4200/customers/1', preconditions: {}, testDataProfile: 'standard',
        steps: [{ stepId: 'open', action: 'click', targetRole: 'button', targetName: 'Open' }],
      },
      required: true, fixtureRoot: 'fixtures/boot',
      bindings: {
        source: { entryUrl: 'http://localhost:4200/customers/1', steps: [] },
        target: { entryUrl: 'http://localhost:5173/customers/1', steps: [{ stepId: 'open', targetRole: 'button', targetName: 'Abrir' }] },
      },
      ...(captures.length ? { stateCaptures: captures } : {}),
    }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [{
      id: 'saved', scenarioId: 'boot', description: 'The state is saved', origin: 'SPECIFICATION',
      sourceReference: 'SPEC.md', required: true, ...(stateClaim ? { stateClaim } : {}),
    }],
    acceptedDifferences,
    policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 2, maxRepairAttempts: 1, maxDurationMs: 60000 },
    ...(projections ? { stateProjections: projections } : {}),
  };
}

const input = (root, config, store, extra = {}) => ({ config, workspaceRoot: root, side: 'source', scenarioId: 'boot',
  captureId: 'state-end', checkpoint: 'SCENARIO_END', runIndex: 0, runId: randomUUID(),
  buildHash: BUILD_HASH, pseudonymizationKey: KEY, store, ...extra });

/** Capture one source run and return the suite-shaped record entries (SuiteStateEvidence) for it. */
async function captureRun(root, config, store, runIndex, captureIds) {
  const state = [];
  for (const [captureId, checkpoint] of captureIds) {
    const result = await captureStateSnapshot({ config, workspaceRoot: root, side: 'source', scenarioId: 'boot',
      captureId, checkpoint, runIndex, runId: randomUUID(), buildHash: BUILD_HASH, pseudonymizationKey: KEY, store });
    state.push({ captureId, checkpoint, required: true, completeness: result.envelope.completeness,
      settle: result.envelope.settle.status, evidenceHash: result.envelope.evidenceHash,
      projectionFingerprint: result.envelope.projectionFingerprint, evidencePath: result.evidencePath,
      ...(result.reason ? { reason: result.reason } : {}) });
  }
  return { state };
}

test('a probe run persists a sanitized STATE_SNAPSHOT at AFTER_RESET and SCENARIO_END', async () => {
  const root = await fixture({ 'state-probe.mjs': PROBE_SCRIPT });
  const config = configuration({ projections: [projection()],
    captures: [capture('state-reset', 'AFTER_RESET'), capture('state-end', 'SCENARIO_END')] });
  const store = new ArtifactStore(join(root, 'capture'));
  const common = { config, workspaceRoot: root, side: 'source', scenarioId: 'boot', runIndex: 0,
    runId: randomUUID(), buildHash: BUILD_HASH, pseudonymizationKey: KEY, store };
  const reset = await captureStateSnapshot({ ...common, captureId: 'state-reset', checkpoint: 'AFTER_RESET' });
  const end = await captureStateSnapshot({ ...common, captureId: 'state-end', checkpoint: 'SCENARIO_END' });

  const fields = ['kind', 'version', 'captureId', 'checkpoint', 'side', 'scenarioId', 'runId', 'runIndex',
    'probe', 'projectionId', 'projectionFingerprint', 'configurationHash', 'buildHash', 'settle',
    'completeness', 'projection', 'evidenceHash'];
  for (const [result, checkpoint, captureId] of [[reset, 'AFTER_RESET', 'state-reset'], [end, 'SCENARIO_END', 'state-end']]) {
    const envelope = result.envelope;
    assert.equal(result.reason, undefined);
    assert.deepEqual(Object.keys(envelope), fields, 'the envelope carries exactly the versioned field list');
    assert.equal(envelope.kind, 'STATE_SNAPSHOT');
    assert.equal(envelope.version, '1');
    assert.equal(envelope.captureId, captureId);
    assert.equal(envelope.checkpoint, checkpoint);
    assert.equal(envelope.side, 'source');
    assert.equal(envelope.scenarioId, 'boot');
    assert.equal(envelope.runId, common.runId, 'identity is harness-assigned, not probe-supplied');
    assert.equal(envelope.runIndex, 0);
    assert.equal(envelope.probe.commandId, 'probe-state');
    assert.match(envelope.probe.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(envelope.projectionId, 'db-state');
    assert.match(envelope.projectionFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(envelope.configurationHash, migrationConfigHash(config));
    assert.equal(envelope.buildHash, BUILD_HASH);
    assert.deepEqual(envelope.settle, { status: 'NO_BARRIER' }, 'no declared barrier records the synchronous-commit assumption');
    assert.equal(envelope.completeness, 'COMPLETE');
    const { evidenceHash, ...body } = envelope;
    assert.equal(sha256(canonical(body)), evidenceHash, 'evidenceHash covers the canonical envelope minus itself');
    const bytes = await readFile(join(root, 'capture', result.evidencePath), 'utf8');
    assert.deepEqual(parseStateSnapshot(JSON.parse(bytes)), envelope);
  }
  assert.notEqual(reset.evidencePath, end.evidencePath);
  assert.equal((await readStateSnapshots(join(root, 'capture'))).length, 2);
  assert.throws(() => parseStateSnapshot({ ...end.envelope, side: 'target' }), /evidenceHash/);

  const state = reset.envelope.projection;
  assert.equal(state.total, 1);
  assert.equal(state.flag, undefined, 'undeclared root keys are dropped');
  assert.equal(state.users[0].secret, undefined, 'undeclared keys are dropped with their values');
  assert.deepEqual(Object.keys(state.users[0]).sort(), ['email', 'id', 'name']);
  assert.deepEqual(state.users[0].name, { type: 'string' });
});

test('allowlisted paths only leave the harness and KEYED_EQUALITY becomes a keyed type-tagged HMAC', async () => {
  const root = await fixture({ 'state-probe.mjs': PROBE_SCRIPT });
  const store = new ArtifactStore(join(root, 'capture'));
  const config = configuration({ projections: [projection()], captures: [capture('state-end', 'SCENARIO_END')] });
  const first = await captureStateSnapshot(input(root, config, store));
  const second = await captureStateSnapshot(input(root, config, store, { runIndex: 1, runId: randomUUID() }));

  const email = first.envelope.projection.users[0].email;
  assert.match(email, /^string:[0-9a-f]{64}$/, 'KEYED_EQUALITY is a type-tagged HMAC-SHA256 hex');
  assert.equal(email, second.envelope.projection.users[0].email, 'equal inputs under one key produce equal digests');
  assert.notEqual(email.slice('string:'.length), sha256('person@example.test'), 'never a plain hash of the value');
  assert.notEqual(email.slice('string:'.length), sha256(canonical('person@example.test')));

  const bytes = await readFile(join(root, 'capture', first.evidencePath), 'utf8');
  for (const raw of ['person@example.test', 'Ana Souza', 'INTERNAL_FLAG', 'DROP_ME']) {
    assert.ok(!bytes.includes(raw), `${raw} must not appear in the artifact`);
    assert.ok(!JSON.stringify(first.envelope).includes(raw), `${raw} must not appear in the envelope`);
  }
  const changed = configuration({ projections: [projection()], captures: [capture('state-end', 'SCENARIO_END')],
    probeArgv: [process.execPath, 'state-probe.mjs', 'other@example.test'] });
  const otherValue = await captureStateSnapshot(input(root, changed, store, { runIndex: 2, runId: randomUUID() }));
  assert.notEqual(otherValue.envelope.projection.users[0].email, email, 'a different value produces a different digest');
  const otherKey = await captureStateSnapshot(input(root, config, store, { runIndex: 3, runId: randomUUID(),
    pseudonymizationKey: 'c'.repeat(64) }));
  assert.notEqual(otherKey.envelope.projection.users[0].email, email, 'the digest is keyed');
});

test('a failed, unparsable or oversized probe yields INCOMPLETE evidence without leaking raw bytes', async () => {
  const root = await fixture({
    'fail.mjs': `process.stdout.write(JSON.stringify({ rows: ['RAW_ROW_SECRET'] }));\nprocess.stderr.write('STDERR_SECRET');\nprocess.exitCode = 1;\n`,
    'invalid.mjs': `process.stdout.write('RAW_ROW_SECRET not json');\n`,
    'overflow.mjs': `process.stdout.write('RAW_ROW_SECRET' + 'x'.repeat(1048576 + 4096));\n`,
  });
  const store = new ArtifactStore(join(root, 'capture'));
  const cases = [
    { script: 'fail.mjs', reason: 'PROBE_FAILED' },
    { script: 'invalid.mjs', reason: 'PROBE_INVALID_OUTPUT' },
    { script: 'overflow.mjs', reason: 'PROBE_OUTPUT_LIMIT' },
  ];
  for (const [index, entry] of cases.entries()) {
    const config = configuration({ projections: [projection()], captures: [capture('state-end', 'SCENARIO_END')],
      probeArgv: [process.execPath, entry.script] });
    const result = await captureStateSnapshot(input(root, config, store, { runIndex: index, runId: randomUUID() }));
    assert.equal(result.envelope.completeness, 'INCOMPLETE', entry.reason);
    assert.equal(result.envelope.projection, null, 'no partial projection is ever persisted');
    assert.equal(result.reason, entry.reason);
    assert.deepEqual(result.envelope.settle, { status: 'NO_BARRIER' });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('RAW_ROW_SECRET'), entry.reason);
    assert.ok(!serialized.includes('STDERR_SECRET'), entry.reason);
    const bytes = await readFile(join(root, 'capture', result.evidencePath), 'utf8');
    assert.ok(!bytes.includes('RAW_ROW_SECRET'), entry.reason);
    assert.ok(!bytes.includes('STDERR_SECRET'), entry.reason);
    assert.equal(parseStateSnapshot(JSON.parse(bytes)).completeness, 'INCOMPLETE');
  }
  const snapshots = await readStateSnapshots(join(root, 'capture'));
  assert.equal(snapshots.length, cases.length);
  assert.ok(snapshots.every(item => item.completeness === 'INCOMPLETE' && item.projection === null));
});

test('a declared probe barrier settles on the marker and a timeout fails closed', async () => {
  const root = await fixture({ 'barrier.mjs': BARRIER_SCRIPT });
  const store = new ArtifactStore(join(root, 'capture'));
  const settle = { kind: 'PROBE_BARRIER', completedPath: '/marker', completedValue: 'ready',
    timeoutMs: 4000, pollIntervalMs: 40, maxAttempts: 60 };
  const common = { workspaceRoot: root, side: 'source', scenarioId: 'boot', captureId: 'state-end',
    checkpoint: 'SCENARIO_END', buildHash: BUILD_HASH, pseudonymizationKey: KEY, store };

  // The marker never appears: the declared bounds expire and the snapshot fails closed.
  const timedOut = await captureStateSnapshot({ ...common, runIndex: 0, runId: randomUUID(),
    config: configuration({ projections: [projection()],
      captures: [capture('state-end', 'SCENARIO_END', { ...settle, timeoutMs: 300, pollIntervalMs: 40, maxAttempts: 8 })],
      probeArgv: [process.execPath, 'barrier.mjs'] }) });
  assert.equal(timedOut.envelope.settle.status, 'TIMED_OUT');
  assert.equal(timedOut.envelope.completeness, 'INCOMPLETE');
  assert.equal(timedOut.envelope.projection, null);
  assert.equal(timedOut.reason, 'PROBE_SETTLE_TIMEOUT');

  // The marker appears while the barrier is polling: the settled probe's projection becomes evidence.
  const config = configuration({ projections: [projection()], captures: [capture('state-end', 'SCENARIO_END', settle)],
    probeArgv: [process.execPath, 'barrier.mjs'] });
  const pending = captureStateSnapshot({ ...common, config, runIndex: 1, runId: randomUUID() });
  const marker = setTimeout(() => { void writeFile(join(root, 'apps', 'source-app', 'ready.txt'), 'ok'); }, 150);
  const settled = await pending;
  clearTimeout(marker);
  assert.equal(settled.envelope.settle.status, 'SETTLED');
  assert.equal(settled.envelope.completeness, 'COMPLETE');
  assert.equal(settled.reason, undefined);
  assert.equal(settled.envelope.projection.marker, 'ready');
});

test('sanitized state projections drive source-stability execution hashes like traces do', () => {
  const trace = runIndex => ({ scenarioId: 'boot', runIndex, startedAt: '2026-09-05T00:00:00.000Z',
    environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' },
    sanitization: { version: 'test', appliedAt: '2026-09-05T00:00:01.000Z', redactionsCount: 0 },
    events: [
      { type: 'HTTP_REQUEST', eventId: 'request', sequenceIndex: 1, timestampMs: 1, correlationId: 'c1',
        method: 'GET', url: 'https://app.test/api/state', headers: {}, payload: null },
      { type: 'HTTP_RESPONSE', eventId: 'response', sequenceIndex: 2, timestampMs: 2, correlationId: 'c1',
        method: 'GET', url: 'https://app.test/api/state', headers: {}, statusCode: 200, body: { ok: true },
        requestToResponseEndMs: 1 },
    ] });
  const runs = [trace(1), trace(2)];
  const reset = { kind: 'ISOLATED_FIXTURES' };
  const captures = [{ id: 'state-end', projectionId: 'db-state', checkpoint: { kind: 'SCENARIO_END' }, required: true,
    bindings: { source: { commandId: 'probe-state' }, target: { commandId: 'probe-state' } } }];
  const key = stateEvidenceKey(captures[0]);
  assert.equal(key, 'state-end@SCENARIO_END');
  const first = { [key]: { total: 1 } };

  const stable = verifyStateSourceStability({ runs, requiredRuns: 2, reset, captures, stateRuns: [first, first] });
  assert.equal(stable.observations.status, 'STABLE');
  assert.equal(new Set(stable.observations.executionHashes).size, 1, 'identical state keeps the execution hash equal');
  const plain = verifySourceStability({ runs, requiredRuns: 2, reset });
  assert.equal(plain.observations.status, 'STABLE');
  assert.notEqual(stable.observations.executionHashes[0], plain.observations.executionHashes[0],
    'the sanitized projection participates in the execution hash');

  const changed = verifyStateSourceStability({ runs, requiredRuns: 2, reset, captures,
    stateRuns: [first, { [key]: { total: 2 } }] });
  assert.equal(changed.observations.status, 'UNSTABLE');
  assert.ok(changed.unstableCodes.includes('STATE_PROJECTION_DIVERGED'));
  assert.ok(changed.reviewPaths.includes(key));
  assert.notEqual(changed.observations.executionHashes[0], changed.observations.executionHashes[1],
    'differing state changes the execution hash');

  const missing = verifyStateSourceStability({ runs, requiredRuns: 2, reset, captures, stateRuns: [{}, {}] });
  assert.equal(missing.observations.status, 'NOT_COLLECTED');
  assert.ok(missing.unstableCodes.includes('STATE_EVIDENCE_MISSING'));

  const incomplete = verifyStateSourceStability({ runs, requiredRuns: 2, reset, captures,
    stateRuns: [{ [key]: null }, { [key]: null }] });
  assert.equal(incomplete.observations.status, 'UNSTABLE');
  assert.ok(incomplete.unstableCodes.includes('STATE_EVIDENCE_INCOMPLETE'));

  const untouched = verifyStateSourceStability({ runs, requiredRuns: 2, reset, captures: [], stateRuns: [] });
  assert.deepEqual(untouched, verifySourceStability({ runs, requiredRuns: 2, reset }),
    'without declared state vocabulary the trace-only result is untouched');
});

test('state vocabulary joins reference criteria only when declared and protects probe commands', async () => {
  const root = await referenceFixture();
  const time = '2026-09-29T12:00:00.000Z';
  const observations = { status: 'STABLE', runs: 2, executionHashes: [sha256('run-1'), sha256('run-2')] };
  const collect = (config, extra = {}) => collectMigrationReference(
    { config, workspaceRoot: root, createdAt: time, sourceObservations: observations, ...extra });
  const referenceFiles = { sourceFiles: ['src/page.ts', 'package.json'], targetFiles: ['src/page.tsx', 'package.json'],
    writePaths: ['src/page.tsx'], protectedPaths: ['src/auth'] };
  const claim = { kind: 'STATE_FIELD', captureId: 'state-end', path: '/users/1/email',
    predicate: { kind: 'EQUALS', value: 'person@example.test' } };
  const state = { captures: [capture('state-end', 'SCENARIO_END')], projections: [projection()], stateClaim: claim };
  const criterionKeys = ['acceptedDifferences', 'checks', 'environmentHash', 'limitsHash', 'policyHash',
    'requirements', 'scenarios'];

  const plain = configuration(referenceFiles);
  const baseline = await collect(plain);
  assert.equal(baseline.criteria.scenarios[0].semanticHash,
    sha256(canonical(scenarioSemanticProjection(plain.scenarios[0].definition))),
    'a configuration without state fields keeps its historical criteria digest');
  assert.equal(baseline.criteria.requirements[0].digest,
    sha256(canonical({ description: 'The state is saved', origin: 'SPECIFICATION', sourceReference: 'SPEC.md', assertion: null })));
  assert.deepEqual(Object.keys(baseline.criteria).sort(), criterionKeys, 'no criteria key appears for absent state fields');
  assert.equal(migrationReferenceHash(await collect(plain)), migrationReferenceHash(baseline), 'collection stays deterministic');

  const declared = configuration({ ...referenceFiles, ...state });
  const withState = await collect(declared);
  assert.notEqual(withState.criteria.scenarios[0].semanticHash, baseline.criteria.scenarios[0].semanticHash,
    'stateCaptures and their probes join the scenario digest');
  assert.notEqual(withState.criteria.requirements[0].digest, baseline.criteria.requirements[0].digest,
    'stateClaim joins the requirement digest only when declared');
  assert.deepEqual(Object.keys(withState.criteria).sort(), criterionKeys,
    'state vocabulary is digested into the historical criteria slots');
  assert.equal(migrationReferenceHash(await collect(declared)), migrationReferenceHash(withState));
  // Declaring state on an existing scenario is a criteria change the owner must decide.
  await assert.rejects(collect(declared, { previous: baseline }), ReferenceWeakeningError);

  const reprobe = configuration({ ...referenceFiles, ...state, probeArgv: [process.execPath, 'state-probe.mjs', '--v2'] });
  const changedProbe = await collect(reprobe);
  assert.notEqual(changedProbe.criteria.scenarios[0].semanticHash, withState.criteria.scenarios[0].semanticHash,
    'the probe command is a protected evaluation input');
  await assert.rejects(collect(reprobe, { previous: withState }), ReferenceWeakeningError,
    'changing a probe command after reference creation needs an owner decision');

  // A STATE_DIVERGENCE accepted difference digests by tolerated location and owner decision.
  const divergence = ownerDecisionReference => ({ code: 'STATE_DIVERGENCE', scenarioId: 'boot', captureId: 'state-end',
    path: '/users/1', resolution: { sourcePredicate: { kind: 'KEYED_EQUAL', path: '/users/1' },
      requiredStateClaimIds: ['saved'], ownerDecisionReference } });
  const divergent = configuration({ ...referenceFiles, ...state, acceptedDifferences: [divergence('REVIEWS.md#state')] });
  const withDivergence = await collect(divergent);
  const entry = withDivergence.criteria.acceptedDifferences[0];
  assert.match(entry.id, /^state-[0-9a-f]{40}$/, 'state entries get a stable derived criteria id');
  assert.equal(entry.scenarioId, 'boot');
  const redecided = configuration({ ...referenceFiles, ...state,
    acceptedDifferences: [divergence('REVIEWS.md#state-again')] });
  const decidedAgain = await collect(redecided);
  assert.equal(decidedAgain.criteria.acceptedDifferences[0].id, entry.id, 'identity does not move with the decision');
  assert.notEqual(decidedAgain.criteria.acceptedDifferences[0].digest, entry.digest,
    're-deciding the tolerated divergence changes its criteria digest');
});

test('pinned source state evidence re-verifies clean against fresh snapshots', async () => {
  const root = await fixture({ 'state-probe.mjs': PROBE_SCRIPT });
  const config = configuration({ projections: [projection()],
    captures: [capture('state-reset', 'AFTER_RESET'), capture('state-end', 'SCENARIO_END')] });
  const captureIds = [['state-reset', 'AFTER_RESET'], ['state-end', 'SCENARIO_END']];
  const preparedBase = join(root, 'prepared');
  const preparedStore = new ArtifactStore(join(preparedBase, 'capture'));
  const pinned = [];
  for (const runIndex of [0, 1]) {
    const { state } = await captureRun(root, config, preparedStore, runIndex, captureIds);
    const built = stateEvidencePins(state);
    assert.equal(built.incomplete, false, 'every COMPLETE snapshot becomes a pin');
    assert.equal(built.pins.length, captureIds.length);
    assert.ok(built.pins.every(pin => pin.completeness === 'COMPLETE' && pin.path.startsWith('capture/artifacts/units/')),
      'pins live alongside the traces, under the prepared capture root');
    // Verification re-reads the pinned originals from the prepared artifact, exactly like the traces.
    for (const pin of built.pins) pinned.push({ runIndex, envelope: await readStateSnapshot(preparedBase, pin.path) });
  }

  const freshStore = new ArtifactStore(join(root, 'fresh'));
  const freshRecords = [];
  for (const runIndex of [0, 1]) {
    const { state } = await captureRun(root, config, freshStore, runIndex, captureIds);
    freshRecords.push({ runIndex, state });
  }
  const check = await compareSourceStateEvidence({ config, scenarioId: 'boot', pinned, freshRecords,
    captureRoot: freshStore.root });
  assert.deepEqual(check, { stale: false, incomplete: false }, 'identical source state verifies clean');
  // Independent captures mint new envelope identities: equality is over the projection, never the run id.
  assert.notEqual(freshRecords[0].state[0].evidenceHash, pinned[0].envelope.evidenceHash);
  assert.equal(freshRecords[0].state[0].projectionFingerprint, pinned[0].envelope.projectionFingerprint);
});

test('source state that changes after preparation is refused as stale evidence', async () => {
  const root = await fixture({ 'state-probe.mjs': PROBE_SCRIPT });
  const captureIds = [['state-end', 'SCENARIO_END']];
  const config = configuration({ projections: [projection()], captures: [capture('state-end', 'SCENARIO_END')] });
  const preparedBase = join(root, 'prepared');
  const preparedStore = new ArtifactStore(join(preparedBase, 'capture'));
  const pinned = [];
  for (const runIndex of [0, 1]) {
    const { state } = await captureRun(root, config, preparedStore, runIndex, captureIds);
    assert.equal(stateEvidencePins(state).incomplete, false);
    for (const pin of stateEvidencePins(state).pins) pinned.push({ runIndex, envelope: await readStateSnapshot(preparedBase, pin.path) });
  }

  // The verified run observes different domain state than the prepared reference recorded.
  const freshStore = new ArtifactStore(join(root, 'fresh'));
  const changed = configuration({ projections: [projection()], captures: [capture('state-end', 'SCENARIO_END')],
    probeArgv: [process.execPath, 'state-probe.mjs', 'other@example.test'] });
  const freshRecords = [];
  for (const runIndex of [0, 1]) {
    const { state } = await captureRun(root, changed, freshStore, runIndex, captureIds);
    freshRecords.push({ runIndex, state });
  }
  const stale = await compareSourceStateEvidence({ config, scenarioId: 'boot', pinned, freshRecords,
    captureRoot: freshStore.root });
  assert.deepEqual(stale, { stale: true, incomplete: false }, 'changed source state is stale evidence');

  // Missing fresh state is INCONCLUSIVE material for the scenario, never a pass.
  const absent = await compareSourceStateEvidence({ config, scenarioId: 'boot', pinned,
    freshRecords: [{ runIndex: 0, state: [] }, { runIndex: 1, state: [] }], captureRoot: freshStore.root });
  assert.deepEqual(absent, { stale: false, incomplete: true });

  // A declared capture with no pinned original is unverifiable, never silently clean.
  const unpinned = await compareSourceStateEvidence({ config, scenarioId: 'boot', pinned: [], freshRecords,
    captureRoot: freshStore.root });
  assert.equal(unpinned.stale, true, 'fresh state without a prepared pin cannot verify');
});

test('a preparation without state vocabulary keeps its historical byte shape', async () => {
  // The pin builder contributes nothing when a record declares no state captures.
  assert.deepEqual(stateEvidencePins(undefined), { pins: [], incomplete: false });
  assert.deepEqual(stateEvidencePins([]), { pins: [], incomplete: false });

  // A historical preparation document round-trips unchanged: no `state` key appears anywhere.
  const root = await referenceFixture();
  const time = '2026-09-29T12:00:00.000Z';
  const observations = { status: 'STABLE', runs: 2, executionHashes: [sha256('run-1'), sha256('run-2')] };
  const reference = await collectMigrationReference({ config: configuration({
    sourceFiles: ['src/page.ts', 'package.json'], targetFiles: ['src/page.tsx', 'package.json'],
    writePaths: ['src/page.tsx'], protectedPaths: ['src/auth'] }),
  workspaceRoot: root, createdAt: time, sourceObservations: observations });
  const historical = {
    kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS',
    reference, referenceHash: migrationReferenceHash(reference),
    artifactPath: 'migrations/state-capture/prepared', keyId: sha256('key'),
    sourceEvidence: [{ scenarioId: 'boot', runIndex: 0, runId: 'trace-run-1', traceHash: sha256('trace'),
      path: 'capture/artifacts/units/state-unit/boot/source/0.sanitized.json' }],
  };
  const parsed = parseMigrationPreparation(historical);
  assert.deepEqual(parsed, historical, 'the historical preparation keeps its byte shape');
  assert.equal('state' in parsed.sourceEvidence[0], false);

  // The schema delta adds exactly one optional field: the pinned snapshot identities.
  const withPins = { ...historical, sourceEvidence: [{ ...historical.sourceEvidence[0],
    state: [{ captureId: 'state-end', checkpoint: 'SCENARIO_END', evidenceHash: sha256('evidence'),
      projectionFingerprint: sha256('projection'), completeness: 'COMPLETE',
      path: 'capture/artifacts/units/state-unit/boot/source/state/0.state-end.SCENARIO_END.state.json' }] }] };
  assert.equal(parseMigrationPreparation(withPins).sourceEvidence[0].state.length, 1);

  // Without declared state captures the verification seam is a no-op.
  const check = await compareSourceStateEvidence({ config: configuration(), scenarioId: 'boot',
    pinned: [], freshRecords: [], captureRoot: root });
  assert.deepEqual(check, { stale: false, incomplete: false });
});
