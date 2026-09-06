import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { trace, contract } from './helpers.mjs';
import { ArtifactStore, AuditTrail, inspectSeal, verifyAudit } from '../packages/engine/dist/index.js';
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

test('CLI rotates raw encryption keys and anchors the audit chain, refusing unsafe targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cli-crypto-'));
  const storeRoot = join(root, 'store');
  const keysRoot = join(root, 'keys');
  const derived = new ArtifactStore(storeRoot, undefined, { encryptPrivate: true, keysRoot });
  try {
    const raw = trace(); delete raw.sanitization;
    await derived.writeRaw('unit', raw);
    const auditPath = join(root, 'audit.json');
    const rotated = await exec(process.execPath, [cli, 'rotate-raw-key', '--store-root', storeRoot, '--encrypt', '--keys-root', keysRoot, '--audit', auditPath]);
    const summary = JSON.parse(rotated.stdout);
    assert.equal(summary.activeKeyVersion, 2); assert.equal(summary.resealed, 1);
    assert.equal(inspectSeal(await readFile(await derived.privatePath('raw/unit/update-customer/1.json'))).keyVersion, 2, 'the store sees the CLI-rotated version');
    let chain = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(chain.at(-1).action, 'RAW_KEY_ROTATION'); assert.equal(verifyAudit(chain), true);
    const pruned = await exec(process.execPath, [cli, 'rotate-raw-key', '--store-root', storeRoot, '--encrypt', '--keys-root', keysRoot, '--audit', auditPath, '--prune-key-versions', '1']);
    assert.deepEqual(JSON.parse(pruned.stdout).prunedKeyVersions, [2, 1]);
    chain = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(chain.filter(e => e.action === 'RAW_KEY_ROTATION').length, 2);
    assert.equal(verifyAudit(chain), true, 'rotation extends the persisted hash chain in place');
    const external = join(root, 'anchor.log');
    await exec(process.execPath, [cli, 'anchor-audit', '--artifact-root', storeRoot, '--audit', auditPath, '--path', external]);
    await exec(process.execPath, [cli, 'anchor-audit', '--artifact-root', storeRoot, '--audit', auditPath, '--path', external]);
    const lines = (await readFile(external, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].previousAnchorHash, lines[0].chainHeadHash, 'anchors chain through the external file');
    chain = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(chain.filter(e => e.action === 'AUDIT_ANCHORED').length, 2);
    assert.equal(verifyAudit(chain), true);
    await symlink(external, join(root, 'linked.log'));
    await assert.rejects(exec(process.execPath, [cli, 'anchor-audit', '--artifact-root', storeRoot, '--audit', auditPath, '--path', join(root, 'linked.log')]),
      error => error.code === 1 && /symlink/.test(error.stderr));
    await assert.rejects(exec(process.execPath, [cli, 'anchor-audit', '--artifact-root', storeRoot, '--audit', auditPath, '--path', join(storeRoot, '.migration-private', 'x.log')]),
      error => error.code === 1 && /private artifact domain/.test(error.stderr));
    const garbage = join(root, 'garbage-chain.json');
    await writeFile(garbage, JSON.stringify([{ index: 0, timestamp: 'now', action: 'X', data: {}, previousHash: '', hash: 'bad' }]));
    await assert.rejects(exec(process.execPath, [cli, 'anchor-audit', '--artifact-root', storeRoot, '--audit', garbage, '--path', external]),
      error => error.code === 1 && /corrupt/.test(error.stderr));
    await assert.rejects(exec(process.execPath, [cli, 'rotate-raw-key', '--store-root', storeRoot, '--audit', auditPath]),
      error => error.code === 1 && /encryption-enabled/.test(error.stderr));
    await assert.rejects(exec(process.execPath, [cli, 'anchor-audit', '--artifact-root', storeRoot, '--audit', join(derived.privateRoot, 'audit.json'), '--path', external]),
      error => error.code === 1 && /private artifact domain/.test(error.stderr));
  } finally {
    await rm(derived.privateRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
