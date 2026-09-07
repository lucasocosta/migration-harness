import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EquivalenceValidator, diffValues, migrationComparisonPolicy, parseValidationPolicy, safeUrl, valuePathPresent,
} from '../packages/equivalence-validator/dist/index.js';
import { sanitizeTrace } from '../packages/trace-sanitizer/dist/index.js';
import { adaptLegacyComparison } from '../packages/quality-gates/dist/migration-report.js';
import { trace, event } from './helpers.mjs';

const validator = new EquivalenceValidator();
const values = { network: { comparePayloadValues: true, compareResponseValues: true } };
const compare = (source, target, policy) => validator.validate({ source, target, ...(policy ? { policy } : {}) });
const codes = result => result.divergences.map(item => item.code);
const hash = 'a'.repeat(64);
const identity = { migrationId: 'customer', configurationHash: hash, referenceHash: hash, candidateHash: hash, buildHash: hash };

function payloadTrace(payload) {
  const value = trace('PUT', payload);
  value.events[1].body = { id: 7, saved: true, labels: ['first', 'second'] };
  return value;
}
const base = () => payloadTrace({ email: 'person@example.test', age: 40, active: true, tags: ['first', 'second'], note: null, secret: 'SOURCE-ONLY' });

test('equal shapes with different values are detected, localized and never quoted back', () => {
  assert.equal(compare(base(), base(), values).status, 'EQUIVALENT');
  for (const [mutate, code, path] of [
    [p => { p.email = 'other@example.test'; }, 'NETWORK_PAYLOAD_VALUE_MISMATCH', 'payload.email'],
    [p => { p.age = 41; }, 'NETWORK_PAYLOAD_VALUE_MISMATCH', 'payload.age'],
    [p => { p.active = false; }, 'NETWORK_PAYLOAD_VALUE_MISMATCH', 'payload.active'],
    [p => { p.secret = 'TARGET-ONLY'; }, 'NETWORK_PAYLOAD_VALUE_MISMATCH', 'payload.secret'],
    [p => { p.age = '40'; }, 'NETWORK_PAYLOAD_VALUE_TYPE_MISMATCH', 'payload.age'],
    [p => { delete p.note; }, 'NETWORK_PAYLOAD_FIELD_MISSING', 'payload.note'],
    [p => { p.note = 'now filled'; }, 'NETWORK_PAYLOAD_NULL_MISMATCH', 'payload.note'],
    [p => { p.extra = 1; }, 'NETWORK_PAYLOAD_FIELD_UNEXPECTED', 'payload.extra'],
    [p => { p.tags = ['second', 'first']; }, 'NETWORK_PAYLOAD_VALUE_MISMATCH', 'payload.tags[0]'],
    [p => { p.tags = ['first']; }, 'NETWORK_PAYLOAD_ARRAY_LENGTH_MISMATCH', 'payload.tags'],
  ]) {
    const source = base(), target = base();
    mutate(target.events[0].payload);
    const result = compare(source, target, values);
    assert.equal(result.status, 'NOT_EQUIVALENT', code);
    const divergence = result.divergences.find(item => item.code === code && item.source.path === path);
    assert.ok(divergence, `${code} at ${path}`);
    assert.deepEqual(Object.keys(divergence.source).sort(), ['kind', 'path']);
    const serialized = JSON.stringify(result);
    for (const secret of ['person@example.test', 'other@example.test', 'SOURCE-ONLY', 'TARGET-ONLY', 'now filled']) {
      assert.ok(!serialized.includes(secret), `${code} leaked ${secret}`);
    }
  }
  const reordered = base(); reordered.events[0].payload.tags = ['second', 'first'];
  assert.equal(compare(base(), reordered).status, 'EQUIVALENT');
  assert.ok(!codes(compare(base(), reordered, values)).includes('NETWORK_PAYLOAD_SHAPE_MISMATCH'));
});

test('response body values are compared separately from their shape', () => {
  const target = base(); target.events[1].body = { id: 8, saved: true, labels: ['first', 'second'] };
  const result = compare(base(), target, values);
  assert.equal(result.status, 'NOT_EQUIVALENT');
  assert.ok(result.divergences.some(item => item.code === 'NETWORK_RESPONSE_VALUE_MISMATCH' && item.source.path === 'response.id'));
  assert.equal(compare(base(), target).status, 'EQUIVALENT');
  const labels = base(); labels.events[1].body.labels = ['first'];
  assert.ok(codes(compare(base(), labels, values)).includes('NETWORK_RESPONSE_ARRAY_LENGTH_MISMATCH'));
});

