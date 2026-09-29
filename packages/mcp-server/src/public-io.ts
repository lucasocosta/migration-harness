/**
 * Canonical bounded reader for assistant-facing MCP inputs (config and preparation).
 * Mirrors packages/cli/src/assistant-files.ts publicPath/readPublicJson without an
 * ArtifactStore: the private roots are the `.migration-private` segment, the
 * `migration-harness-private` marker and the private state root resolved through
 * MIGRATION_HARNESS_STATE_DIR or privateBaseDir()'s platform default. Each root is
 * collected in BOTH its lexical and its canonical (symlink-resolved) spelling, the same
 * way the CLI's privateRoots() does, so an override that names a symlink is caught
 * whether the candidate is spelled through the alias or through the real directory it
 * points at. Windows separators are normalized before resolution, and the lexical and
 * the symlink-resolved candidate are both screened, so a public-looking link into
 * private storage is refused instead of followed (AGENTS.md §4). Reads are bound to the
 * dev/ino captured at validation time: an O_NOFOLLOW open, an fd identity check and a
 * canonical re-check at access. Residual limitation, documented identically by the CLI
 * reader: Node has no openat(2), so the binding narrows the check-then-open race
 * instead of closing it — the local workspace is trusted and non-adversarial.
 */
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { isWithin, pathSegments, privateBaseDir, toPosix, PRIVATE_STATE_FRAGMENT } from '@migration-harness/core';

const PRIVATE_MARKERS = ['.migration-private', 'migration-harness-private', PRIVATE_STATE_FRAGMENT];

const inside = (root: string, path: string): boolean => isWithin(root, path) || resolve(root) === resolve(path);

/** A backslash is a separator for the screen on every OS, never a filename byte. */
const normalizeSeparators = (path: string): string => path.replace(/\\/g, '/');

/**
 * Canonical spelling of a path: symlinks resolved on the nearest existing ancestor with any
 * missing suffix reattached, so a path that does not exist yet is still validated where it
 * would land. Same walk as packages/cli/src/assistant-files.ts.
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
 * The private state root in both spellings, mirroring the CLI's privateRoots(): the lexical
 * spelling is what MIGRATION_HARNESS_STATE_DIR or the platform default names, the canonical
 * spelling is where that name lands once symlinks resolve. An override naming a symlink
 * carries no private marker and its lexical prefix does not contain the real directory, so
 * only the canonical spelling of the root catches a candidate spelled with the real
 * directory. The engine's store, keys and backup roots all live under this state root in the
 * default layout this channel uses (no configured ArtifactStore is reachable here to carry
 * overrides outside it); the marker screen below still covers both candidate spellings.
 */
async function privateRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const root of [privateBaseDir()]) {
    roots.add(resolve(root));
    try { roots.add(await canonicalPath(root)); } catch { /* keep the lexical spelling */ }
  }
  return [...roots];
}

/** Refuse one spelling that carries a private marker or sits inside any private root. */
function assertPublic(value: string, label: string, roots: readonly string[]): void {
  const posix = toPosix(value);
  if (pathSegments(value).includes('.migration-private')
    || PRIVATE_MARKERS.some(marker => posix.includes(marker))
    || roots.some(root => inside(root, value))) {
    throw new Error(`ASSISTANT_CHANNEL_PRIVATE_PATH:${label}`);
  }
}

/** Screen the lexical and the canonical spelling of a candidate against every private root. */
async function resolvePublicPath(path: string, label: string): Promise<{ target: string; canonical: string }> {
  const target = resolve(normalizeSeparators(path));
  const roots = await privateRoots();
  assertPublic(target, label, roots);
  const canonical = await canonicalPath(target);
  assertPublic(canonical, label, roots);
  return { target, canonical };
}

/** Check both spellings of the path before any assistant-facing read. */
export async function publicPath(path: string, label: string): Promise<string> {
  return (await resolvePublicPath(path, label)).target;
}

/** Identity of a validated public file: the canonical spelling plus the dev/ino it names right now. */
interface PublicFile { target: string; canonical: string; dev: number; ino: number; }

/**
 * Validate an assistant-facing file and capture the object identity that the later open must
 * see, so the read is bound to this validated object instead of the unchecked lexical spelling.
 */
async function publicFile(path: string, label: string): Promise<PublicFile> {
  const { target, canonical } = await resolvePublicPath(path, label);
  let stat: Stats;
  try {
    stat = await lstat(canonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Stable codes only: raw errno messages echo the path.
    if (code === 'ENOENT') throw new Error(`INPUT_FILE_MISSING:${label}`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`INPUT_FILE_UNREADABLE:${label}`);
    throw error;
  }
  return { target, canonical, dev: stat.dev, ino: stat.ino };
}

/**
 * Open a validated public file: the canonical spelling must still resolve inside public space
 * and the descriptor must name the captured dev/ino, so an ancestor swapped for a symlink or a
 * replaced leaf between validation and open is refused before any byte is read. O_NOFOLLOW
 * covers only the final component. Residual limitation, documented identically in
 * packages/cli/src/assistant-files.ts: Node has no openat(2), so a swap swapped back inside
 * this window, or a hard link to the very same inode, cannot be detected in-process — the
 * binding narrows the race rather than closing it, on the trusted, non-adversarial local
 * workspace this reader assumes.
 */
async function openPublicFile(file: PublicFile, label: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(file.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Stable codes only: raw errno messages echo the path.
    if (code === 'ENOENT') throw new Error(`INPUT_FILE_MISSING:${label}`);
    if (code === 'ELOOP') throw new Error(`INPUT_FILE_SYMLINK:${label}`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`INPUT_FILE_UNREADABLE:${label}`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    const canonical = await canonicalPath(file.target);
    assertPublic(canonical, label, await privateRoots());
    if (canonical !== file.canonical || stat.dev !== file.dev || stat.ino !== file.ino) throw new Error(`INPUT_FILE_CHANGED:${label}`);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Bounded single-read JSON input: no symlink leaf, no size bypass, no file content in errors. */
export async function readPublicJson(path: string, label: string, maxBytes = 4_000_000): Promise<unknown> {
  const handle = await openPublicFile(await publicFile(path, label), label);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`INPUT_FILE_INVALID:${label}`);
    // Read once, up to the cap, so file growth cannot bypass the pre-read size check.
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > maxBytes) throw new Error(`INPUT_FILE_INVALID:${label}`);
    try {
      return JSON.parse(buffer.subarray(0, used).toString('utf8')) as unknown;
    } catch {
      // Parse diagnostics quote file content; the label is the whole story an agent needs.
      throw new Error(`INPUT_FILE_NOT_JSON:${label}`);
    }
  } finally { await handle.close(); }
}
