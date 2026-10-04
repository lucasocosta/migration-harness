import test from 'node:test';
import assert from 'node:assert/strict';
import { EquivalenceValidator } from '../packages/engine/dist/equivalence/index.js';
import { trace, event, contract } from './helpers.mjs';
const validator = new EquivalenceValidator();
const compare = (source, target, extra = {}) => validator.validate({ source, target, ...extra });

test('network regression matrix, including transport failure and non-first array items', () => {
  assert.equal(compare(trace(), trace()).status, 'EQUIVALENT');
  assert.equal(compare(trace(), trace('POST')).divergences[0].code, 'NETWORK_METHOD_MISMATCH');
  for (const [change, code] of [
    [t => { t.events[1].statusCode = 200; }, 'NETWORK_STATUS_MISMATCH'],
    [t => { t.events[0].payload = {}; }, 'NETWORK_PAYLOAD_SHAPE_MISMATCH'],
    [t => { t.events[1].body = { error: true }; }, 'NETWORK_RESPONSE_SHAPE_MISMATCH'],
    [t => { const { statusCode, headers, body, requestToResponseEndMs, ...rest } = t.events[1]; t.events[1] = { ...rest, type: 'HTTP_FAILED', errorText: 'timeout' }; }, 'NETWORK_TRANSPORT_MISMATCH'],
  ]) { const target = trace(); change(target); assert.ok(compare(trace(), target).divergences.some(d => d.code === code)); }
  const serverError = trace(); serverError.events[1].statusCode = 500;
  assert.equal(compare(serverError, structuredClone(serverError)).status, 'EQUIVALENT');
  assert.equal(compare(trace('PUT', [{ id: 1 }, { name: 'a' }]), trace('PUT', [{ id: 2 }, { other: 'b' }])).status, 'NOT_EQUIVALENT');
});
test('query normalization is explicit; templates retain path params', () => {
  const a = trace(), b = trace();
  for (const e of a.events) e.url += '?ts=1&mode=full';
  for (const e of b.events) e.url += '?ts=2&mode=full';
  assert.equal(compare(a, b).status, 'NOT_EQUIVALENT');
  assert.equal(compare(a, b, { policy: { network: { volatileQueryParams: ['ts'] } } }).status, 'EQUIVALENT');
  for (const e of b.events) e.url = e.url.replace('/123', '/456');
  assert.ok(compare(a, b, { policy: { network: { pathTemplateRules: [{ pattern: /^\/api\/customers\/[^/]+$/g, template: '/api/customers/:id' }] } } }).divergences.some(d => d.code === 'NETWORK_PATH_PARAMS_MISMATCH'));
});
test('independent same-path requests can reorder, causal edges cannot disappear', () => {
  function concurrent(reverse = false) {
    const t = trace(); t.events = [];
    for (const [i, method] of (reverse ? ['POST', 'PUT'] : ['PUT', 'POST']).entries()) {
      const pair = trace(method).events.map(e => ({ ...e, eventId: `${method}-${e.type}`, correlationId: method }));
      t.events.push(...pair);
    }
    t.events.forEach((e, i) => { e.sequenceIndex = i + 1; }); return t;
  }
  assert.equal(compare(concurrent(), concurrent(true)).status, 'EQUIVALENT');
  const a = concurrent(), b = concurrent(); a.events[2].causedByEventIds = [a.events[1].eventId];
  assert.ok(compare(a, b).divergences.some(d => d.code === 'CAUSAL_ORDER_MISMATCH'));
});
test('navigation, state, ARIA warnings and critical ARIA', () => {
  const source = event(trace(), 'NAVIGATION', { fromUrl: 'about:blank', toUrl: 'http://source.test/customers' });
  const target = structuredClone(source); target.events.at(-1).toUrl = 'http://target.test/customers';
  assert.equal(compare(source, target).status, 'EQUIVALENT');
  target.events.at(-1).toUrl += '/wrong'; assert.equal(compare(source, target).status, 'NOT_EQUIVALENT');
  const storage = event(trace(), 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'SET', key: 'saved', previousValue: null, newValue: 'yes' });
  assert.ok(compare(trace(), storage).divergences.some(d => d.dimension === 'STATE'));
  const aria = event(trace(), 'ARIA_STATE_CHANGE', { triggerEventId: 'scenario_completed', rawYamlTree: '- alert', jsonTree: { role: 'alert' } });
  assert.equal(compare(trace(), aria).status, 'EQUIVALENT');
  assert.equal(compare(trace(), aria, { policy: { observables: { ariaSeverity: 'BLOCKING' } } }).status, 'NOT_EQUIVALENT');
});
test('critical contract detects identical wrong implementations; manifests never override', () => {
  const approved = contract();
  assert.equal(compare(trace(), trace(), { contract: approved }).status, 'EQUIVALENT');
  assert.equal(compare(trace('POST'), trace('POST'), { contract: approved }).status, 'NOT_EQUIVALENT');
  const tampered = structuredClone(approved); tampered.scenarios[0].invariants.network[0].value.method = 'POST';
  assert.ok(compare(trace(), trace(), { contract: tampered }).divergences.some(d => d.code === 'CONTRACT_INTEGRITY_FAILURE'));
  assert.equal(compare(trace(), trace('POST'), { transformationManifest: { unitId: approved.unitId, generatedAt: new Date().toISOString(), transformer: { kind: 'LLM', name: 'untrusted' }, mappings: [{ mappingId: 'lie', source: 'save', target: 'save', preserves: ['HTTP_METHOD'] }] } }).status, 'NOT_EQUIVALENT');
});
test('malformed, raw and incomplete traces cannot silently pass', () => {
  const raw = trace(); delete raw.sanitization;
  assert.throws(() => compare(raw, trace()));
  const orphan = trace(); orphan.events[1].correlationId = 'other'; assert.throws(() => compare(orphan, trace()));
  const incomplete = trace(); incomplete.events.pop(); assert.equal(compare(incomplete, structuredClone(incomplete)).status, 'NOT_EQUIVALENT');
});
