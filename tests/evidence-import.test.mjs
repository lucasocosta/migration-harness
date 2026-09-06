import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const schemaOf = (properties, required = []) => ({ type: 'object', required, properties: Object.fromEntries(properties) });
const refSpec = schema => ({ openapi: '3.1.0', paths: { '/customers': { post: {
  requestBody: { required: true, content: { 'application/json': { schema } } },
  responses: { '204': { description: 'Saved' } },
} } } });
const importedReason = imported => { assert.deepEqual(imported.invariants, []); assert.equal(imported.unresolved.length, 1); return imported.unresolved[0].reason; };

test('OpenAPI oneOf extracts only when every branch yields the same observable invariant set', () => {
  const agreed = { oneOf: [objectSchema(['email'], ['nickname']), objectSchema(['email'], ['nickname'])] };
  const imported = importOpenApi(specFor(agreed), 'agree.json');
  assert.deepEqual(imported.unresolved, []);
  assert.deepEqual(imported.invariants[0].value.payloadRequirements.requiredFields, ['email']);
  assert.deepEqual(imported.invariants[0].value.payloadRequirements.optionalFields, ['nickname']);
  assert.deepEqual(imported.invariants[0].value.responseExpectations.bodyShapeRequiredKeys, ['email']);
  // Field-level naming: the reason says which field and which branches hold the disagreement.
  assert.match(importedReason(importOpenApi(specFor({ oneOf: [objectSchema(['id']), objectSchema(['email'])] }), 'disagree.json')), /oneOf branches disagree: 'id' is required in branch 0 but not in branch 1\./);
  assert.match(importedReason(importOpenApi(specFor({ oneOf: [objectSchema(['id']), { ...objectSchema([], ['id']) }] }), 'presence.json')), /oneOf branches disagree: 'id' is required in branch 0 but not in branch 1\./);
  assert.match(importedReason(importOpenApi(specFor({ oneOf: [objectSchema(['id']), { type: 'object', required: ['id'] }] }), 'undeclared.json')), /oneOf branches disagree: 'id' is declared in only one of branch 0 and branch 1\./);
  assert.match(importedReason(importOpenApi(specFor({ oneOf: [objectSchema(['id']), { type: 'object', properties: { id: { type: 'object', properties: { deep: { type: 'string' } } } }, required: ['id'] }] }), 'deep.json')), /oneOf branches disagree: 'id' has different type definitions in branch 0 and branch 1\./);
  assert.match(importedReason(importOpenApi(specFor({ oneOf: [schemaOf([['id', { type: 'string' }]]), schemaOf([['id', { type: 'number' }]])] }), 'types.json')), /oneOf branches disagree: 'id' has different type definitions in branch 0 and branch 1\./);
  // A single non-object branch cannot share an object invariant set.
  assert.match(importedReason(importOpenApi(specFor({ oneOf: [objectSchema(['id']), { type: 'string' }] }), 'scalar.json')), /Only object payload schemas|oneOf branches require object payloads/);
});

