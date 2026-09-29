import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArtifactStore, safeArtifactPath, privateBaseDir, pathSegments, isWithin } from '@migration-harness/engine';
import { assertCandidatePath, fileHash, type CandidatePatch } from '@migration-harness/llm-worker';

const inside = (root: string, path: string): boolean => isWithin(root, path) || resolve(root) === resolve(path);

/**
 * Canonical spelling of a path: symlinks resolved on the nearest existing ancestor with any missing
 * suffix reattached, so a destination that does not exist yet is still validated where it would land.
 */
async function canonicalPath(path: string): Promise<string> {
  const target = resolve(path);
  let ancestor = target;
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, target)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
}

/**
 * Every private root for assistant-facing access, in lexical and canonical spellings: the store's
 * private, keys and backup roots plus the private state root resolved by `privateBaseDir()`
 * (env override or default user state directory). Comparing both spellings of a root is what lets an
 * override or root that is itself reached through a symlink still match a resolved candidate;
 * segment matching and containment split both path separators, so Windows spellings are covered too.
 */
async function privateRoots(store: ArtifactStore): Promise<string[]> {
  const roots = new Set<string>();
  for (const root of [store.privateRoot, store.keysRoot, ...(store.options.backup ? [resolve(store.options.backup.root)] : []), privateBaseDir()]) {
    roots.add(resolve(root));
    try { roots.add(await canonicalPath(root)); } catch { /* keep the lexical spelling */ }
  }
  return [...roots];
}

/** Refuse one spelling that carries a private segment or sits inside a private root. */
function assertPublicSpelling(value: string, roots: readonly string[]): void {
  if (pathSegments(value).includes('.migration-private') || roots.some(root => inside(root, value))) throw new Error('Assistant-facing paths cannot resolve inside the private artifact domain.');
}

/** Validate the lexical and the canonical spelling of a path against every private root. */
async function resolvePublicPath(path: string, store: ArtifactStore): Promise<{ target: string; canonical: string }> {
  const target = resolve(path);
  const roots = await privateRoots(store);
  assertPublicSpelling(target, roots);
  const canonical = await canonicalPath(target);
  assertPublicSpelling(canonical, roots);
  return { target, canonical };
}

/** Check both lexical and resolved paths before reading any assistant-facing input. */
export async function publicPath(path: string, store: ArtifactStore): Promise<string> {
  return (await resolvePublicPath(path, store)).target;
}

/** Identity of a validated public file: the canonical spelling plus the dev/ino it names right now. */
export interface PublicFile { target: string; canonical: string; dev: number; ino: number; }

/**
 * Validate an assistant-facing file and capture the object identity that the later open must see,
 * so the read is bound to this validated object instead of the unchecked lexical spelling.
 */
export async function publicFile(path: string, store: ArtifactStore): Promise<PublicFile> {
  const { target, canonical } = await resolvePublicPath(path, store);
  const stat = await lstat(canonical);
  return { target, canonical, dev: stat.dev, ino: stat.ino };
}

/**
 * Open a validated public file: the canonical spelling must still be the validated one and the
 * descriptor must name the captured dev/ino, so an ancestor swapped for a symlink or a replaced
 * leaf between validation and open is refused before any byte is read. O_NOFOLLOW covers only the
 * final component. Residual limitation: Node has no openat(2), so a swap swapped back inside this
 * window, or a hard link to the very same inode, cannot be detected in-process — the binding
 * narrows the race rather than closing it.
 */
export async function openPublicFile(file: PublicFile): Promise<FileHandle> {
  const handle = await open(file.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const canonical = await canonicalPath(file.target);
    if (canonical !== file.canonical || stat.dev !== file.dev || stat.ino !== file.ino) throw new Error('Assistant-facing path changed during access.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function readPublicJson(path: string, store: ArtifactStore, maxBytes = 4_000_000): Promise<unknown> {
  const handle = await openPublicFile(await publicFile(path, store));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Input exceeds the size cap or is not a regular file.');
    // Read once, up to the cap, so file growth cannot bypass the pre-read size check.
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > maxBytes) throw new Error('Input exceeds the size cap.');
    return JSON.parse(buffer.subarray(0, used).toString('utf8')) as unknown;
  } finally { await handle.close(); }
}

