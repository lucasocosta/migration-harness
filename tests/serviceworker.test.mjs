import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario, parseRawTrace, parseSanitizedTrace } from '../packages/core/dist/index.js';
import { sanitizeTrace, projectTraceForLlm } from '../packages/trace-sanitizer/dist/index.js';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';
import { trace } from './helpers.mjs';

const scenario = extra => ({ scenarioId: 'sw', unitId: 'unit', name: 'sw', description: '', entryUrl: 'http://app.test/', preconditions: {}, steps: [], testDataProfile: 'standard', ...extra });
const key = 'x'.repeat(40);
const validator = new EquivalenceValidator();
const rawTrace = () => { const { sanitization, ...rest } = trace(); return rest; };
const withFlag = (value, t = trace()) => { const next = structuredClone(t); next.events.find(e => e.type === 'HTTP_RESPONSE').servedByServiceWorker = value; return next; };

test('scenario schema defaults service workers to block and accepts the explicit modes only', () => {
  assert.equal(parseScenario(scenario()).serviceWorkers, undefined, 'absent means the runner stays at the block default');
  assert.equal(parseScenario(scenario({ serviceWorkers: 'block' })).serviceWorkers, 'block');
  assert.equal(parseScenario(scenario({ serviceWorkers: 'allow' })).serviceWorkers, 'allow');
  for (const bad of [scenario({ serviceWorkers: 'open' }), scenario({ serviceWorkers: 'ALLOW' }), scenario({ serviceWorkers: true }), scenario({ serviceWorkers: {} })])
    assert.throws(() => parseScenario(bad), 'expected refusal for ' + JSON.stringify(bad));
  assert.throws(() => parseScenario(scenario({ serviceWorkers: 'allow', allowServiceWorkers: true })), /Unrecognized|allowServiceWorkers/);
});

test('serviceWorkers allow requires a scenario-carried http(s) origin; block behavior is unchanged', () => {
  assert.equal(parseScenario(scenario({ entryUrl: 'https://app.test/', serviceWorkers: 'allow' })).serviceWorkers, 'allow');
  assert.throws(() => parseScenario(scenario({ entryUrl: 'data:text/html,x', serviceWorkers: 'allow' })), /serviceWorkers allow requires at least one http\(s\) origin/);
  // Without an opt-in the scenario schema is untouched: existing scenarios keep validating byte-identically.
  assert.equal(parseScenario(scenario({ entryUrl: 'data:text/html,x' })).serviceWorkers, undefined);
});

test('HTTP_RESPONSE accepts servedByServiceWorker additively without loosening strictness', () => {
  parseRawTrace(withFlag(true, rawTrace()));
  parseRawTrace(withFlag(false, rawTrace()));
  parseRawTrace(rawTrace());
  parseSanitizedTrace(withFlag(true));
  assert.throws(() => parseRawTrace(withFlag('yes', rawTrace())), 'a boolean flag is not a string');
  assert.throws(() => parseRawTrace(withFlag(1, rawTrace())), 'a boolean flag is not a number');
  const smuggled = withFlag(true, rawTrace()); smuggled.events.find(e => e.type === 'HTTP_RESPONSE').fromSW = true;
  assert.throws(() => parseRawTrace(smuggled), 'strictness still refuses unknown keys');
});

test('equivalence ignores servedByServiceWorker: the schema mutation cannot break pairing', () => {
  const source = trace();
  const target = withFlag(true);
  const result = validator.validate({ source, target });
  assert.equal(result.status, 'EQUIVALENT', 'worker-served evidence is an implementation detail, never observable behavior');
  assert.deepEqual(result.divergences, []);
  assert.equal(validator.validate({ source: target, target: structuredClone(source) }).status, 'EQUIVALENT');
  assert.equal(validator.validate({ source: withFlag(false), target: withFlag(true) }).status, 'EQUIVALENT');
  // Real behavioral divergences still surface unchanged while the flag differs.
  const diverging = withFlag(true); diverging.events.find(e => e.type === 'HTTP_RESPONSE').statusCode = 500;
  assert.equal(validator.validate({ source: trace(), target: diverging }).divergences.some(d => d.code === 'NETWORK_STATUS_MISMATCH'), true);
});

test('sanitizer carries the boolean evidence unchanged and the LLM projection never mentions it', () => {
  const sanitized = sanitizeTrace(withFlag(true, rawTrace()), { pseudonymizationKey: key, allowedPayloadKeys: ['email'] });
  assert.equal(sanitized.events.find(e => e.type === 'HTTP_RESPONSE').servedByServiceWorker, true, 'structural boolean survives; no runtime string exists to leak');
  const projected = JSON.stringify(projectTraceForLlm(sanitized));
  assert.doesNotMatch(projected, /serviceWorker/i, 'structure-only projection enumerates compared keys: the evidence field simply does not appear');
  const response = projectTraceForLlm(sanitized).events.find(e => e.type === 'HTTP_RESPONSE');
  assert.deepEqual(Object.keys(response).sort(), ['bodyTypes', 'statusCode', 'type']);
});
