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
