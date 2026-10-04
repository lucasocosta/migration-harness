import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EquivalenceValidator, comparableProjection, discloseMockedCoverage, evaluateUnitAssertions,
  executionHash, migrationComparisonPolicy, verifySourceStability,
} from '../packages/engine/dist/equivalence/index.js';
import { parseUnitAssertion, ScenarioVerificationSchema, SourceObservationsSchema } from '../packages/core/dist/index.js';
import { adaptLegacyComparison } from '../packages/engine/dist/quality-gates/migration-report.js';
import { event } from './helpers.mjs';

const validator = new EquivalenceValidator();
const hash = 'a'.repeat(64);
const identity = { migrationId: 'customer', configurationHash: hash, referenceHash: hash, candidateHash: hash, buildHash: hash };
const mocks = [{ urlPattern: '**/api/customers/123', method: 'GET', statusCode: 200 }];
const reset = { kind: 'ISOLATED_FIXTURES' };

function trace(options = {}) {
  const { write = { name: 'ANA' }, readBack = { name: 'ANA' }, initialMock = false, readBackFrom = 'integrated', readAfterWrite = true, storageValue = 'yes' } = options;
  const value = { scenarioId: 'update-customer', runIndex: options.runIndex ?? 1, startedAt: '2026-09-05T00:00:00.000Z',
    environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' },
    sanitization: { version: 'test', appliedAt: '2026-09-05T00:00:01.000Z', redactionsCount: 0 }, events: [] };
  if (initialMock) {
    // A declared fixture answers the initial load: mocked coverage, not persistence evidence.
    event(value, 'HTTP_REQUEST', { correlationId: 'm1', method: 'GET', url: 'https://app.test/api/customers/123', headers: {}, payload: null });
    event(value, 'HTTP_RESPONSE', { correlationId: 'm1', method: 'GET', url: 'https://app.test/api/customers/123', headers: {}, statusCode: 200, body: { name: 'FIXTURE' }, requestToResponseEndMs: 1 });
  }
  event(value, 'USER_INTERACTION', { stepId: 'save', action: 'click', targetAriaRole: 'button', targetAriaName: 'Salvar' });
  event(value, 'HTTP_REQUEST', { correlationId: 'w1', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {}, payload: write });
  event(value, 'HTTP_RESPONSE', { correlationId: 'w1', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {}, statusCode: 204, body: null, requestToResponseEndMs: 1 });
  if (readAfterWrite) {
    const url = readBackFrom === 'mocked' ? 'https://app.test/api/customers/123' : 'https://app.test/api/clientes/123';
    event(value, 'HTTP_REQUEST', { correlationId: 'r1', method: 'GET', url, headers: {}, payload: null });
    event(value, 'HTTP_RESPONSE', { correlationId: 'r1', method: 'GET', url, headers: {}, statusCode: 200, body: readBack, requestToResponseEndMs: 1 });
  }
  if (storageValue) event(value, 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'SET', key: 'saved', previousValue: null, newValue: storageValue });
  return value;
}
const readBackAssertion = {
  id: 'persists-name', required: true, checkpoint: { kind: 'AFTER_STEP', stepId: 'save' },
  claim: { kind: 'READ_BACK', writeMethod: 'PUT', writePathPattern: '/api/customers/*', readPathPattern: '/api/**', fields: [{ payloadField: 'name', responseField: 'name' }] },
};
const outcomeOf = (source, target, assertion, extra = {}) => evaluateUnitAssertions({ source, target, assertions: [assertion], ...extra })
  .outcomes.find(item => item.side === 'target');

test('persistence needs a read-back, and a correct request alone does not prove it', () => {
  assert.deepEqual(parseUnitAssertion(readBackAssertion), readBackAssertion);
  assert.equal(outcomeOf(trace(), trace(), readBackAssertion).status, 'SATISFIED');
  assert.equal(outcomeOf(trace(), trace({ readBack: { name: 'OTHER' } }), readBackAssertion).reason, 'READ_BACK_VALUE_DIFFERS');
  assert.equal(outcomeOf(trace(), trace({ readBack: { other: 'ANA' } }), readBackAssertion).reason, 'READ_BACK_VALUE_DIFFERS');
  assert.equal(outcomeOf(trace(), trace({ readAfterWrite: false }), readBackAssertion).reason, 'READ_BACK_MISSING');
  const noWrite = trace({ readAfterWrite: true }); noWrite.events = noWrite.events.filter(item => item.correlationId !== 'w1');
  assert.equal(outcomeOf(trace(), noWrite, readBackAssertion).reason, 'WRITE_MISSING');
  const result = validator.validate({ source: trace(), target: trace({ readBack: { name: 'OTHER' } }), assertions: [readBackAssertion] });
  assert.equal(result.status, 'NOT_EQUIVALENT');
  const divergence = result.divergences.find(item => item.code === 'UNIT_ASSERTION_VIOLATED');
  assert.deepEqual(divergence.target, { assertionId: 'persists-name', reason: 'READ_BACK_VALUE_DIFFERS' });
  assert.ok(!JSON.stringify(result).includes('ANA') && !JSON.stringify(result).includes('OTHER'));
});

