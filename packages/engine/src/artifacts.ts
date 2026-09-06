import { mkdir, open, readdir, lstat, realpath, rm, unlink, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { canonical, parseRawTrace, parseSanitizedTrace, type RawObservedTrace, type SanitizedObservedTrace } from '@migration-harness/core';
import { ArtifactAuthFailureError, inspectSeal, KeyRing, openSeal, replaceFileAtomically, seal, withFileLock } from './sealing.js';

export interface ArtifactBackupOptions {
  /** Separate archive root for expired raw files. Never inside the public artifact root, the raw root, or containing it. */
  root: string;
  /** Most recent generations kept after each purge; defaults to 5 when unset. */
  keepGenerations?: number;
}

export interface ArtifactStoreOptions {
  /** Opt-in AES-256-GCM sealing of private raw-domain writes; default off leaves behavior byte-identical. */
  encryptPrivate?: boolean;
  /** Versioned data-key directory. Must be separate from the raw root; defaults to a `keys` sibling under the private root. */
  keysRoot?: string;
  backup?: ArtifactBackupOptions;
}

export class ArtifactStore {
  readonly privateRoot: string;
  readonly options: ArtifactStoreOptions & { backup?: ArtifactBackupOptions & { keepGenerations: number } };
  constructor(readonly root: string, privateRoot?: string, options: ArtifactStoreOptions = {}) {
    this.privateRoot = resolve(privateRoot ?? join(homedir(), '.local/state/migration-harness', createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24)));
    const { backup, ...rest } = options;
    this.options = { ...rest, ...(backup ? { backup: { ...backup, keepGenerations: backup.keepGenerations ?? 5 } } : {}) };
    const inside = (base: string, candidate: string): boolean => { const rel = relative(resolve(base), candidate); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
    const rawRoot = join(this.privateRoot, 'raw');
    if (options.keysRoot) {
      const keys = resolve(options.keysRoot);
      if (keys === rawRoot || inside(rawRoot, keys)) throw new Error('Keys root cannot live inside the raw root.');
    }
    if (this.options.backup) {
      const backup = resolve(this.options.backup.root);
      if (!Number.isSafeInteger(this.options.backup.keepGenerations) || this.options.backup.keepGenerations < 1) throw new Error('Invalid backup generation budget.');
      if (backup === resolve(this.root) || inside(this.root, backup)) throw new Error('Backup root cannot live inside the public artifact root.');
      if (backup === rawRoot || inside(rawRoot, backup) || inside(backup, rawRoot)) throw new Error('Backup root must be separate from the raw artifact domain.');
    }
  }
  get keysRoot(): string { return resolve(this.options.keysRoot ?? join(this.privateRoot, 'keys')); }
  private keyRing(): KeyRing { return new KeyRing(this.keysRoot); }
  async privatePath(path: string): Promise<string> {
    await mkdir(this.privateRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(this.privateRoot)).mode & 0o077) throw new Error('Private artifact filesystem must enforce mode 0700.');
    const target = await safeArtifactPath(this.privateRoot, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    let directory = dirname(target);
    while (directory !== dirname(this.privateRoot)) {
      if ((await lstat(directory)).mode & 0o077) throw new Error('Private artifact directory is accessible to other users.');
      if (directory === this.privateRoot) break;
      directory = dirname(directory);
    }
    return target;
  }
  async writeRaw(unitId: string, trace: RawObservedTrace): Promise<string> {
    const value = parseRawTrace(trace);
    return this.write(`.migration-private/raw/${segment(unitId)}/${segment(value.scenarioId)}/${value.runIndex}.json`, value, true);
  }
  async writeSanitized(unitId: string, side: 'source' | 'target', trace: SanitizedObservedTrace): Promise<string> {
    const value = parseSanitizedTrace(trace);
    return this.write(`artifacts/units/${segment(unitId)}/${segment(value.scenarioId)}/${side}/${value.runIndex}.sanitized.json`, value);
  }
  async write(path: string, value: unknown, privateArtifact = false): Promise<string> {
    privateArtifact = privateArtifact || path.startsWith('.migration-private/');
    if (privateArtifact && path.replace(/^\.migration-private\//, '').startsWith('raw/')) {
      return withFileLock(await this.privatePath('.lifecycle.lock'), () => this.writeArtifact(path, value, true));
    }
    return this.writeArtifact(path, value, privateArtifact);
  }
  private async writeArtifact(path: string, value: unknown, privateArtifact: boolean): Promise<string> {
    if (!privateArtifact && containsRawTrace(value)) throw new Error('Raw traces cannot be written to the public artifact domain.');
    const relativePath = path.replace(/^\.migration-private\//, '');
    const target = privateArtifact ? await this.privatePath(relativePath) : await safeArtifactPath(this.root, path);
    await mkdir(dirname(target), { recursive: true, mode: privateArtifact ? 0o700 : 0o755 });
    await safeArtifactPath(privateArtifact ? this.privateRoot : this.root, privateArtifact ? relativePath : path);
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = privateArtifact && this.options.encryptPrivate && relativePath.startsWith('raw/')
      ? seal(await this.keyRing().active(), Buffer.from(payload)) : payload;
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, privateArtifact ? 0o600 : 0o644);
    try {
      const resolved = await realpath(target), linked = await lstat(target), opened = await file.stat();
      if (resolved !== target || linked.ino !== opened.ino || linked.dev !== opened.dev) throw new Error('Artifact path changed during creation.');
      if (privateArtifact && (await file.stat()).mode & 0o077) throw new Error('Private artifact filesystem must enforce mode 0600.');
      // Sealing covers the raw subtree of the private domain only when opted in; everything else keeps the
      // existing byte-exact plaintext behavior (keys never live under raw, so a seal can never key itself).
      await file.writeFile(bytes);
    } finally { await file.close(); }
    return target;
  }
  /** Reads a private-domain file, transparently unsealing it. Legacy plaintext bytes come back unchanged. */
  async readPrivate(path: string): Promise<Buffer> {
    return this.unsealBytes(await readFile(await this.privatePath(path)));
  }
  private async unsealBytes(bytes: Buffer): Promise<Buffer> {
    const sealed = inspectSeal(bytes);
    if (!sealed) {
      try { JSON.parse(bytes.toString('utf8')); } catch { throw new ArtifactAuthFailureError('Unrecognized raw artifact: expected sealed content or legacy JSON.'); }
      return bytes;
    }
    const key = await this.keyRing().at(sealed.keyVersion);
    return openSeal(sealed, key.version, key.bytes);
  }
  private async privateFiles(subtree: string): Promise<Array<{ relativePath: string; absolute: string }>> {
    const root = join(this.privateRoot, subtree);
    const found: Array<{ relativePath: string; absolute: string }> = [];
    const walk = async (path: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
        const file = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Symlink in raw artifact domain.');
        if (entry.isDirectory()) await walk(file, `${prefix}${entry.name}/`);
        else found.push({ relativePath: `${prefix}${entry.name}`, absolute: file });
      }
    };
    await this.privatePath(subtree);
    await walk(root, '');
    return found;
  }
  /**
   * Key rotation: issues version N+1 and fail-closed re-seals every raw file with it — any read or write
   * error aborts the sweep before the audit entry is recorded. Old key versions are retained (old-version
   * files keep decrypting) unless pruneKeep drops versions older than the last N; the active version is
   * never pruned. Returns counts for operational reporting.
   */
  async rotateRawKey(audit: AuditTrail, pruneKeep?: number): Promise<{ activeKeyVersion: number; resealed: number; skipped: number; prunedKeyVersions: number[] }> {
    if (!this.options.encryptPrivate) throw new Error('Key rotation requires an encryption-enabled store.');
    // A key can still protect retained backups, other stores or offline copies. Without
    // a complete reference ledger automatic pruning cannot establish safe deletion.
    if (pruneKeep !== undefined) throw new Error('Automatic key pruning is disabled: retained backups or other stores may still require old versions.');
    return withFileLock(await this.privatePath('.lifecycle.lock'), async () => {
    const active = await this.keyRing().generate();
    let resealed = 0, skipped = 0;
    for (const file of await this.privateFiles('raw')) {
      const bytes = await readFile(file.absolute);
      const sealed = inspectSeal(bytes);
      if (sealed && sealed.keyVersion === active.version) { skipped++; continue; }
      await replaceFileAtomically(file.absolute, seal(active, await this.unsealBytes(bytes)), 0o600);
      resealed++;
    }
    const prunedKeyVersions: number[] = [];
    audit.record('RAW_KEY_ROTATION', { activeKeyVersion: active.version, resealed, skipped, prunedKeyVersions });
    return { activeKeyVersion: active.version, resealed, skipped, prunedKeyVersions };
    });
  }
  /**
   * Raw retention. With a backup root configured, expired files move into a per-purge generation
   * (`gen-<now>`, preserving layout relative to the raw root) before deletion, resealed under the active
   * key when encryption is on; generations older than keepGenerations are then dropped. Without backup
   * configuration the behavior is the unchanged plaintext unlink.
   */
  async purgeRaw(retentionMs: number, now = Date.now()): Promise<number> {
    if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new Error('Invalid raw retention.');
    const backup = this.options.backup;
    if (backup && !Number.isSafeInteger(now)) throw new Error('Backup generations require an integer retention clock.');
    return withFileLock(await this.privatePath('.lifecycle.lock'), async () => {
    const rawRoot = await this.privatePath('raw');
    const generation = backup ? join(await this.backupRoot(), `gen-${now}`) : undefined;
    let removed = 0;
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
        const file = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Symlink in raw artifact domain.');
        if (entry.isDirectory()) await walk(file);
        else if (now - (await lstat(file)).mtimeMs >= retentionMs) {
          if (generation) {
            // Preserve the private-domain layout (raw/<unit>/<scenario>/<run>.json) under the generation.
            const relativePath = relative(this.privateRoot, file);
            const archived = resolve(generation, relativePath);
            const archivedRel = relative(generation, archived);
            if (!archivedRel || archivedRel.startsWith('..') || isAbsolute(archivedRel)) throw new Error('Backup path escaped the generation root.');
            // Archived copies are resealed under the current active key when encryption is on; plaintext stays plaintext when off.
            const plaintext = await this.unsealBytes(await readFile(file));
            await replaceFileAtomically(archived, this.options.encryptPrivate ? seal(await this.keyRing().active(), plaintext) : plaintext, 0o600);
          }
          await unlink(file);
          removed++;
        }
      }
    };
    await walk(rawRoot);
    if (backup && generation) {
      const root = resolve(backup.root);
      const generations: string[] = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Symlink in backup artifact domain.');
        if (/^gen-\d+$/.test(entry.name)) generations.push(entry.name);
        else throw new Error('Unexpected entry in backup root.');
      }
      for (const stale of generations.sort((a, b) => Number(b.slice(4)) - Number(a.slice(4))).slice(backup.keepGenerations)) await rm(join(root, stale), { recursive: true, force: true });
    }
    return removed;
    });
  }
  private async backupRoot(): Promise<string> {
    const root = resolve(this.options.backup!.root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).mode & 0o077) throw new Error('Backup artifact filesystem must enforce mode 0700.');
    if (await realpath(root) !== root) throw new Error('Backup root must not be a symlink.');
    return root;
  }
}
function containsRawTrace(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsRawTrace);
  const object = value as Record<string, unknown>;
  if (typeof object.scenarioId === 'string' && Array.isArray(object.events) && object.environment && !object.sanitization) return true;
  return Object.values(object).some(containsRawTrace);
}
export async function safeArtifactPath(root: string, path: string): Promise<string> {
  const base = resolve(root), target = resolve(base, path), rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact path escapes root.');
  let current = base;
  await mkdir(base, { recursive: true });
  if (await realpath(base) !== base) throw new Error('Artifact root must not be a symlink.');
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stat?.isSymbolicLink()) throw new Error('Artifact paths cannot contain symlinks.');
  }
  return target;
}
function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid artifact identifier.');
  return value;
}
export interface AuditEntry { index: number; timestamp: string; action: string; data: unknown; previousHash: string; hash: string; }
export class AuditTrail {
  private entries: AuditEntry[] = [];
  /** Rehydrate a persisted chain (callers must have validated it with verifyAudit) so a CLI process can extend it. */
  static load(entries: AuditEntry[]): AuditTrail {
    if (!verifyAudit(entries)) throw new Error('Existing audit chain is corrupt.');
    const trail = new AuditTrail();
    trail.entries = structuredClone(entries);
    return trail;
  }
  record(action: string, data: unknown): void {
    const entry = { index: this.entries.length, timestamp: new Date().toISOString(), action, data: structuredClone(data), previousHash: this.entries.at(-1)?.hash ?? '' };
    this.entries.push({ ...entry, hash: createHash('sha256').update(canonical(entry)).digest('hex') });
  }
  snapshot(): AuditEntry[] { return structuredClone(this.entries); }
}
export function verifyAudit(entries: AuditEntry[]): boolean {
  return entries.every((entry, index) => {
    const { hash, ...content } = entry;
    return entry.index === index && entry.previousHash === (entries[index - 1]?.hash ?? '') && hash === createHash('sha256').update(canonical(content)).digest('hex');
  });
}

