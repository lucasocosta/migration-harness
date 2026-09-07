import test from 'node:test';
import assert from 'node:assert/strict';
import { EquivalenceValidator, evaluateUnitAssertions } from '../packages/equivalence-validator/dist/index.js';
import { parseUnitAssertion, parseMigrationConfig, migrationConfigHash, unitAssertionsForScenario } from '../packages/core/dist/index.js';
import { adaptLegacyComparison, assertionRequirementStatuses } from '../packages/quality-gates/dist/migration-report.js';
import { event } from './helpers.mjs';

const validator = new EquivalenceValidator();
const hash = 'a'.repeat(64);
const identity = { migrationId: 'customer', configurationHash: hash, referenceHash: hash, candidateHash: hash, buildHash: hash };
const compare = (source, target, assertions, policy) => validator.validate({ source, target, ...(assertions ? { assertions } : {}), ...(policy ? { policy } : {}) });
const codes = result => result.divergences.map(item => item.code);
const outcome = (source, target, assertion) => evaluateUnitAssertions({ source, target, assertions: [assertion] });

function unitTree({ alert, invalid = false, disabled = false, value = 'ANA-SECRET', shell = 'SHELL-SOURCE', unitName = 'Editar cliente' } = {}) {
  return { role: 'generic', children: [
    { role: 'banner', children: [{ role: 'text', text: shell }] },
    { role: 'form', name: unitName, children: [
      { role: 'textbox', name: 'Nome', text: value, ...(invalid ? { invalid: true } : {}) },
      ...(alert ? [{ role: 'alert', children: [{ role: 'text', text: alert }] }] : []),
      { role: 'button', name: 'Salvar', ...(disabled ? { disabled: true } : {}) },
    ] },
  ] };
}
function run(options = {}) {
  const { submitted = true, payload = { name: 'ANA-SECRET' }, storage = false, navigated = false, emptyCapture = false, secondStep = false } = options;
  const trace = { scenarioId: 'update-customer', runIndex: 1, startedAt: '2026-09-05T00:00:00.000Z',
    environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' },
    sanitization: { version: 'test', appliedAt: '2026-09-05T00:00:01.000Z', redactionsCount: 0 }, events: [] };
  const tree = emptyCapture ? {} : unitTree(options);
  event(trace, 'USER_INTERACTION', { stepId: 'fill-name', action: 'fill', targetAriaRole: 'textbox', targetAriaName: 'Nome', inputValue: 'ANA-SECRET' });
  event(trace, 'ARIA_STATE_CHANGE', { triggerEventId: 'event-1', rawYamlTree: '', jsonTree: tree });
  event(trace, 'USER_INTERACTION', { stepId: 'save', action: 'click', targetAriaRole: 'button', targetAriaName: 'Salvar' });
  if (submitted) {
    event(trace, 'HTTP_REQUEST', { correlationId: 'c1', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {}, payload });
    event(trace, 'HTTP_RESPONSE', { correlationId: 'c1', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {}, statusCode: 204, body: null, requestToResponseEndMs: 1 });
  }
  if (storage) event(trace, 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'SET', key: 'saved', previousValue: null, newValue: 'yes' });
  if (navigated) event(trace, 'NAVIGATION', { fromUrl: 'https://app.test/customers/123', toUrl: 'https://app.test/customers?ok=1' });
  event(trace, 'ARIA_STATE_CHANGE', { triggerEventId: 'event-3', rawYamlTree: '', jsonTree: tree });
  if (secondStep) {
    event(trace, 'USER_INTERACTION', { stepId: 'retry', action: 'click', targetAriaRole: 'button', targetAriaName: 'Salvar' });
    event(trace, 'HTTP_REQUEST', { correlationId: 'c2', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {}, payload });
    event(trace, 'HTTP_RESPONSE', { correlationId: 'c2', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {}, statusCode: 204, body: null, requestToResponseEndMs: 1 });
  }
  event(trace, 'ARIA_STATE_CHANGE', { triggerEventId: 'scenario_completed', rawYamlTree: '', jsonTree: tree });
  return trace;
}
const scope = { role: 'form', name: 'Editar cliente' };
const saveStep = { kind: 'AFTER_STEP', stepId: 'save' };
const errorAssertion = {
  id: 'shows-error', required: true, checkpoint: saveStep, scope,
  claim: { kind: 'NODE_PRESENT', role: 'alert', text: 'Nome e obrigatorio', textMatch: 'CONTAINS' },
};

