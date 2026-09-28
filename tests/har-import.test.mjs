import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importHar } from '../packages/contract-synthesizer/dist/index.js';
import { HttpEvidenceBundleSchema } from '../packages/core/dist/index.js';

const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');

const jsonBody = value => ({ mimeType: 'application/json', text: JSON.stringify(value) });
const entry = ({ method = 'GET', url, query = [], cookies = [], headers = [], postData, status = 200, responseHeaders = [], responseCookies = [], content } = {}) => ({
  startedDateTime: '2026-09-12T10:00:00.000Z',
  time: 1,
  request: { method, url, httpVersion: 'HTTP/1.1', cookies, headers, queryString: query, ...(postData ? { postData } : {}) },
  response: { status, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: responseCookies, headers: responseHeaders, content: content ?? { size: 0, mimeType: 'x-empty', text: '' }, redirectURL: '', headersSize: -1, bodySize: 0 },
  cache: {},
  timings: { send: 0, wait: 1, receive: 0 },
});
const har = entries => ({ log: { version: '1.2', creator: { name: 'har-import-test', version: '1' }, entries } });

test('HAR import extracts observational invariants from JSON GET/PUT/POST traffic', () => {
  const capture = har([
    entry({ method: 'GET', url: 'https://app.test/api/customers?page=1', query: [{ name: 'page', value: '1' }], status: 200, content: jsonBody({ items: [], total: 0 }) }),
    entry({ method: 'PUT', url: 'https://app.test/api/customers/42', status: 204, postData: { mimeType: 'application/json', text: JSON.stringify({ email: 'a@b.test', name: 'Ann' }) } }),
    entry({ method: 'POST', url: 'https://app.test/api/customers', status: 201, postData: { mimeType: 'application/json', text: JSON.stringify({ email: 'a@b.test' }) }, content: jsonBody({ id: 42 }) }),
  ]);
  const result = importHar(capture, 'capture.har');
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.invariants.length, 3);
  const [list, save, create] = result.invariants;
  assert.equal(list.value.method, 'GET');
  assert.equal(list.value.pathTemplate, '/api/customers');
  assert.deepEqual(list.value.queryParams, { required: [], optional: ['page'], ignored: [] });
  assert.deepEqual(list.value.responseExpectations.allowedStatusCodes, [200]);
  assert.deepEqual(list.value.responseExpectations.bodyShapeRequiredKeys, ['items', 'total']);
  assert.equal(list.enforcement, 'WARNING');
  assert.equal(list.evidenceTrail[0].source, 'HAR');
  assert.equal(list.evidenceTrail[0].sourceReference, 'capture.har#log.entries[0]');
  assert.equal(save.value.method, 'PUT');
  assert.equal(save.value.pathTemplate, '/api/customers/42');
  assert.deepEqual(save.value.payloadRequirements.observedAlwaysFields, ['email', 'name']);
  assert.deepEqual(save.value.payloadRequirements.observedSometimesFields, []);
  // Observation never claims requirement: required* stays empty for traffic-derived fields.
  assert.deepEqual(save.value.payloadRequirements.requiredFields, []);
  assert.deepEqual(save.value.payloadRequirements.optionalFields, []);
  assert.deepEqual(save.value.responseExpectations.allowedStatusCodes, [204]);
  assert.equal(create.value.method, 'POST');
  assert.equal(create.value.pathTemplate, '/api/customers');
  assert.deepEqual(create.value.payloadRequirements.observedAlwaysFields, ['email']);
  assert.deepEqual(create.value.responseExpectations.bodyShapeRequiredKeys, ['id']);
  assert.deepEqual(create.value.causalDependencies, { afterOperationIds: [] });
  assert.doesNotThrow(() => HttpEvidenceBundleSchema.parse(result), 'the bundle round-trips through the evidence schema');
});

test('HAR import aggregates repeated entries into always/sometimes field sets in capture order', () => {
  const capture = har([
    entry({ method: 'PUT', url: 'https://app.test/api/customers/1', status: 204, postData: { mimeType: 'application/json', text: JSON.stringify({ email: 'a@b.test', nickname: 'ace' }) } }),
    entry({ method: 'PUT', url: 'https://app.test/api/customers/1', status: 500, postData: { mimeType: 'application/json', text: JSON.stringify({ email: 'a@b.test' }) } }),
    entry({ method: 'GET', url: 'https://app.test/api/ping' }),
  ]);
  const result = importHar(capture, 'two-puts.har');
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.invariants.map(item => [item.value.method, item.value.pathTemplate]), [['PUT', '/api/customers/1'], ['GET', '/api/ping']]);
  const merged = result.invariants[0];
  assert.deepEqual(merged.value.payloadRequirements.observedAlwaysFields, ['email']);
  assert.deepEqual(merged.value.payloadRequirements.observedSometimesFields, ['nickname']);
  assert.deepEqual(merged.value.responseExpectations.allowedStatusCodes, [204, 500]);
  assert.equal(merged.evidenceTrail[0].sourceReference, 'two-puts.har#log.entries[0]');
});

test('HAR import refuses over-budget captures at the boundary', () => {
  assert.throws(() => importHar(har(Array.from({ length: 10001 }, () => entry({ url: 'https://app.test/api/ping' }))), 'many.har'), /entries exceed the budget/);
  assert.throws(() => importHar(har([entry({ url: 'https://app.test/api/ping', content: jsonBody({ blob: 'x'.repeat(4_200_000) }) })]), 'fat.har'), /size budget/);
  // Compact entries keep the 10000-entry limit under the size budget; one shared endpoint merges.
  const tiny = () => entry({ url: 'https://app.test/api/ping' });
  const atLimit = importHar(har(Array.from({ length: 10000 }, tiny)), 'at-limit.har');
  assert.equal(atLimit.invariants.length, 1);
  assert.deepEqual(atLimit.unresolved, []);
});