test('value comparison is opt-in for the v0.2 profile and required by the standard mapping', () => {
  const target = base(); target.events[0].payload.email = 'other@example.test';
  assert.equal(compare(base(), target).status, 'EQUIVALENT');
  assert.equal(compare(base(), target, parseValidationPolicy({})).status, 'EQUIVALENT');
  assert.equal(compare(base(), target, migrationComparisonPolicy({})).status, 'NOT_EQUIVALENT');
  assert.equal(compare(base(), target, migrationComparisonPolicy({ network: { volatilePayloadFields: ['email'] } })).status, 'EQUIVALENT');
  const nested = base(), changed = base();
  for (const value of [nested, changed]) value.events[0].payload.customer = { id: 1, updatedAt: 'source-stamp' };
  changed.events[0].payload.customer.updatedAt = 'target-stamp';
  assert.ok(codes(compare(nested, changed, values)).includes('NETWORK_PAYLOAD_VALUE_MISMATCH'));
  assert.equal(compare(nested, changed, migrationComparisonPolicy({ network: { volatilePayloadFields: ['updatedAt'] } })).status, 'EQUIVALENT');
  assert.equal(migrationComparisonPolicy({ network: { comparePayloadValues: false } }).network.comparePayloadValues, false);
});

test('pseudonymized data stays comparable: equal input equal, different input divergent', () => {
  const sanitize = payload => {
    const raw = payloadTrace(payload);
    delete raw.sanitization;
    return sanitizeTrace(raw, { pseudonymizationKey: 'k'.repeat(40), allowedPayloadKeys: ['email', 'id', 'saved', 'labels'] });
  };
  const source = sanitize({ email: 'person@example.test' });
  assert.ok(JSON.stringify(source).includes('p_'));
  assert.ok(!JSON.stringify(source).includes('person@example.test'));
  assert.equal(compare(source, sanitize({ email: 'person@example.test' }), values).status, 'EQUIVALENT');
  const different = compare(source, sanitize({ email: 'someone@example.test' }), values);
  assert.equal(different.status, 'NOT_EQUIVALENT');
  assert.ok(different.divergences.some(item => item.code === 'NETWORK_PAYLOAD_VALUE_MISMATCH' && item.source.path === 'payload.email'));
  assert.ok(!/p_[0-9a-f]{24}/.test(JSON.stringify(different)));
});

test('a required value field that neither side exposes is insufficient evidence, never a pass', () => {
  const required = { network: { comparePayloadValues: true, requiredValueFields: [{ method: 'PUT', field: 'payload.email' }] } };
  assert.equal(compare(base(), base(), required).status, 'EQUIVALENT');
  const dropped = payload => {
    const raw = payloadTrace(payload);
    delete raw.sanitization;
    return sanitizeTrace(raw, { pseudonymizationKey: 'k'.repeat(40), allowedPayloadKeys: ['age'] });
  };
  const omitted = compare(dropped({ email: 'person@example.test', age: 40 }), dropped({ email: 'person@example.test', age: 40 }), required);
  assert.equal(omitted.status, 'NOT_EQUIVALENT');
  assert.ok(codes(omitted).includes('VALUE_EVIDENCE_OMITTED'));
  const adapted = adaptLegacyComparison(omitted, identity);
  assert.equal(adapted.status, 'INCONCLUSIVE');
  assert.ok(adapted.diagnostics.some(item => item.code === 'EXECUTION_INCOMPLETE'));
  const absentOperation = compare(base(), base(), { network: { requiredValueFields: [{ method: 'DELETE', field: 'payload.email' }] } });
  assert.ok(codes(absentOperation).includes('VALUE_EVIDENCE_OMITTED'));
  const indexed = base(); indexed.events[0].payload.items = [{ id: 5 }];
  const nestedRule = { network: { comparePayloadValues: true, requiredValueFields: [{ field: 'payload.items[0].id' }] } };
  assert.ok(!codes(compare(indexed, structuredClone(indexed), nestedRule)).includes('VALUE_EVIDENCE_OMITTED'));
  assert.ok(codes(compare(base(), base(), nestedRule)).includes('VALUE_EVIDENCE_OMITTED'));
});

