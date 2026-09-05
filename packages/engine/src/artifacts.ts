import { mkdir, open, readdir, lstat, realpath, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { canonical, parseRawTrace, parseSanitizedTrace, type RawObservedTrace, type SanitizedObservedTrace } from '@migration-harness/core';

export class ArtifactStore {
  readonly privateRoot: string;
  constructor(readonly root: string, privateRoot?: string) {
    this.privateRoot = resolve(privateRoot ?? join(homedir(), '.local/state/migration-harness', createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24)));
  }
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
    if (!privateArtifact && containsRawTrace(value)) throw new Error('Raw traces cannot be written to the public artifact domain.');
    const relativePath = path.replace(/^\.migration-private\//, '');
    const target = privateArtifact ? await this.privatePath(relativePath) : await safeArtifactPath(this.root, path);
    await mkdir(dirname(target), { recursive: true, mode: privateArtifact ? 0o700 : 0o755 });
    await safeArtifactPath(privateArtifact ? this.privateRoot : this.root, privateArtifact ? relativePath : path);
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, privateArtifact ? 0o600 : 0o644);
    try {
      const resolved = await realpath(target), linked = await lstat(target), opened = await file.stat();
      if (resolved !== target || linked.ino !== opened.ino || linked.dev !== opened.dev) throw new Error('Artifact path changed during creation.');
      if (privateArtifact && (await file.stat()).mode & 0o077) throw new Error('Private artifact filesystem must enforce mode 0600.');
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    } finally { await file.close(); }
    return target;
  }
  async purgeRaw(retentionMs: number, now = Date.now()): Promise<number> {
    if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new Error('Invalid raw retention.');
    const rawRoot = await this.privatePath('raw');
    let removed = 0;
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
        const file = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Symlink in raw artifact domain.');
        if (entry.isDirectory()) await walk(file);
        else if (now - (await lstat(file)).mtimeMs >= retentionMs) { await unlink(file); removed++; }
      }
    };
    await walk(rawRoot);
    return removed;
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