test('OpenAPI anyOf is sound per field: agreed optionals stay optional, required only where every branch requires', () => {
  const declared = importOpenApi(specFor({ anyOf: [objectSchema([], ['kind']), objectSchema([], ['kind'])] }), 'optional.json');
  assert.deepEqual(declared.unresolved, []);
  assert.deepEqual(declared.invariants[0].value.payloadRequirements.requiredFields, [], 'an optionally declared anyOf field is never promoted to required');
  assert.deepEqual(declared.invariants[0].value.payloadRequirements.optionalFields, ['kind']);
  const partial = importOpenApi(specFor({ anyOf: [
    schemaOf([['token', { type: 'string' }], ['role', { type: 'string' }]], ['token']),
    schemaOf([['token', { type: 'string' }], ['scope', { type: 'string' }]], ['token']),
  ] }), 'partial.json');
  assert.deepEqual(partial.unresolved, []);
  assert.deepEqual(partial.invariants[0].value.payloadRequirements.requiredFields, ['token'], 'every branch requires token, so any matching document must carry it');
  assert.deepEqual(partial.invariants[0].value.payloadRequirements.optionalFields, [], 'branch-only declarations are dropped, never guessed');
  assert.match(importedReason(importOpenApi(specFor({ anyOf: [schemaOf([['id', { type: 'string' }]]), schemaOf([['id', { type: 'number' }]])] }), 'conflict.json')), /anyOf branches disagree: 'id' has different type definitions across branches\./);
  // Sibling constraints apply conjunctively to the agreed alternative set.
  const discriminated = importOpenApi(specFor({ type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'], anyOf: [
    schemaOf([['token', { type: 'string' }]], ['token']),
    schemaOf([['token', { type: 'string' }]], ['token']),
  ] }), 'siblings.json');
  assert.deepEqual(discriminated.unresolved, []);
  assert.deepEqual(discriminated.invariants[0].value.payloadRequirements.requiredFields, ['kind', 'token']);
  assert.match(importedReason(importOpenApi(specFor({ type: 'object', properties: { token: { type: 'number' } }, required: ['token'], anyOf: [
    schemaOf([['token', { type: 'string' }]], ['token']),
    schemaOf([['token', { type: 'string' }]], ['token']),
  ] }), 'sibling-conflict.json')), /anyOf branches disagree: 'token' conflicts with sibling property definitions\./);
  // Convergence also composes conjunctively inside allOf.
  const composed = importOpenApi(specFor({ allOf: [{ oneOf: [objectSchema(['id']), objectSchema(['id'])] }, objectSchema(['email'])] }), 'composed.json');
  assert.deepEqual(composed.unresolved, []);
  assert.deepEqual(composed.invariants[0].value.payloadRequirements.requiredFields, ['email', 'id']);
});

test('OpenAPI conditional schemas stay review findings and branch traversal honours the caps', () => {
  assert.match(importedReason(importOpenApi(specFor({ not: objectSchema(['id']) }), 'not.json')), /Conditional schemas require semantic review\./);
  assert.match(importedReason(importOpenApi(specFor({ if: objectSchema(['id']), then: objectSchema(['email']) }), 'conditional.json')), /Conditional schemas require semantic review\./);
  assert.match(importedReason(importOpenApi(specFor({ type: 'object', properties: { x: { type: 'string' } }, oneOf: [objectSchema(['id']), objectSchema(['email'])] }), 'deps.json')), /oneOf branches disagree/);
  for (const kind of ['oneOf', 'anyOf']) {
    const tooMany = importOpenApi(specFor({ [kind]: Array.from({ length: 65 }, () => objectSchema(['id'])) }), 'cap.json');
    assert.match(importedReason(tooMany), new RegExp(`${kind} requires 1-64 branches\\.`));
  }
  let deep = objectSchema(['id']);
  for (let i = 0; i < 66; i++) deep = { oneOf: [deep] };
  assert.match(importedReason(importOpenApi(specFor(deep), 'deep-budget.json')), /budget/);
  let wide = { oneOf: Array.from({ length: 64 }, () => { let branch = objectSchema(['id']); for (let i = 0; i < 8; i++) branch = { allOf: [branch] }; return branch; }) };
  assert.match(importedReason(importOpenApi(specFor(wide), 'wide-budget.json')), /budget/);
  const cyclic = { oneOf: [{ $ref: '#/components/schemas/Loop' }] };
  assert.match(importedReason(importOpenApi(specFor(cyclic, { Loop: cyclic }), 'loop.json')), /Cyclic/);
});