test('navigation, state and accessibility diagnostics became structural', () => {
  const source = event(trace(), 'NAVIGATION', { fromUrl: 'about:blank', toUrl: 'http://app.test/customers/p_0123456789abcdef01234567?token=secret-token' });
  const target = event(trace(), 'NAVIGATION', { fromUrl: 'about:blank', toUrl: 'http://app.test/clientes/p_0123456789abcdef01234567?token=secret-token' });
  const navigation = compare(source, target).divergences.find(item => item.code === 'NAVIGATION_MISMATCH');
  assert.deepEqual(navigation.source, ['/customers/<pseudonym>?token']);
  assert.ok(!JSON.stringify(navigation).includes('secret-token'));

  const storageSource = event(trace(), 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'SET', key: 'draft', previousValue: null, newValue: 'SOURCE-DRAFT' });
  const storageTarget = event(trace(), 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'SET', key: 'draft', previousValue: null, newValue: 'TARGET-DRAFT' });
  const storage = compare(storageSource, storageTarget).divergences.find(item => item.code === 'STORAGE_MISMATCH');
  assert.deepEqual(storage.source, [{ storageType: 'localStorage', key: 'draft', difference: 'VALUE' }]);
  assert.ok(!JSON.stringify(storage).includes('SOURCE-DRAFT') && !JSON.stringify(storage).includes('TARGET-DRAFT'));
  const removed = compare(storageSource, trace()).divergences.find(item => item.code === 'STORAGE_MISMATCH');
  assert.equal(removed.source[0].difference, 'MISSING');
  const extra = event(structuredClone(storageTarget), 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'REMOVE', key: 'draft', previousValue: 'TARGET-DRAFT', newValue: null });
  assert.equal(compare(storageSource, extra).divergences.find(item => item.code === 'STORAGE_MISMATCH').source[0].difference, 'SEQUENCE');

  const ariaSource = event(trace(), 'ARIA_STATE_CHANGE', { triggerEventId: 'request', rawYamlTree: '', jsonTree: { role: 'alert', name: 'SOURCE-NAME' } });
  const ariaTarget = event(trace(), 'ARIA_STATE_CHANGE', { triggerEventId: 'request', rawYamlTree: '', jsonTree: { role: 'status', name: 'TARGET-NAME' } });
  const aria = compare(ariaSource, ariaTarget, { observables: { ariaSeverity: 'BLOCKING' } }).divergences.find(item => item.code === 'ARIA_SEMANTICS_MISMATCH');
  assert.deepEqual(aria.source, [{ checkpoint: 'request', difference: 'TREE', sourceRoles: ['alert'], targetRoles: ['status'] }]);
  assert.ok(!JSON.stringify(aria).includes('SOURCE-NAME') && !JSON.stringify(aria).includes('TARGET-NAME'));
  assert.equal(compare(ariaSource, trace()).divergences.find(item => item.code === 'ARIA_SEMANTICS_MISMATCH').source[0].difference, 'MISSING');

  const params = { network: { pathTemplateRules: [{ pattern: /^\/api\/customers\/[^/]+$/g, template: '/api/customers/:id' }] } };
  const other = trace();
  for (const item of other.events) item.url = item.url.replace('/123', '/456');
  const route = compare(trace(), other, params).divergences.find(item => item.code === 'NETWORK_PATH_PARAMS_MISMATCH');
  assert.deepEqual(route.source, { pathParams: ['id'] });
  assert.equal(route.target, undefined);
  const query = trace(), queried = trace();
  for (const item of query.events) item.url += '?filter=SOURCE-FILTER';
  for (const item of queried.events) item.url += '?filter=TARGET-FILTER';
  const queryDivergence = compare(query, queried).divergences.find(item => item.code === 'NETWORK_QUERY_MISMATCH');
  assert.deepEqual(queryDivergence.source, { queryParams: ['filter'] });
  assert.ok(!JSON.stringify(queryDivergence).includes('SOURCE-FILTER'));
});

test('value comparison helpers bound depth, volume and unsafe path segments', () => {
  const deep = (levels, leaf) => levels ? { child: deep(levels - 1, leaf) } : { leaf };
  assert.deepEqual(diffValues(deep(3, 1), deep(3, 2), 'payload').map(item => item.path), ['payload.child.child.child.leaf']);
  assert.equal(diffValues(deep(30, 1), deep(30, 2), 'payload')[0].code, 'COMPARISON_TRUNCATED');
  assert.equal(diffValues({ a: 1, b: 2, c: 3 }, { a: 9, b: 9, c: 9 }, 'payload', { maxDifferences: 2 }).length, 2);
  assert.deepEqual(diffValues({ p_0123456789abcdef01234567: 1 }, { p_0123456789abcdef01234567: 2 }, 'payload')[0].path, 'payload.<pseudonym>');
  assert.deepEqual(diffValues({ 'user name@host': 1 }, { 'user name@host': 2 }, 'payload')[0].path, 'payload.<key>');
  assert.deepEqual(diffValues(null, undefined, 'payload')[0], { code: 'FIELD_MISSING', path: 'payload', sourceKind: 'null', targetKind: 'absent' });
  assert.deepEqual(diffValues(undefined, undefined, 'payload'), []);
  assert.equal(valuePathPresent({ items: [{ id: 1 }] }, 'items[0].id'), true);
  assert.equal(valuePathPresent({ items: [{ id: 1 }] }, 'items[1].id'), false);
  assert.equal(valuePathPresent({ note: null }, 'note'), true);
  assert.equal(valuePathPresent(undefined, ''), false);
  assert.equal(safeUrl('/a/b?z=1&a=2'), '/a/b?a&z');
});
