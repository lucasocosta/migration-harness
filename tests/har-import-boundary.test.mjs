import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ArtifactStore } from '../packages/engine/dist/index.js';
import { openPublicFile, publicFile, readPublicJson } from '../packages/cli/dist/assistant-files.js';

const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');

const har = entries => ({ log: { version: '1.2', creator: { name: 'har-boundary-test', version: '1' }, entries } });
const entry = {
  startedDateTime: '2026-09-12T10:00:00.000Z',
  time: 1,
  request: { method: 'GET', url: 'https://app.test/api/customers', httpVersion: 'HTTP/1.1', cookies: [], headers: [], queryString: [{ name: 'page', value: '1' }] },
  response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: [], headers: [], content: { size: 11, mimeType: 'application/json', text: '{"items":[]}' }, redirectURL: '', headersSize: -1, bodySize: 0 },
  cache: {},
  timings: { send: 0, wait: 1, receive: 0 },
};

const importHar = (args, options) => exec(process.execPath, [cli, 'import-har', ...args], options);
const refused = (args, options) => assert.rejects(importHar(args, options), error => error.code === 1 && /private artifact domain/.test(error.stderr));
const absent = path => assert.rejects(readFile(path), error => error.code === 'ENOENT');
const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-har-boundary-'));
  const input = join(root, 'capture.har');
  await writeFile(input, JSON.stringify(har([entry])));
  return { root, input, out: join(root, 'evidence.json') };
};
const flags = ({ input, out }) => ['--input', input, '--out', out, '--source-reference', 'capture.har'];

test('import-har refuses a --out inside the literal .migration-private domain and writes nothing', async () => {
  const { root, input } = await workspace();
  try {
    const out = join(root, '.migration-private', 'evidence.json');
    await refused(flags({ input, out }));
    await absent(out);
    await assert.rejects(stat(join(root, '.migration-private')), error => error.code === 'ENOENT', 'no directory is created for a refused destination');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('import-har refuses a --out behind a symlinked private parent and writes nothing', async () => {
  const { root, input } = await workspace();
  try {
    const hidden = join(root, '.migration-private');
    await mkdir(hidden, { recursive: true });
    await symlink(hidden, join(root, 'alias'));
    const out = join(root, 'alias', 'evidence.json');
    await refused(flags({ input, out }));
    await absent(out);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('import-har refuses a --policy that resolves into private storage', async () => {
  const { root, input, out } = await workspace();
  try {
    const policy = join(root, '.migration-private', 'policy.json');
    await mkdir(join(root, '.migration-private'), { recursive: true });
    await writeFile(policy, JSON.stringify({ sanitization: {} }));
    await symlink(policy, join(root, 'policy-alias.json'));
    await refused([...flags({ input, out }), '--policy', join(root, 'policy-alias.json')]);
    await absent(out);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('import-har refuses an input HAR resolved through a symlink into private storage', async () => {
  const { root, out } = await workspace();
  try {
    const capture = join(root, '.migration-private', 'capture.har');
    await mkdir(join(root, '.migration-private'), { recursive: true });
    await writeFile(capture, JSON.stringify(har([entry])));
    await symlink(capture, join(root, 'capture-alias.har'));
    await refused(flags({ input: join(root, 'capture-alias.har'), out }));
    await absent(out);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('import-har refuses destinations under the MIGRATION_HARNESS_STATE_DIR override', async () => {
  const { root, input } = await workspace();
  try {
    const state = join(root, 'state-real');
    await mkdir(state, { recursive: true });
    await symlink(state, join(root, 'state-alias'));
    const env = { ...process.env, MIGRATION_HARNESS_STATE_DIR: join(root, 'state-alias') };
    // Both spellings of the override root are private: the alias itself and the resolved
    // (symlink-corrected) directory the alias names.
    for (const out of [join(root, 'state-alias', 'evidence.json'), join(state, 'evidence.json')]) {
      await refused(flags({ input, out }), { env });
      await absent(out);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('import-har still writes a public evidence bundle end-to-end', async () => {
  const { root, input, out } = await workspace();
  try {
    await importHar(flags({ input, out }));
    const bundle = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(bundle.unresolved, []);
    assert.equal(bundle.invariants.length, 1);
    assert.equal(bundle.invariants[0].value.pathTemplate, '/api/customers');
    assert.equal(bundle.invariants[0].evidenceTrail[0].sourceReference, 'capture.har#log.entries[0]');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public reads bind the opened object to the validated identity and refuse swaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-har-identity-'));
  try {
    const store = new ArtifactStore(join(root, 'artifacts'));
    const dir = join(root, 'evidence'), path = join(dir, 'bundle.json'), hidden = join(root, '.migration-private');
    await mkdir(dir, { recursive: true });
    await mkdir(hidden, { recursive: true });
    await writeFile(path, JSON.stringify({ ok: true }));
    // Leaf swap: a distinct object (created alongside the validated one, so never its inode) takes
    // the validated spelling; the descriptor no longer names the captured dev/ino.
    const validated = await publicFile(path, store);
    await writeFile(join(hidden, 'bundle.json'), JSON.stringify({ ok: false }));
    await rename(join(hidden, 'bundle.json'), path);
    await assert.rejects(openPublicFile(validated), /changed during access/);
    assert.deepEqual(await readPublicJson(path, store), { ok: false }, 'the next validation reads the new object');
    // Ancestor swap: the parent becomes a symlink into the private domain after validation, so the
    // descriptor would follow it; the repeated canonical check refuses before any byte is read.
    const fresh = await publicFile(path, store);
    await writeFile(join(hidden, 'bundle.json'), JSON.stringify({ stolen: true }));
    await rename(dir, join(root, 'evidence-moved'));
    await symlink(hidden, dir);
    await assert.rejects(openPublicFile(fresh), /changed during access/);
    await unlink(dir);
    await rename(join(root, 'evidence-moved'), dir);
    assert.deepEqual(await readPublicJson(path, store), { ok: false }, 'the validated public file still reads once restored');
  } finally { await rm(root, { recursive: true, force: true }); }
});