test('a required unit assertion blocks on its own authority, inside the unit scope only', () => {
  const withError = () => run({ alert: 'Nome e obrigatorio', submitted: false });
  assert.equal(compare(withError(), withError(), [errorAssertion]).status, 'EQUIVALENT');
  const missing = compare(withError(), run({ submitted: false }), [errorAssertion]);
  assert.equal(missing.status, 'NOT_EQUIVALENT');
  const divergence = missing.divergences.find(item => item.code === 'UNIT_ASSERTION_VIOLATED');
  assert.equal(divergence.severity, 'BLOCKING');
  assert.deepEqual(divergence.target, { assertionId: 'shows-error', reason: 'NODE_MISSING', role: 'alert' });
  assert.equal(divergence.source, undefined);
  // The global ARIA dimension stays a warning; the required assertion is what blocks.
  assert.equal(missing.divergences.find(item => item.code === 'ARIA_SEMANTICS_MISMATCH').severity, 'WARNING');
  const shell = run({ alert: 'Nome e obrigatorio', submitted: false, shell: 'SHELL-TARGET' });
  assert.equal(compare(withError(), shell, [errorAssertion]).status, 'EQUIVALENT');
  const advisory = compare(withError(), run({ submitted: false }), [{ ...errorAssertion, required: false }]);
  assert.equal(advisory.status, 'EQUIVALENT');
  assert.equal(advisory.divergences.find(item => item.code === 'UNIT_ASSERTION_VIOLATED').severity, 'WARNING');
});

test('field values, invalid and busy states are asserted at a checkpoint', () => {
  const declared = (claim, checkpoint = saveStep) => ({ id: 'state', required: true, checkpoint, scope, claim });
  const source = run({ value: 'ANA-SECRET', invalid: true, disabled: true, submitted: false });
  const same = () => run({ value: 'ANA-SECRET', invalid: true, disabled: true, submitted: false });
  for (const [claim, reason, target] of [
    [{ kind: 'NODE_PRESENT', role: 'textbox', name: 'Nome', text: 'ANA-SECRET' }, 'NODE_TEXT_DIFFERS', run({ value: 'OTHER-VALUE', invalid: true, disabled: true, submitted: false })],
    [{ kind: 'NODE_PRESENT', role: 'textbox', name: 'Nome', state: { invalid: true } }, 'NODE_STATE_DIFFERS', run({ value: 'ANA-SECRET', disabled: true, submitted: false })],
    [{ kind: 'NODE_PRESENT', role: 'button', name: 'Salvar', state: { disabled: true } }, 'NODE_STATE_DIFFERS', run({ value: 'ANA-SECRET', invalid: true, submitted: false })],
    [{ kind: 'NODE_PRESENT', role: 'textbox', name: 'Sobrenome' }, 'NODE_MISSING', same()],
    [{ kind: 'NODE_ABSENT', role: 'button', name: 'Salvar' }, 'NODE_PRESENT_UNEXPECTED', same()],
  ]) {
    const assertion = declared(claim);
    assert.equal(outcome(source, same(), assertion).outcomes.filter(item => item.status === 'SATISFIED').length, claim.kind === 'NODE_ABSENT' || claim.name === 'Sobrenome' ? 0 : 2, reason);
    const failing = outcome(source, target, assertion).outcomes.find(item => item.side === 'target');
    assert.equal(failing.status, 'VIOLATED', reason);
    assert.equal(failing.reason, reason);
  }
  const enabled = declared({ kind: 'NODE_PRESENT', role: 'button', name: 'Salvar', state: { disabled: false } });
  assert.equal(outcome(run({ submitted: false }), run({ submitted: false }), enabled).outcomes.every(item => item.status === 'SATISFIED'), true);
  const atFill = declared({ kind: 'NODE_PRESENT', role: 'alert' }, { kind: 'AFTER_STEP', stepId: 'fill-name' });
  assert.equal(outcome(run({ submitted: false }), run({ alert: 'x', submitted: false }), atFill).outcomes.find(item => item.side === 'target').status, 'SATISFIED');
});