export interface AuditAnchor { previousAnchorHash?: string; chainHeadHash: string; anchoredAt: string }

/**
 * External audit anchoring: appends one JSON line { previousAnchorHash?, chainHeadHash, anchoredAt } to an
 * operator-owned append-only external file (created when missing) and records the matching AUDIT_ANCHORED
 * event in the chain. The external file is an integrity-detection copy of the chain head only: it lets a
 * later reader notice that the chain was rewritten or truncated, but it is NOT a trusted timestamping
 * service — an attacker who controls both files can forge a consistent pair. The target is refused inside
 * the private/raw domain (literal .migration-private segments and every configured private root) and when
 * the target or any existing ancestor segment is a symlink; the append itself uses O_NOFOLLOW.
 */
export async function anchorAudit(input: { entries: unknown; externalPath: string; privateRoots: string[]; timestamp?: string }): Promise<{ anchor: AuditAnchor; entries: AuditEntry[] }> {
  if (!Array.isArray(input.entries)) throw new Error('Audit chain must be an array of hash-chained entries.');
  if (input.entries.some(entry => !entry || typeof entry !== 'object' || typeof (entry as AuditEntry).hash !== 'string' || typeof (entry as AuditEntry).action !== 'string')) throw new Error('Audit chain is corrupt.');
  const trail = AuditTrail.load(structuredClone(input.entries) as AuditEntry[]);
  const chainHeadHash = (input.entries as AuditEntry[]).at(-1)?.hash ?? '';
  const externalPath = resolve(input.externalPath);
  if (externalPath.split(/[\\/]/).includes('.migration-private') || [join(homedir(), '.local/state/migration-harness'), ...input.privateRoots].some(base => { const root = resolve(base); return externalPath === root || (relative(root, externalPath) !== '' && !relative(root, externalPath).startsWith('..') && !isAbsolute(relative(root, externalPath))); })) throw new Error('Audit anchor target cannot live in the private artifact domain.');
  for (let current = externalPath; ;) {
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stat?.isSymbolicLink()) throw new Error('Audit anchor target cannot be a symlink.');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  await mkdir(dirname(externalPath), { recursive: true });
  return withFileLock(`${externalPath}.lock`, async () => {
  const existing = await readFile(externalPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
  let previousAnchorHash: string | undefined;
  const lastLine = existing.split('\n').filter(line => line.trim()).at(-1);
  if (lastLine !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(lastLine) as unknown; } catch { throw new Error('Audit anchor file has an unparseable trailing line.'); }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as AuditAnchor).chainHeadHash !== 'string') throw new Error('Audit anchor file has a malformed trailing line.');
    previousAnchorHash = (parsed as AuditAnchor).chainHeadHash;
  }
  const anchor: AuditAnchor = { ...(previousAnchorHash === undefined ? {} : { previousAnchorHash }), chainHeadHash, anchoredAt: input.timestamp ?? new Date().toISOString() };
  const handle = await open(externalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(anchor)}\n`); } finally { await handle.close(); }
  trail.record('AUDIT_ANCHORED', { ...anchor });
  return { anchor, entries: trail.snapshot() };
  });
}
