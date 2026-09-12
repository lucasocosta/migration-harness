import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, lstat, unlink } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

/**
 * AES-256-GCM sealing for the private raw artifact domain. File layout:
 *   magic 'MHAES001' (8 ASCII) | keyVersion (u32 BE) | iv (12B) | authTag (16B) | ciphertext
 * Absence of the magic marks a legacy plaintext file, which readers pass through unchanged.
 */
const MAGIC = 'MHAES001';
const HEADER_BYTES = MAGIC.length + 4 + 12 + 16;

export class ArtifactAuthFailureError extends Error {
  readonly code = 'ARTIFACT_AUTH_FAILURE';
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactAuthFailureError';
  }
}

export interface DataKey { version: number; bytes: Buffer }
export interface SealedParts { keyVersion: number; iv: Buffer; tag: Buffer; ciphertext: Buffer }

export function seal(key: DataKey, plaintext: Buffer): Buffer {
  // A fresh random 96-bit IV per seal, the AES-GCM construction Node recommends for random IVs.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt32BE(key.version, MAGIC.length);
  iv.copy(header, MAGIC.length + 4);
  cipher.getAuthTag().copy(header, MAGIC.length + 4 + 12);
  return Buffer.concat([header, ciphertext]);
}

/** Returns undefined for legacy plaintext (no magic), so callers decide how to pass it through. */
export function inspectSeal(bytes: Buffer): SealedParts | undefined {
  if (bytes.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) return undefined;
  if (bytes.length < HEADER_BYTES) throw new ArtifactAuthFailureError('Truncated sealed artifact header.');
  return {
    keyVersion: bytes.readUInt32BE(MAGIC.length),
    iv: bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + 12),
    tag: bytes.subarray(MAGIC.length + 4 + 12, HEADER_BYTES),
    ciphertext: bytes.subarray(HEADER_BYTES),
  };
}

export function openSeal(sealed: SealedParts, keyVersion: number, key: Buffer): Buffer {
  if (sealed.keyVersion !== keyVersion) throw new ArtifactAuthFailureError(`Sealed with key version ${sealed.keyVersion}; version ${keyVersion} was offered.`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    throw new ArtifactAuthFailureError('Artifact authentication failed: sealed content is tampered or the key is wrong.');
  }
}

/**
 * Versioned data keys in a dedicated directory (never inside the raw root): mode 0700 directory,
 * 0600 hex key files `v<N>.hex`, refusal to proceed on wrong modes, mirroring the private-root discipline.
 */
export class KeyRing {
  constructor(readonly keysRoot: string) {}
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.keysRoot, { recursive: true, mode: 0o700 });
    if (await realpath(this.keysRoot) !== resolve(this.keysRoot)) throw new Error('Key directory must not contain symlinks.');
    if ((await lstat(this.keysRoot)).mode & 0o077) throw new Error('Key filesystem must enforce mode 0700.');
  }
  async versions(): Promise<number[]> {
    await this.ensureDirectory();
    const found: number[] = [];
    for (const entry of await readdir(this.keysRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Key files cannot be symlinks.');
      const match = /^v(\d+)\.hex$/.exec(entry.name);
      if (match) {
        const version = Number(match[1]);
        if (!entry.isFile() || !Number.isSafeInteger(version) || version < 1 || version > 0xffffffff || String(version) !== match[1]) throw new Error('Invalid key version file.');
        found.push(version);
      }
    }
    return found.sort((a, b) => a - b);
  }
  async active(): Promise<DataKey> {
    const versions = await this.versions();
    if (!versions.length) return this.generate();
    return this.at(versions[versions.length - 1]!);
  }
  async generate(): Promise<DataKey> {
    await this.ensureDirectory();
    return withFileLock(join(this.keysRoot, '.keyring.lock'), async () => {
    const versions = await this.versions();
    const version = (versions.length ? versions[versions.length - 1]! : 0) + 1;
    if (version > 0xffffffff) throw new Error('Key version space exhausted.');
    const bytes = randomBytes(32);
    const path = join(this.keysRoot, `v${version}.hex`);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let complete = false;
    try {
      if ((await handle.stat()).mode & 0o077) throw new Error('Key file filesystem must enforce mode 0600.');
      await handle.writeFile(`${bytes.toString('hex')}\n`);
      await handle.sync();
      complete = true;
    } finally { await handle.close(); if (!complete) await unlink(path); }
    return { version, bytes };
    });
  }
  async at(version: number): Promise<DataKey> {
    if (!Number.isSafeInteger(version) || version < 1 || version > 0xffffffff) throw new ArtifactAuthFailureError('Invalid key version.');
    await this.ensureDirectory();
    let raw: string;
    try {
      const handle = await open(join(this.keysRoot, `v${version}.hex`), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 66) throw new ArtifactAuthFailureError('Key must be a private unlinked regular file (0600).');
        raw = await handle.readFile('utf8');
      } finally { await handle.close(); }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactAuthFailureError(`Key version ${version} is unavailable (pruned or never issued).`);
      if (error instanceof ArtifactAuthFailureError) throw error;
      throw new ArtifactAuthFailureError(`Key version ${version} cannot be read.`);
    }
    const hex = raw.trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new ArtifactAuthFailureError(`Key version ${version} is malformed.`);
    return { version, bytes: Buffer.from(hex, 'hex') };
  }
  /** Deletes every version older than the last `keep`; the active (highest) version is never pruned. */
  async prune(keep: number): Promise<number[]> {
    if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Invalid key prune budget.');
    const descending = (await this.versions()).sort((a, b) => b - a);
    const doomed = descending.slice(keep);
    for (const version of doomed) await rm(join(this.keysRoot, `v${version}.hex`));
    return doomed;
  }
}

/** Exclusive temp write (0600, O_NOFOLLOW, symlinked directory refused) followed by an atomic rename over the target. */
export async function replaceFileAtomically(target: string, content: Buffer | string, mode: number): Promise<void> {
  target = resolve(target);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error('Sealed artifact directory must not be a symlink.');
  const previous = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (previous && (!previous.isFile() || previous.nlink !== 1)) throw new Error('Sealed artifact target must be an unlinked regular file.');
  const temporary = join(directory, `.sealing-${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try {
      if ((await handle.stat()).mode & 0o077) throw new Error('Sealed artifact files must enforce mode 0600.');
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Cooperative exclusion only; stale locks after crashes require operator recovery. */
export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('Lock directory cannot contain symlinks.');
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { return await operation(); }
  finally { await handle.close(); await unlink(path); }
}