test('forbidden and required submissions are scoped to their checkpoint window', () => {
  const forbidden = { id: 'no-invalid-submit', required: true, checkpoint: saveStep, claim: { kind: 'NO_REQUEST', method: 'PUT', pathPattern: '/api/customers/*' } };
  const validating = run({ alert: 'Nome e obrigatorio', submitted: false });
  assert.equal(compare(validating, run({ submitted: false }), [forbidden]).status, 'EQUIVALENT');
  const submitting = compare(validating, run({ submitted: true }), [forbidden]);
  assert.equal(submitting.status, 'NOT_EQUIVALENT');
  assert.equal(submitting.divergences.find(item => item.code === 'UNIT_ASSERTION_VIOLATED').target.reason, 'REQUEST_OBSERVED_UNEXPECTED');
  // A later legitimate submission belongs to its own step, not to this checkpoint.
  const laterOnly = run({ submitted: false, secondStep: true });
  assert.equal(outcome(validating, laterOnly, forbidden).outcomes.find(item => item.side === 'target').status, 'SATISFIED');

  const saves = { id: 'saves-name', required: true, checkpoint: saveStep, claim: { kind: 'REQUEST_OBSERVED', method: 'PUT', pathPattern: '/api/customers/*', requiredPayloadFields: ['name'] } };
  assert.equal(outcome(run(), run(), saves).outcomes.every(item => item.status === 'SATISFIED'), true);
  assert.equal(outcome(run(), run({ payload: { nome: 'ANA-SECRET' } }), saves).outcomes.find(item => item.side === 'target').reason, 'PAYLOAD_FIELD_MISSING');
  assert.equal(outcome(run(), run({ submitted: false }), saves).outcomes.find(item => item.side === 'target').reason, 'REQUEST_MISSING');
  const nested = { ...saves, claim: { ...saves.claim, requiredPayloadFields: ['customer.name'] } };
  assert.equal(outcome(run({ payload: { customer: { name: 'x' } } }), run({ payload: { customer: { name: 'y' } } }), nested).outcomes.every(item => item.status === 'SATISFIED'), true);
});

test('storage and navigation assertions cover observable callback effects', () => {
  const stored = { id: 'marks-saved', required: true, checkpoint: saveStep, claim: { kind: 'STORAGE_MUTATION', storageType: 'localStorage', key: 'saved', mutationType: 'SET', valuePattern: '^yes$' } };
  assert.equal(outcome(run({ storage: true }), run({ storage: true }), stored).outcomes.every(item => item.status === 'SATISFIED'), true);
  assert.equal(outcome(run({ storage: true }), run(), stored).outcomes.find(item => item.side === 'target').reason, 'STORAGE_MUTATION_MISSING');
  const navigated = { id: 'returns-to-list', required: true, checkpoint: saveStep, claim: { kind: 'NAVIGATED', pathPattern: '/customers*' } };
  assert.equal(outcome(run({ navigated: true }), run({ navigated: true }), navigated).outcomes.every(item => item.status === 'SATISFIED'), true);
  assert.equal(outcome(run({ navigated: true }), run(), navigated).outcomes.find(item => item.side === 'target').reason, 'NAVIGATION_MISSING');
});

test('missing evidence, an empty capture and a lost unit scope are not evaluable', () => {
  for (const [assertion, reason] of [
    [{ ...errorAssertion, checkpoint: { kind: 'AFTER_STEP', stepId: 'absent-step' } }, 'CHECKPOINT_MISSING'],
    [{ ...errorAssertion, scope: { role: 'form', name: 'Outro formulario' } }, 'SCOPE_NOT_FOUND'],
  ]) {
    const result = compare(run({ alert: 'Nome e obrigatorio', submitted: false }), run({ alert: 'Nome e obrigatorio', submitted: false }), [assertion]);
    const divergence = result.divergences.find(item => item.code === 'UNIT_ASSERTION_NOT_EVALUABLE');
    assert.equal(divergence.severity, 'BLOCKING', reason);
    assert.equal(divergence.target.reason, reason);
    assert.equal(result.status, 'NOT_EQUIVALENT');
    const adapted = adaptLegacyComparison(result, identity);
    assert.equal(adapted.status, 'INCONCLUSIVE', reason);
    assert.ok(adapted.diagnostics.some(item => item.code === 'EXECUTION_INCOMPLETE'));
  }
  const empty = outcome(run({ alert: 'Nome e obrigatorio', submitted: false }), run({ emptyCapture: true, submitted: false }), errorAssertion);
  assert.equal(empty.outcomes.find(item => item.side === 'target').reason, 'CAPTURE_EMPTY');
  const window = outcome(run(), run(), { id: 'x', required: true, checkpoint: { kind: 'AFTER_STEP', stepId: 'never' }, claim: { kind: 'NO_REQUEST', pathPattern: '/api/**' } });
  assert.equal(window.outcomes.find(item => item.side === 'target').reason, 'CHECKPOINT_MISSING');
});