test('OpenAPI ref map reads bounded local documents and never fetches, refusing escapes and private roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-refmap-'));
  try {
    const schemas = join(root, 'schemas');
    await mkdir(join(schemas, '.migration-private'), { recursive: true });
    const write = async (path, value) => { await mkdir(join(root, path).replace(/[/\\][^/\\]*$/, ''), { recursive: true }); await writeFile(join(root, path), JSON.stringify(value)); };
    await write('schemas/customer.json', { definitions: { Customer: objectSchema(['email'], ['nickname']) } });
    await write('schemas/wrapper.json', { schema: { $ref: 'https://schemas.example/customer.json#/definitions/Customer' } });
    await write('schemas/plain.json', objectSchema(['token']));
    await write('schemas/notes.txt', 'not json');
    await write('schemas/.migration-private/keys.json', objectSchema(['secret']));
    await write('outside/leak.json', objectSchema(['stolen']));
    const map = { 'https://schemas.example/': schemas, '../common/': schemas };
    // URL prefixes are lookup keys into local files: resolution is by construction disk-only.
    const viaUrl = importOpenApi(refSpec({ $ref: 'https://schemas.example/customer.json#/definitions/Customer' }), 'url.json', { refMap: map });
    assert.deepEqual(viaUrl.unresolved, []);
    assert.deepEqual(viaUrl.invariants[0].value.payloadRequirements.requiredFields, ['email']);
    assert.deepEqual(viaUrl.invariants[0].value.payloadRequirements.optionalFields, ['nickname']);
    // Chained external references keep resolving through the mapping, scoped to each document.
    const chained = importOpenApi(refSpec({ $ref: '../common/wrapper.json#/schema' }), 'chain.json', { refMap: map });
    assert.deepEqual(chained.unresolved, []);
    assert.deepEqual(chained.invariants[0].value.payloadRequirements.requiredFields, ['email']);
    // Exact-file mapping with a fragment-free whole-document reference.
    const whole = importOpenApi(refSpec({ $ref: '../common/plain.json' }), 'whole.json', { refMap: { '../common/plain.json': join(schemas, 'plain.json') } });
    assert.deepEqual(whole.unresolved, []);
    assert.deepEqual(whole.invariants[0].value.payloadRequirements.requiredFields, ['token']);
    // Mapping cannot become a traversal primitive: containment is enforced before any read.
    assert.match(importedReason(importOpenApi(refSpec({ $ref: '../common/../../outside/leak.json' }), 'escape.json', { refMap: map })), /escapes its ref-map root/);
    assert.match(importedReason(importOpenApi(refSpec({ $ref: '../common//outside/leak.json' }), 'absolute.json', { refMap: map })), /escapes its ref-map root/);
    assert.match(importedReason(importOpenApi(refSpec({ $ref: '../common/.migration-private/keys.json' }), 'private.json', { refMap: map })), /private root/);
    assert.match(importedReason(importOpenApi(refSpec({ $ref: '../common/missing.json' }), 'missing.json', { refMap: map })), /Unreadable mapped reference/);
    assert.match(importedReason(importOpenApi(refSpec({ $ref: '../common/plain.json#/definitions/Nope' }), 'nope.json', { refMap: map })), /Unresolved reference/);
    assert.match(importedReason(importOpenApi(refSpec({ $ref: '../common/notes.txt' }), 'txt.json', { refMap: map })), /must resolve to JSON documents/);
    assert.match(importedReason(importOpenApi(refSpec({ $ref: '../common/anchor.json#names' }), 'anchor.json', { refMap: map })), /Named reference anchors/);
    // Unmapped external references keep the conservative review finding.
    assert.match(importedReason(importOpenApi(refSpec({ $ref: 'https://other.example/x.json' }), 'unmapped.json', { refMap: map })), /External or cyclic references require review\./);
    assert.match(importedReason(importOpenApi(refSpec({ $ref: 'https://other.example/x.json' }), 'nomap.json')), /External or cyclic references require review\./);
  } finally { await rm(root, { recursive: true, force: true }); }
  // A malformed map is caller error: thrown at the boundary, consistent with document-level invalidity.
  for (const bad of [
    { 'https://a/': 42 },
    { '#/components/schemas/X': '/tmp' },
    { 'file:///tmp/': '/tmp' },
    { 'gopher://a/': '/tmp' },
    { 'https://a': '/tmp' },
    { 'https://a/': '.migration-private/schemas' },
    { 'https://a/': 'x\0y' },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`https://p${i}.example/`, '/tmp'])),
  ]) assert.throws(() => importOpenApi(refSpec({ $ref: 'https://a/x.json' }), 'bad-map.json', { refMap: bad }), 'expected a strict refusal for ' + JSON.stringify(bad));
});
