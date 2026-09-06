import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { trace, contract } from './helpers.mjs';
import { ArtifactStore } from '../packages/engine/dist/index.js';
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
test('CLI validates flags and artifacts, preserves explicit review and returns divergence exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cli-'));
  const save = async (name, value) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  try {
    const source = await save('source.json', trace()), target = await save('target.json', trace('POST'));
    await assert.rejects(exec(process.execPath, [cli, 'compare', '--source', source, '--target', target]), error => error.code === 4 && error.stdout.includes('NETWORK_METHOD_MISMATCH'));
    await assert.rejects(exec(process.execPath, [cli, 'compare', '--unknown', 'value']), error => error.code === 1);
    const invalid = await save('invalid.json', {});
    await assert.rejects(exec(process.execPath, [cli, 'compare', '--source', invalid, '--target', source]), error => error.code === 1);
    const draft = contract(); draft.status = 'DRAFT'; draft.integrity = { algorithm: 'sha256', contentHash: '' };
    const input = await save('draft.json', draft), review = join(root, 'review.json'), approved = join(root, 'approved.json');
    await exec(process.execPath, [cli, 'review-contract', '--input', input, '--out', review]);
    await exec(process.execPath, [cli, 'approve-contract', '--input', review, '--out', approved, '--approved-by', 'fixture-reviewer']);
    const result = await exec(process.execPath, [cli, 'verify-contract', '--contract', approved]); assert.match(result.stdout, /VALID/);
    await assert.rejects(exec(process.execPath, [cli, 'approve-contract', '--input', review, '--out', approved, '--approved-by', 'fixture-reviewer']), /EEXIST/);
    const raw = trace(); delete raw.sanitization; raw.events[0].headers.authorization = 'secret';
    const rawPath = await save('raw.json', raw), safePath = join(root, 'sanitized.json');
    await exec(process.execPath, [cli, 'sanitize-trace', '--input', rawPath, '--out', safePath, '--artifact-root', root]);
    assert.doesNotMatch(await readFile(safePath, 'utf8'), /secret|person@example.test/);
  } finally {
    await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI import-openapi accepts a strict ref map and refuses private-root targets at the boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cli-refmap-'));
  const save = async (name, value) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  try {
    await mkdir(join(root, 'schemas'), { recursive: true });
    await writeFile(join(root, 'schemas', 'customer.json'), JSON.stringify({ definitions: { Customer: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } } }));
    const input = await save('spec.json', { openapi: '3.1.0', paths: { '/customers': { post: {
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: 'https://schemas.example/customer.json#/definitions/Customer' } } } },
      responses: { '204': { description: 'Saved' } },
    } } } });
    const out = join(root, 'bundle.json');
    await exec(process.execPath, [cli, 'import-openapi', '--input', input, '--out', out, '--ref-map', await save('map.json', { 'https://schemas.example/': join(root, 'schemas') })]);
    const bundle = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(bundle.unresolved, []);
    assert.deepEqual(bundle.invariants[0].value.payloadRequirements.requiredFields, ['email']);
    assert.equal(bundle.invariants[0].enforcement, 'WARNING');
    await assert.rejects(exec(process.execPath, [cli, 'import-openapi', '--input', input, '--out', join(root, 'bad.json'), '--ref-map', await save('bad-map.json', { 'https://schemas.example/': '.migration-private/schemas' })]),
      error => error.code === 1 && /private root/.test(error.stderr));
    await assert.rejects(exec(process.execPath, [cli, 'import-openapi', '--input', input, '--out', join(root, 'bad2.json'), '--ref-map', await save('bad2-map.json', { '#/components/schemas/X': '.' })]),
      error => error.code === 1 && /not an external reference prefix/.test(error.stderr));
  } finally { await rm(root, { recursive: true, force: true }); }
});
