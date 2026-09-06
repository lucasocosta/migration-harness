import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, AuditTrail, KeyRing, verifyAudit, anchorAudit, inspectSeal, openSeal, ArtifactAuthFailureError } from '../packages/engine/dist/index.js';
import { trace } from './helpers.mjs';

const rawTrace = runIndex => { const t = trace(); delete t.sanitization; return { ...t, runIndex }; };
const MAGIC = 'MHAES001';
const setup = async (options = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-lifecycle-'));
  const keysRoot = join(root, 'keys');
  const store = new ArtifactStore(root, join(root, 'private'), { encryptPrivate: true, keysRoot, ...options });
  return { root, keysRoot, store };
};

test('encryption at rest seals raw writes, survives tampering as a typed error and reads legacy plaintext', async () => {
  const { root, keysRoot, store } = await setup();
  try {
    const raw = rawTrace(1);
    const path = await store.writeRaw('unit', raw);
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, MAGIC.length).toString('latin1'), MAGIC, 'sealed files carry the magic header');
    assert.equal(bytes.readUInt32BE(8), 1, 'first use generates key version 1');
    assert.throws(() => JSON.parse(bytes.toString()), 'ciphertext is never parseable JSON');
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'private-root 0600 discipline applies unchanged to encrypted files');
    assert.equal((await stat(join(keysRoot, 'v1.hex'))).mode & 0o777, 0o600);
    assert.equal((await stat(keysRoot)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse((await store.readPrivate('raw/unit/update-customer/1.json')).toString()), raw, 'roundtrip');
    // Tampered ciphertext and tampered auth tag both surface as the typed auth failure.
    for (const flip of [bytes.length - 1, MAGIC.length + 4 + 12]) {
      const tampered = Buffer.from(bytes); tampered[flip] ^= 0xff;
      await writeFile(await store.privatePath('raw/unit/tamper/1.json'), tampered);
      await chmod(await store.privatePath('raw/unit/tamper/1.json'), 0o600);
      await assert.rejects(store.readPrivate('raw/unit/tamper/1.json'), error => error instanceof ArtifactAuthFailureError && error.code === 'ARTIFACT_AUTH_FAILURE');
    }
    // Legacy plaintext files are detected by magic absence and pass through unchanged.
    const legacy = await store.privatePath('raw/legacy/update-customer/1.json');
    await writeFile(legacy, `${JSON.stringify(raw, null, 2)}\n`); await chmod(legacy, 0o600);
    assert.deepEqual(JSON.parse((await store.readPrivate('raw/legacy/update-customer/1.json')).toString()), raw);
    // Wrong key-directory modes refuse to proceed.
    const badKeys = join(root, 'bad-keys');
    await mkdir(badKeys, { mode: 0o777 }); await chmod(badKeys, 0o755);
    const guarded = new ArtifactStore(root, join(root, 'private'), { encryptPrivate: true, keysRoot: badKeys });
    await assert.rejects(guarded.writeRaw('unit', rawTrace(2)), /mode 0700/);
    // Encryption off keeps behavior byte-identical to the legacy plaintext store: plain JSON, no sealing.
    const plain = new ArtifactStore(root, join(root, 'private-plain'));
    const plainPath = await plain.writeRaw('unit', raw);
    const plainBytes = await readFile(plainPath);
    assert.notEqual(plainBytes.subarray(0, MAGIC.length).toString('latin1'), MAGIC);
    assert.equal(plainBytes[0], '{'.charCodeAt(0));
    assert.equal(plainBytes.toString(), `${JSON.stringify(JSON.parse(plainBytes.toString()), null, 2)}\n`, 'canonical plaintext shape is untouched');
    assert.deepEqual(JSON.parse((await plain.readPrivate('raw/unit/update-customer/1.json')).toString()), raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('key rotation re-seals the raw domain, retains old keys, prunes only older versions and is audited', async () => {
  const { root, store, keysRoot } = await setup();
  try {
    await store.writeRaw('unit', rawTrace(1));
    const beforeRotation = await readFile(await store.privatePath('raw/unit/update-customer/1.json'));
    assert.equal(inspectSeal(beforeRotation).keyVersion, 1);
    const trail = new AuditTrail();
    const first = await store.rotateRawKey(trail);
    assert.equal(first.activeKeyVersion, 2); assert.equal(first.resealed, 1); assert.deepEqual(first.prunedKeyVersions, []);
    assert.equal(verifyAudit(trail.snapshot()), true);
    assert.equal(trail.snapshot().at(-1).action, 'RAW_KEY_ROTATION');
    assert.deepEqual(trail.snapshot().at(-1).data, { activeKeyVersion: 2, resealed: 1, skipped: 0, prunedKeyVersions: [] });
    assert.equal(inspectSeal(await readFile(await store.privatePath('raw/unit/update-customer/1.json'))).keyVersion, 2, 'sweep moved every raw file to the new active version');
    // Old versions stay readable while their keys are retained: plant the pre-rotation v1 copy.
    const retained = await store.privatePath('raw/retained/update-customer/1.json');
    await writeFile(retained, beforeRotation); await chmod(retained, 0o600);
    assert.ok((await store.readPrivate('raw/retained/update-customer/1.json')).toString().includes('update-customer'), 'v1 decrypts while the v1 key is retained');
    const second = await store.rotateRawKey(trail, 1);
    assert.deepEqual(second.prunedKeyVersions, [2, 1], 'prune removes versions older than the last keep');
    assert.deepEqual(await new KeyRing(keysRoot).versions(), [3], 'the active version is never pruned');
    assert.ok((await store.readPrivate('raw/unit/update-customer/1.json')).toString().includes('update-customer'), 'the rotated active domain still reads fine');
    // Fail-closed: a sealed-junk sweep target (versioned with the ACTIVE key, bad tag) aborts rotation before any audit entry is recorded.
    await writeFile(retained, Buffer.concat([Buffer.from(MAGIC, 'latin1'), (() => { const view = Buffer.alloc(4); view.writeUInt32BE(3); return view; })(), new Uint8Array(12), new Uint8Array(16), Buffer.from('junk')]));
    const before = trail.snapshot().length;
    await assert.rejects(store.rotateRawKey(trail), ArtifactAuthFailureError);
    assert.equal(trail.snapshot().length, before, 'aborted rotation records nothing');
    // With the v1 key pruned, a file still sealed with v1 can no longer decrypt.
    const stuck = await store.privatePath('raw/stuck/update-customer/1.json');
    await writeFile(stuck, beforeRotation); await chmod(stuck, 0o600);
    await assert.rejects(store.readPrivate('raw/stuck/update-customer/1.json'), ArtifactAuthFailureError, 'pruned key versions cannot decrypt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup retention archives expired raw files by generation, honours the cap and refuses bad roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-backup-'));
  const backup = await mkdtemp(join(tmpdir(), 'harness-backup-to-'));
  try {
    const store = new ArtifactStore(root, join(root, 'private'), { encryptPrivate: true, keysRoot: join(root, 'keys'), backup: { root: backup, keepGenerations: 2 } });
    const clock = Date.now() + 10_000;
    for (const [offset, runIndex] of [[1, 1], [2, 2], [3, 3]].map(([o, r]) => [o, r])) {
      await store.writeRaw('unit', rawTrace(runIndex));
      assert.equal(await store.purgeRaw(0, clock + offset), 1, 'expired files are removed from the raw domain');
    }
    const generations = (await readdir(backup)).sort();
    assert.equal(generations.length, 2, 'at most keepGenerations recent generations survive');
    assert.equal(generations[0], `gen-${clock + 2}`); assert.equal(generations[1], `gen-${clock + 3}`);
    const archived = await readFile(join(backup, generations[1], 'raw', 'unit', 'update-customer', '3.json'));
    assert.equal(inspectSeal(archived).keyVersion, 1, 'archived copies are sealed under the active key');
    assert.deepEqual(JSON.parse(openSeal(inspectSeal(archived), 1, (await new KeyRing(join(root, 'keys')).active()).bytes).toString()), rawTrace(3), 'backup files decrypt with the same keyring');
    assert.equal((await stat(join(backup, generations[1], 'raw', 'unit', 'update-customer', '3.json'))).mode & 0o777, 0o600);
    // Backup directory modes are enforced at use time.
    await chmod(backup, 0o755);
    await store.writeRaw('unit', rawTrace(4));
    await assert.rejects(store.purgeRaw(0, clock + 5), /mode 0700/);
    await chmod(backup, 0o700);
    // Config refusals: never inside the public artifact root, never the raw root or nested with it.
    assert.throws(() => new ArtifactStore(root, join(root, 'private'), { backup: { root: join(root, 'inside') } }), /public artifact root/);
    assert.throws(() => new ArtifactStore(root, join(root, 'private'), { backup: { root: join(root, 'private', 'raw') } }), /public artifact root/);
    const outside = await mkdtemp(join(tmpdir(), 'harness-raw-is-'));
    try {
      assert.throws(() => new ArtifactStore(root, outside, { backup: { root: join(outside, 'raw') } }), /separate from the raw/);
      assert.throws(() => new ArtifactStore(root, outside, { backup: { root: outside } }), /separate from the raw/);
      assert.throws(() => new ArtifactStore(root, join(root, 'private'), { keysRoot: join(root, 'private', 'raw', 'keys') }), /inside the raw root/);
    } finally { await rm(outside, { recursive: true, force: true }); }
    // Without backup configuration the plaintext unlink behavior is unchanged.
    const plain = new ArtifactStore(root, join(root, 'private-none'));
    await plain.writeRaw('unit', rawTrace(5));
    assert.equal(await plain.purgeRaw(0, Date.now() + 1000), 1);
    await assert.rejects(plain.readPrivate('raw/unit/update-customer/5.json'), error => error.code === 'ENOENT');
  } finally { await rm(root, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true }); }
});

test('external audit anchoring appends, chains and refuses private-domain or symlinked targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-anchor-'));
  try {
    const store = new ArtifactStore(root, join(root, 'private'));
    const trail = new AuditTrail(); trail.record('TEST', { ok: true });
    const external = join(root, 'ops', 'anchor.log');
    const first = await anchorAudit({ entries: trail.snapshot(), externalPath: external, privateRoots: [store.privateRoot], timestamp: '2026-09-06T00:00:00.000Z' });
    assert.equal(first.anchor.chainHeadHash, trail.snapshot()[0].hash);
    assert.equal(first.anchor.previousAnchorHash, undefined);
    assert.deepEqual((await readFile(external, 'utf8')).trim().split('\n').length, 1);
    assert.equal(JSON.parse((await readFile(external, 'utf8')).trim().split('\n')[0]).anchoredAt, '2026-09-06T00:00:00.000Z');
    assert.equal(verifyAudit(first.entries), true, 'the returned chain carries the AUDIT_ANCHORED event');
    assert.equal(first.entries.at(-1).action, 'AUDIT_ANCHORED');
    // A second anchor chains through the external file's previous line, not the in-memory state.
    const persisted = JSON.parse(JSON.stringify(first.entries));
    const second = await anchorAudit({ entries: persisted, externalPath: external, privateRoots: [store.privateRoot] });
    assert.equal(second.anchor.previousAnchorHash, first.anchor.chainHeadHash);
    assert.equal(second.anchor.chainHeadHash, persisted.at(-1).hash, 'head is the chain state at anchoring time, covering the first anchor event');
    assert.equal(verifyAudit(second.entries), true);
    const lines = (await readFile(external, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    // Refusals: private domain by literal segment and by resolved private root, symlinked targets, corrupt chains.
    await assert.rejects(anchorAudit({ entries: persisted, externalPath: join(root, '.migration-private', 'x.log'), privateRoots: [store.privateRoot] }), /private artifact domain/);
    await assert.rejects(anchorAudit({ entries: persisted, externalPath: join(store.privateRoot, 'x.log'), privateRoots: [store.privateRoot] }), /private artifact domain/);
    await mkdir(join(root, 'rawlike', '.migration-private'), { recursive: true });
    await assert.rejects(anchorAudit({ entries: persisted, externalPath: join(root, 'rawlike', '.migration-private', 'x.log'), privateRoots: [] }), /private artifact domain/);
    const linked = join(root, 'symlinked.log');
    await symlink(external, linked);
    await assert.rejects(anchorAudit({ entries: persisted, externalPath: linked, privateRoots: [store.privateRoot] }), /symlink/);
    await assert.rejects(anchorAudit({ entries: { not: 'an array' }, externalPath: external, privateRoots: [] }), /must be an array/);
    const corrupt = structuredClone(persisted); corrupt[0].data.ok = false;
    await assert.rejects(anchorAudit({ entries: corrupt, externalPath: external, privateRoots: [] }), /corrupt/);
    // A pre-existing external file with a garbage trailing line is refused rather than chained blindly.
    const garbage = join(root, 'garbage.log');
    await writeFile(garbage, 'not json\n');
    await assert.rejects(anchorAudit({ entries: persisted, externalPath: garbage, privateRoots: [] }), /unparseable trailing line/);
    const empty = join(root, 'empty.log');
    await writeFile(empty, '\n\n  \n');
    const blank = await anchorAudit({ entries: persisted, externalPath: empty, privateRoots: [] });
    assert.equal(blank.anchor.previousAnchorHash, undefined, 'whitespace-only file behaves like a fresh anchor chain');
  } finally { await rm(root, { recursive: true, force: true }); }
});