test('HAR import refuses private-root paths in provenance and entry URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-har-private-'));
  try {
    const capture = har([
      entry({ method: 'GET', url: `file://${join(root, 'raw.json')}`, content: jsonBody({ stolen: true }) }),
      entry({ method: 'GET', url: 'https://app.test/.migration-private/secret', content: jsonBody({ stolen: true }) }),
      entry({ method: 'GET', url: 'https://app.test/api/customers', content: jsonBody({ ok: true }) }),
    ]);
    const result = importHar(capture, 'mixed.har', { privateRoots: [root] });
    assert.equal(result.invariants.length, 1, 'only the public entry yields an invariant');
    assert.equal(result.invariants[0].value.pathTemplate, '/api/customers');
    assert.equal(result.unresolved.length, 2);
    assert.ok(result.unresolved.every(item => /private root/.test(item.reason)), result.unresolved.map(item => item.reason).join('; '));
    assert.doesNotMatch(JSON.stringify(result), /stolen/);
    assert.throws(() => importHar(har([]), join(root, 'capture.har'), { privateRoots: [root] }), /private root/);
    assert.throws(() => importHar(har([]), 'exports/.migration-private/capture.har'), /private root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HAR import never promotes cookies or Authorization headers into invariants', () => {
  const capture = har([
    entry({
      method: 'POST', url: 'https://app.test/api/login', status: 200,
      cookies: [{ name: 'session', value: 'cookie-secret-value' }],
      headers: [
        { name: 'Authorization', value: 'Bearer auth-secret-value' },
        { name: 'Cookie', value: 'session=cookie-secret-value' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      postData: { mimeType: 'application/json', text: JSON.stringify({ username: 'ann' }) },
      responseCookies: [{ name: 'set-me', value: 'response-cookie-secret' }],
      responseHeaders: [{ name: 'Set-Cookie', value: 'set-me=response-cookie-secret' }, { name: 'Content-Type', value: 'application/json' }],
      content: jsonBody({ ok: true }),
    }),
  ]);
  const result = importHar(capture, 'login.har');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /auth-secret-value|cookie-secret-value|response-cookie-secret/);
  assert.ok(result.unresolved.some(item => /security-aware/.test(item.reason)), 'sensitive material is surfaced for review');
  assert.equal(result.invariants.length, 1, 'the structural request still imports');
  assert.deepEqual(result.invariants[0].value.payloadRequirements.observedAlwaysFields, ['username']);
  assert.deepEqual(result.invariants[0].value.responseExpectations.bodyShapeRequiredKeys, ['ok']);
});

test('HAR import derives body shape from JSON bodies only, as structural field names', () => {
  const capture = har([
    entry({ method: 'POST', url: 'https://app.test/api/upload', status: 200,
      postData: { mimeType: 'text/plain', text: 'name=ann&secret=not-a-field' },
      content: { mimeType: 'text/html', text: '<html>not-shape</html>' } }),
    entry({ method: 'POST', url: 'https://app.test/api/broken', status: 200,
      postData: { mimeType: 'application/json', text: '{not json' },
      content: jsonBody({ ok: true, nested: { value: 'stay-out-of-evidence' } }) }),
  ]);
  const result = importHar(capture, 'bodies.har');
  const upload = result.invariants[0];
  assert.deepEqual(upload.value.payloadRequirements, { observedAlwaysFields: [], observedSometimesFields: [], requiredFields: [], optionalFields: [], ignoredVolatileFields: [] });
  assert.deepEqual(upload.value.responseExpectations.bodyShapeRequiredKeys, []);
  const broken = result.invariants[1];
  assert.deepEqual(broken.value.payloadRequirements.observedAlwaysFields, []);
  assert.deepEqual(broken.value.responseExpectations.bodyShapeRequiredKeys, ['nested', 'ok']);
  assert.ok(result.unresolved.some(item => /does not parse/.test(item.reason)));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /not-a-field|not-shape|stay-out-of-evidence/, 'values never enter the evidence');
});

test('CLI import-har writes an evidence bundle and enforces its flags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-har-cli-'));
  try {
    const input = join(root, 'capture.har');
    await writeFile(input, JSON.stringify(har([
      entry({ method: 'GET', url: 'https://app.test/api/customers', query: [{ name: 'page', value: '1' }], content: jsonBody({ items: [] }) }),
    ])));
    const out = join(root, 'evidence.json');
    await exec(process.execPath, [cli, 'import-har', '--input', input, '--out', out, '--source-reference', 'cli-capture.har']);
    const bundle = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(bundle.unresolved, []);
    assert.equal(bundle.invariants.length, 1);
    assert.equal(bundle.invariants[0].evidenceTrail[0].source, 'HAR');
    assert.equal(bundle.invariants[0].evidenceTrail[0].sourceReference, 'cli-capture.har#log.entries[0]');
    assert.deepEqual(bundle.invariants[0].value.responseExpectations.bodyShapeRequiredKeys, ['items']);
    assert.doesNotThrow(() => HttpEvidenceBundleSchema.parse(bundle));
    await assert.rejects(exec(process.execPath, [cli, 'import-har', '--input', input, '--out', join(root, 'missing-flag.json')]), error => error.code === 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