export async function candidateFile(root: string, path: string, allowed: string[], store: ArtifactStore): Promise<{ target: string; content?: string }> {
  assertCandidatePath(path, allowed);
  const target = await publicPath(await safeArtifactPath(root, path), store);
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('Candidate boundary requires an unlinked regular file.');
  if (!stat) return { target };
  if (stat.size > 2_000_000) throw new Error('Candidate exceeds the file size cap.');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return { target, content: await handle.readFile('utf8') }; } finally { await handle.close(); }
}

export async function withAssistantLock<T>(store: ArtifactStore, candidateRoot: string, work: () => Promise<T>): Promise<T> {
  const locks = [...new Set([resolve(store.root, '.harness-assistant.lock'), resolve(candidateRoot, '.harness-assistant.lock')])].sort();
  const held: string[] = [];
  try {
    for (const lock of locks) {
      await publicPath(lock, store);
      await safeArtifactPath(dirname(lock), '.harness-assistant.lock');
      await mkdir(dirname(lock), { recursive: true });
      const handle = await open(lock, 'wx'); await handle.close(); held.push(lock);
    }
    return await work();
  } finally { for (const lock of held.reverse()) await unlink(lock); }
}

export async function replacePublic(store: ArtifactStore, path: string, value: unknown): Promise<void> {
  const target = await publicPath(await safeArtifactPath(store.root, path), store);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const temporary = await safeArtifactPath(store.root, temporaryPath);
  let cleanup = true;
  try { await store.write(temporaryPath, value); await safeArtifactPath(store.root, path); await rename(temporary, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') cleanup = false; throw error; }
  finally { if (cleanup) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Keep handled persistence failures from leaving success records for rolled-back files. */
export async function writePublicBatch(store: ArtifactStore, entries: Array<{ path: string; value: unknown; replace?: boolean }>): Promise<void> {
  const written: Array<{ path: string; previous: unknown; existed: boolean }> = [];
  try {
    for (const entry of entries) {
      const target = await publicPath(await safeArtifactPath(store.root, entry.path), store);
      let previous: unknown, existed = false;
      try { previous = await readPublicJson(target, store, 10_000_000); existed = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existed && !entry.replace) throw new Error('Assistant archive entry already exists.');
      written.push({ path: entry.path, previous, existed });
      try {
        if (entry.replace) await replacePublic(store, entry.path, entry.value);
        else await store.write(entry.path, entry.value);
      } catch (error) {
        if (!entry.replace && (error as NodeJS.ErrnoException).code === 'EEXIST') written.pop();
        throw error;
      }
    }
  } catch (error) {
    for (const entry of written.reverse()) {
      if (entry.existed) await replacePublic(store, entry.path, entry.previous);
      else await unlink(await safeArtifactPath(store.root, entry.path)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    throw error;
  }
}

/** Roll back handled write failures. This is not a filesystem transaction across process crashes. */
export async function applyCandidateBatch(root: string, patches: CandidatePatch[], store: ArtifactStore, persist: () => Promise<void>): Promise<void> {
  const prepared: Array<{ target: string; temporary: string; backup?: string; existed: boolean; beforeHash: string }> = [];
  const committed: typeof prepared = [];
  const allowed = patches.map(patch => patch.path);
  try {
    for (const patch of patches) {
      const current = await candidateFile(root, patch.path, allowed, store);
      if (fileHash(current.content ?? '') !== patch.beforeHash) throw new Error('Candidate baseline changed before application.');
      await mkdir(dirname(current.target), { recursive: true });
      const temporary = `${current.target}.${randomUUID()}.tmp`;
      const entry = { target: current.target, temporary, existed: current.content !== undefined, beforeHash: patch.beforeHash, ...(current.content !== undefined ? { backup: `${current.target}.${randomUUID()}.backup` } : {}) };
      prepared.push(entry);
      for (const [path, content] of [[temporary, patch.content], ...(entry.backup ? [[entry.backup, current.content!]] : [])] as Array<[string, string]>) {
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      }
    }
    for (const [index, entry] of prepared.entries()) {
      const current = await candidateFile(root, patches[index]!.path, allowed, store);
      if (fileHash(current.content ?? '') !== entry.beforeHash || (current.content !== undefined) !== entry.existed) throw new Error('Candidate baseline changed during application.');
      await rename(entry.temporary, entry.target); committed.push(entry);
    }
    await persist();
  } catch (error) {
    for (const entry of committed.reverse()) {
      if (entry.backup) await rename(entry.backup, entry.target);
      else await unlink(entry.target);
    }
    throw error;
  } finally {
    for (const entry of prepared) for (const path of [entry.temporary, entry.backup]) if (path) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