test('a requirement the source does not meet is disclosed, and outcomes map to requirement statuses', () => {
  const result = compare(run({ submitted: false }), run({ alert: 'Nome e obrigatorio', submitted: false }), [errorAssertion]);
  assert.equal(result.status, 'EQUIVALENT');
  const disclosure = result.divergences.find(item => item.code === 'UNIT_ASSERTION_SOURCE_UNSATISFIED');
  assert.equal(disclosure.severity, 'INFORMATIONAL');
  assert.deepEqual(disclosure.source, { assertionId: 'shows-error', reason: 'NODE_MISSING', role: 'alert' });
  const serialized = JSON.stringify(compare(run({ submitted: false }), run({ value: 'OTHER-VALUE', submitted: false }), [
    { id: 'field-value', required: true, checkpoint: saveStep, scope, claim: { kind: 'NODE_PRESENT', role: 'textbox', name: 'Nome', text: 'ANA-SECRET' } },
  ]));
  for (const observed of ['ANA-SECRET', 'OTHER-VALUE', 'SHELL-SOURCE']) assert.ok(!serialized.includes(observed), observed);

  const evaluation = evaluateUnitAssertions({
    source: run({ alert: 'Nome e obrigatorio', submitted: false }), target: run({ submitted: false }),
    assertions: [errorAssertion, { ...errorAssertion, id: 'other-error', checkpoint: { kind: 'AFTER_STEP', stepId: 'absent' } }],
  });
  assert.deepEqual(assertionRequirementStatuses(evaluation.outcomes), [
    { requirementId: 'shows-error', status: 'FAIL' }, { requirementId: 'other-error', status: 'INCONCLUSIVE' },
  ]);
  assert.deepEqual(assertionRequirementStatuses(outcome(run({ alert: 'a', submitted: false }), run({ alert: 'a', submitted: false }),
    { ...errorAssertion, claim: { kind: 'NODE_PRESENT', role: 'alert' } }).outcomes), [{ requirementId: 'shows-error', status: 'PASS' }]);
  assert.throws(() => evaluateUnitAssertions({ source: run(), target: run(), assertions: [errorAssertion, errorAssertion] }), /Duplicate unit assertion/);
});

test('assertion declarations are strict and belong to the configuration criteria', () => {
  assert.deepEqual(parseUnitAssertion(errorAssertion), errorAssertion);
  for (const invalid of [
    { ...errorAssertion, claim: { kind: 'UNKNOWN' } },
    { ...errorAssertion, claim: { kind: 'NODE_PRESENT', role: 'invented-role' } },
    { ...errorAssertion, claim: { ...errorAssertion.claim, unexpected: 1 } },
    { ...errorAssertion, checkpoint: { kind: 'AFTER_STEP' } },
    { ...errorAssertion, scope: { name: 'no role' } },
    { ...errorAssertion, id: 'invalid id' },
  ]) assert.throws(() => parseUnitAssertion(invalid));

  const config = () => ({
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'customer',
    source: { root: 'apps/angular', baseUrl: 'http://localhost:4200', relevantFiles: ['src/page.ts'], commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }] },
    target: { root: 'apps/react', baseUrl: 'http://localhost:5173', relevantFiles: ['src/page.tsx'], commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }], writePaths: ['src/page.tsx'], protectedPaths: [] },
    scenarios: [{ definition: { scenarioId: 'update-customer', unitId: 'customer', name: 'Save', description: 'Synthetic', entryUrl: 'http://localhost:4200/customers/1', preconditions: {}, testDataProfile: 'standard', steps: [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }] }, required: true, fixtureRoot: 'migrations/customer/fixtures', bindings: { source: { entryUrl: 'http://localhost:4200/customers/1', steps: [] }, target: { entryUrl: 'http://localhost:5173/clientes/1', steps: [] } } }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [{ id: 'shows-error', scenarioId: 'update-customer', description: 'Show the validation error', origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true,
      assertion: { checkpoint: saveStep, scope, claim: structuredClone(errorAssertion.claim) } }],
    acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 3, maxRepairAttempts: 3, maxDurationMs: 600000 },
  });
  const parsed = parseMigrationConfig(config());
  assert.deepEqual(unitAssertionsForScenario(parsed, 'update-customer'), [errorAssertion]);
  assert.deepEqual(unitAssertionsForScenario(parsed, 'other-scenario'), []);
  const relaxed = config(); relaxed.requirements[0].assertion.claim.textMatch = 'EXACT';
  assert.notEqual(migrationConfigHash(relaxed), migrationConfigHash(config()));
  const prose = config(); delete prose.requirements[0].assertion;
  assert.deepEqual(unitAssertionsForScenario(parseMigrationConfig(prose), 'update-customer'), []);
  const broken = config(); broken.requirements[0].assertion.claim = { kind: 'NODE_PRESENT', role: 'invented' };
  assert.throws(() => parseMigrationConfig(broken));
});