test('a read served by a declared mock cannot establish persistence', () => {
  const mockedReadBack = () => trace({ initialMock: true, readBackFrom: 'mocked' });
  const mocked = outcomeOf(mockedReadBack(), mockedReadBack(), readBackAssertion, { mocks });
  assert.equal(mocked.status, 'NOT_EVALUABLE');
  assert.equal(mocked.reason, 'READ_BACK_MOCKED');
  const result = validator.validate({ source: mockedReadBack(), target: mockedReadBack(), assertions: [readBackAssertion], mocks });
  assert.equal(result.status, 'NOT_EQUIVALENT');
  assert.equal(result.divergences.find(item => item.code === 'UNIT_ASSERTION_NOT_EVALUABLE').severity, 'BLOCKING');
  assert.equal(adaptLegacyComparison(result, identity).status, 'INCONCLUSIVE');
  // Without the mock declaration the same evidence would look like proof; declaring it is what protects us.
  assert.equal(outcomeOf(mockedReadBack(), mockedReadBack(), readBackAssertion).status, 'SATISFIED');
  // An integrated read alongside a mocked initial load still proves persistence.
  assert.equal(outcomeOf(trace(), trace({ initialMock: true }), readBackAssertion, { mocks }).status, 'SATISFIED');
});

test('mocked coverage is disclosed without blocking and survives into the report', () => {
  assert.deepEqual(discloseMockedCoverage(trace(), mocks), []);
  assert.deepEqual(discloseMockedCoverage(trace({ initialMock: true }), []), []);
  const disclosure = discloseMockedCoverage(trace({ initialMock: true }), mocks);
  assert.equal(disclosure[0].severity, 'INFORMATIONAL');
  assert.deepEqual(disclosure[0].target, { mockedResponses: 1, declaredMocks: 1 });
  const result = validator.validate({ source: trace({ initialMock: true }), target: trace({ initialMock: true }), mocks });
  assert.equal(result.status, 'EQUIVALENT');
  assert.ok(result.divergences.some(item => item.code === 'MOCKED_COVERAGE'));
  const verification = adaptLegacyComparison(result, identity);
  assert.ok(verification.diagnostics.some(item => item.code === 'MOCKED_COVERAGE'));
  assert.ok(!verification.diagnostics.some(item => item.code === 'LEGACY_WARNING'));
  // A disclosure may accompany a pass; any other diagnostic still contradicts one.
  const passing = diagnostics => ScenarioVerificationSchema.parse({ identity, scenarioId: 'update-customer', status: 'PASS', requirements: [], evidencePaths: [], diagnostics });
  assert.equal(passing([{ code: 'MOCKED_COVERAGE', scenarioId: 'update-customer' }]).status, 'PASS');
  assert.throws(() => passing([{ code: 'EXECUTION_INCOMPLETE', scenarioId: 'update-customer' }]));
});

test('source repeatability is verified under a declared reset, never assumed', () => {
  const policy = migrationComparisonPolicy({});
  const runs = [trace({ runIndex: 1 }), trace({ runIndex: 2 }), trace({ runIndex: 3 })];
  const stable = verifySourceStability({ runs, requiredRuns: 3, reset, policy });
  assert.equal(stable.observations.status, 'STABLE');
  assert.equal(stable.observations.runs, 3);
  assert.equal(stable.observations.executionHashes.length, 3);
  assert.equal(new Set(stable.observations.executionHashes).size, 1);
  assert.deepEqual(SourceObservationsSchema.parse(stable.observations), stable.observations);
  assert.deepEqual(stable.unstableCodes, []);
  assert.equal(stable.resetKind, 'ISOLATED_FIXTURES');
  // Timing and identifiers differ between runs without making the source unstable.
  const later = trace({ runIndex: 4 });
  for (const item of later.events) item.timestampMs += 500;
  assert.equal(executionHash(later, policy), executionHash(runs[0], policy));

  const unstable = verifySourceStability({ runs: [runs[0], trace({ runIndex: 2, write: { name: 'DIFFERENT' } })], requiredRuns: 2, reset, policy });
  assert.equal(unstable.observations.status, 'UNSTABLE');
  assert.ok(unstable.unstableCodes.includes('NETWORK_PAYLOAD_VALUE_MISMATCH'));
  assert.ok(unstable.reviewPaths.some(item => item.includes('payload.name')));
  // The harness reports what moved; it never declares a field volatile on its own.
  assert.ok(!JSON.stringify(unstable).includes('DIFFERENT'));
  assert.ok(!('volatilePayloadFields' in unstable));
  const declared = verifySourceStability({ runs: [runs[0], trace({ runIndex: 2, write: { name: 'DIFFERENT' } })], requiredRuns: 2, reset,
    policy: migrationComparisonPolicy({ network: { volatilePayloadFields: ['name'] } }) });
  assert.equal(declared.observations.status, 'STABLE');

  const insufficient = verifySourceStability({ runs: [runs[0]], requiredRuns: 3, reset, policy });
  assert.equal(insufficient.observations.status, 'NOT_COLLECTED');
  assert.equal(insufficient.observedRuns, 1);
  assert.throws(() => verifySourceStability({ runs, requiredRuns: 1, reset, policy }), /at least two/);
  const other = trace({ runIndex: 2 }); other.scenarioId = 'other-scenario';
  assert.throws(() => verifySourceStability({ runs: [runs[0], other], requiredRuns: 2, reset, policy }), /one scenario/);
  assert.notEqual(canonicalOf(comparableProjection(runs[0], policy)), canonicalOf(comparableProjection(trace({ storageValue: 'no' }), policy)));
});

const canonicalOf = value => JSON.stringify(value);
