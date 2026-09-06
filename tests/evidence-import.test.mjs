import test from 'node:test';
import assert from 'node:assert/strict';
import { importOpenApi, importExistingTestEvidence } from '../packages/contract-synthesizer/dist/index.js';
import { endpoint } from './helpers.mjs';

test('OpenAPI imports explicit requirements and provenance without promoting blocking', () => {
  const spec = { openapi: '3.1.0', components: { schemas: { Customer: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' } }, required: ['email'] } } }, paths: { '/api/customers/{id}': { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }], put: { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } } }, responses: { '204': { description: 'Saved' } } } } } };
  const result = importOpenApi(spec, 'api.json');
  assert.deepEqual(result.unresolved, []); assert.equal(result.invariants.length, 1);
  const invariant = result.invariants[0]; assert.deepEqual(invariant.value.payloadRequirements.requiredFields, ['email']); assert.equal(invariant.value.pathTemplate, '/api/customers/:id'); assert.equal(invariant.value.pathParams.id.type, 'number'); assert.equal(invariant.enforcement, 'WARNING'); assert.match(invariant.evidenceTrail[0].sourceReference, /api.json#\/paths/);
  spec.components.schemas.Customer = { $ref: 'https://untrusted.test/schema' };
  assert.equal(importOpenApi(spec, 'api.json').invariants.length, 0); assert.match(importOpenApi(spec, 'api.json').unresolved[0].reason, /External/);
});
test('existing test importer requires passing, structured assertions', () => {
  const result = importExistingTestEvidence([{ testId: 'customer.save', passed: true, network: endpoint().value }, { testId: 'failed', passed: false, network: endpoint().value }], 'test-report.json');
  assert.equal(result.invariants.length, 1); assert.equal(result.unresolved.length, 1); assert.equal(result.invariants[0].evidenceTrail[0].source, 'EXISTING_TESTS');
});

const objectSchema = (required, optional = []) => ({ type: 'object', required, properties: Object.fromEntries([...required, ...optional].map(name => [name, { type: 'string' }])) });
function specFor(schema, components = {}) {
  return { openapi: '3.1.0', components: { schemas: components }, paths: { '/customers': { post: {
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: { '200': { content: { 'application/json': { schema } } } },
  } } } };
}

test('OpenAPI allOf imports conjunctive field requirements through nested local references', () => {
  const schema = { type: 'object', required: ['tenant'], properties: { tenant: { type: 'string' } }, allOf: [
    { $ref: '#/components/schemas/Identity' },
    { allOf: [{ $ref: '#/components/schemas/Identity' }, objectSchema(['email'], ['nickname'])] },
  ] };
  for (const version of ['3.0.3', '3.1.0']) {
    const spec = specFor(schema, { Identity: objectSchema(['id'], ['email']) }); spec.openapi = version;
    const imported = importOpenApi(spec, 'composed.json');
    assert.deepEqual(imported.unresolved, []);
    const invariant = imported.invariants[0];
    assert.deepEqual(invariant.value.payloadRequirements.requiredFields, ['email', 'id', 'tenant']);
    assert.deepEqual(invariant.value.payloadRequirements.optionalFields, ['nickname']);
    assert.deepEqual(invariant.value.responseExpectations.bodyShapeRequiredKeys, ['email', 'id', 'tenant']);
    assert.equal(invariant.enforcement, 'WARNING');
    assert.equal(invariant.evidenceTrail[0].sourceReference, 'composed.json#/paths/~1customers/post');
  }
});

test('OpenAPI allOf preserves response intersection and optional-body review', () => {
  const schema = { allOf: [objectSchema(['id']), objectSchema(['email'])] };
  const spec = specFor(schema);
  spec.paths['/customers'].post.responses['400'] = { content: { 'application/json': { schema: objectSchema(['id', 'error']) } } };
  assert.deepEqual(importOpenApi(spec, 'responses.json').invariants[0].value.responseExpectations.bodyShapeRequiredKeys, ['id']);
  spec.paths['/customers'].post.requestBody.required = false;
  const refused = importOpenApi(spec, 'optional.json');
  assert.deepEqual(refused.invariants, []);
  assert.match(refused.unresolved[0].reason, /optional request body/);
});

test('OpenAPI refuses unsupported or ambiguous allOf semantics instead of inventing obligations', () => {
  const invalid = [
    { allOf: [] },
    { allOf: [objectSchema(['id']), { type: null }] },
    { allOf: [objectSchema(['id']), { $ref: 42 }] },
    { allOf: [objectSchema(['id']), { type: 'string' }] },
    { allOf: [{ ...objectSchema(['id']), additionalProperties: false }, objectSchema(['email'])] },
    { allOf: [objectSchema(['id']), { ...objectSchema(['id']), properties: { id: { type: 'number' } } }] },
    { allOf: [{ type: 'object', properties: { id: { type: 'string', readOnly: true } }, required: ['id'] }] },
    { allOf: [{ type: 'object', properties: { id: { type: 'string', writeOnly: true } }, required: ['id'] }] },
    { allOf: [{ required: ['id'] }] },
    { allOf: [{ ...objectSchema(['id']), nullable: true }] },
    { allOf: [{ ...objectSchema(['id']), unevaluatedProperties: false }] },
    { allOf: [{ oneOf: [objectSchema(['id']), objectSchema(['email'])] }] },
    { ...objectSchema(['id']), dependentRequired: { id: ['email'] } },
    { $ref: '#/components/schemas/Identity', required: ['email'] },
  ];
  for (const schema of invalid) {
    const imported = importOpenApi(specFor(schema, { Identity: objectSchema(['id']) }), 'unsupported.json');
    assert.deepEqual(imported.invariants, [], JSON.stringify(schema));
    assert.equal(imported.unresolved.length, 1);
  }
});

test('OpenAPI allOf resolves cycles and resource exhaustion as explicit review findings', () => {
  const cyclic = { allOf: [{ $ref: '#/components/schemas/Recursive' }, objectSchema(['id'])] };
  let result = importOpenApi(specFor(cyclic, { Recursive: cyclic }), 'cyclic.json');
  assert.deepEqual(result.invariants, []); assert.match(result.unresolved[0].reason, /Cyclic/);
  let deep = objectSchema(['id']);
  for (let i = 0; i < 66; i++) deep = { allOf: [deep] };
  result = importOpenApi(specFor(deep), 'deep.json');
  assert.deepEqual(result.invariants, []); assert.match(result.unresolved[0].reason, /budget/);
  const shared = { allOf: Array.from({ length: 64 }, () => objectSchema(['id'])) };
  result = importOpenApi(specFor({ allOf: Array.from({ length: 10 }, () => shared) }), 'wide.json');
  assert.deepEqual(result.invariants, []); assert.match(result.unresolved[0].reason, /budget/);
  result = importOpenApi(specFor({ allOf: [objectSchema(['id']), { $ref: 'https://untrusted.test/schema.json' }] }), 'external.json');
  assert.deepEqual(result.invariants, []); assert.match(result.unresolved[0].reason, /External/);
});
