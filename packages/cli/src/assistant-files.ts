import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArtifactStore, safeArtifactPath, privateBaseDir, pathSegments, isWithin } from '@migration-harness/engine';
import { assertCandidatePath, fileHash, type CandidatePatch } from '@migration-harness/llm-worker';

const inside = (root: string, path: string): boolean => isWithin(root, path) || resolve(root) === resolve(path);

/** Check both lexical and resolved paths before reading any assistant-facing input. */
export async function publicPath(path: string, store: ArtifactStore): Promise<string> {
  const check = (value: string): void => {
    if (pathSegments(value).includes('.migration-private') || [store.privateRoot, store.keysRoot, ...(store.options.backup ? [resolve(store.options.backup.root)] : []), privateBaseDir()].some(root => inside(root, value))) throw new Error('Assistant-facing paths cannot resolve inside the private artifact domain.');
  };
  const target = resolve(path);
  check(target);
  let ancestor = target;
  while (true) {
    try { check(resolve(await realpath(ancestor), relative(ancestor, target))); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  return target;
}

export async function readPublicJson(path: string, store: ArtifactStore, maxBytes = 4_000_000): Promise<unknown> {
  const target = await publicPath(path, store);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
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
