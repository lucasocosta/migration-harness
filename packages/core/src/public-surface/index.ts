/**
 * Shared public-surface policy (PLAN-V2 §2.2, auditoria final P2): one parametrized
 * implementation of the guarantees that guard every assistant-facing path read, so the
 * CLI channel (`packages/cli/src/assistant-files.ts`) and the MCP channel
 * (`packages/mcp-server/src/public-io.ts`) enforce the union of the same rules instead of
 * mirroring each other drift-prone.
 *
 * The common policy is the union of both channels' guarantees:
 *  - Windows separators are normalized before resolution, so a backslash spelling is
 *    screened as a separator on every OS.
 *  - A candidate is refused when a segment is `.migration-private`, when its POSIX
 *    spelling carries any private marker (`.migration-private`, `migration-harness-private`
 *    or the private state fragment), or when it sits inside any private root.
 *  - Every private root is collected in BOTH its lexical and its canonical
 *    (symlink-resolved) spelling, and the state root from `privateBaseDir()` is always in
 *    that set, so an env override that names a symlink is caught whether the candidate is
 *    spelled through the alias or the real directory.
 *  - Both the lexical and the canonical spelling of a candidate are screened before any
 *    read, and the canonical spelling is screened AGAIN at open time, after the descriptor
 *    is bound to the dev/ino captured at validation.
 *  - Reads are bound to the validated object: O_NOFOLLOW on the leaf, canonical equality,
 *    and dev/ino equality all have to hold before a byte is read.
 *
 * Two differences are legitimate and stay parametric:
 *  - `configuredRoots`: the CLI reads with an `ArtifactStore`, whose private/keys/backup
 *    roots are additional private roots; the MCP channel has no store and passes none. The
 *    state root is not a parameter — it is always part of the policy.
 *  - `refusals`: the MCP channel speaks the stable tool vocabulary
 *    (`ASSISTANT_CHANNEL_PRIVATE_PATH:<label>`, `INPUT_FILE_*:<label>`), while the CLI
 *    channel keeps its prose/envelope vocabulary. The policy decides WHETHER to refuse; the
 *    vocabulary decides how the refusal is spelled.
 *
 * Residual limitation, documented identically for both channels: Node has no openat(2), so
 * the dev/ino binding narrows the check-then-open race instead of closing it — a swap
 * swapped back inside the window, or a hard link to the very same inode, cannot be detected
 * in-process. The local workspace is trusted and non-adversarial.
 */
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { isWithin, pathSegments, privateBaseDir, toPosix, PRIVATE_STATE_FRAGMENT } from '../platform-paths.js';

/** Private marker vocabulary shared by both public channels. */
export const PUBLIC_PRIVATE_MARKERS = ['.migration-private', 'migration-harness-private', PRIVATE_STATE_FRAGMENT] as const;

/** True when `candidate` is `root` itself or lives under it. */
const inside = (root: string, candidate: string): boolean => isWithin(root, candidate) || resolve(root) === resolve(candidate);

/** A backslash is a separator for the screen on every OS, never a filename byte. */
export function normalizePublicSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Canonical spelling of a path: symlinks resolved on the nearest existing ancestor with any
 * missing suffix reattached, so a path that does not exist yet is still validated where it
 * would land.
 */
export async function canonicalPublicPath(path: string): Promise<string> {
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

/** Refusal vocabulary of one public surface: the policy decides when, the channel spells how. */
export interface PublicSurfaceRefusals {
  privatePath(label: string): Error;
  missing(label: string, cause: unknown): Error;
  unreadable(label: string, cause: unknown): Error;
  symlink(label: string, cause: unknown): Error;
  changed(label: string): Error;
  /** The validated file is not a regular file or already exceeds the byte cap. */
  invalidFile(label: string): Error;
  /** The bounded read observed more bytes than the cap. */
  sizeExceeded(label: string): Error;
  notJson(label: string, cause: unknown): Error;
}

/**
 * Stable reader vocabulary used by the MCP channel (and available to any channel that wants
 * the CLI envelope's catalogued codes instead of prose). Labels are the tool argument names.
 */
export const stablePublicRefusals: PublicSurfaceRefusals = {
  privatePath: label => new Error(`ASSISTANT_CHANNEL_PRIVATE_PATH:${label}`),
  missing: (label, _cause) => new Error(`INPUT_FILE_MISSING:${label}`),
  unreadable: (label, _cause) => new Error(`INPUT_FILE_UNREADABLE:${label}`),
  symlink: (label, _cause) => new Error(`INPUT_FILE_SYMLINK:${label}`),
  changed: label => new Error(`INPUT_FILE_CHANGED:${label}`),
  invalidFile: label => new Error(`INPUT_FILE_INVALID:${label}`),
  sizeExceeded: label => new Error(`INPUT_FILE_INVALID:${label}`),
  notJson: (label, _cause) => new Error(`INPUT_FILE_NOT_JSON:${label}`),
};

/**
 * Every private root in lexical and canonical spellings: the always-present state root
 * (`privateBaseDir()`), which honors MIGRATION_HARNESS_STATE_DIR, plus the channel's
 * configured roots (the CLI store's private/keys/backup roots; none for MCP). Comparing both
 * spellings of every root is what catches an override or root that is itself reached through
 * a symlink.
 */
export async function collectPrivateRoots(configured: readonly string[]): Promise<string[]> {
  const roots = new Set<string>();
  for (const root of [privateBaseDir(), ...configured]) {
    roots.add(resolve(root));
    try { roots.add(await canonicalPublicPath(root)); } catch { /* keep the lexical spelling */ }
  }
  return [...roots];
}

/** Refuse one spelling that carries a private marker or sits inside any private root. */
export function assertPublicSpelling(value: string, roots: readonly string[], refusals: PublicSurfaceRefusals, label: string): void {
  const posix = toPosix(value);
  if (pathSegments(value).includes('.migration-private')
    || PUBLIC_PRIVATE_MARKERS.some(marker => posix.includes(marker))
    || roots.some(root => inside(root, value))) {
    throw refusals.privatePath(label);
  }
}

/** A validated public file: canonical spelling, captured dev/ino and the configured roots needed to recheck at open. */
export interface PublicFileIdentity {
  target: string;
  canonical: string;
  dev: number;
  ino: number;
  /** Configured roots captured at validation; the always-present state root is re-derived at open. */
  configuredRoots: readonly string[];
}

/** Both spellings of a screened candidate plus the configured roots captured for the open recheck. */
export interface ResolvedPublicPath {
  target: string;
  canonical: string;
  configuredRoots: readonly string[];
}

/** Screen the lexical and the canonical spelling of a candidate against every private root. */
export async function resolvePublicPath(
  path: string, configuredRoots: readonly string[], refusals: PublicSurfaceRefusals, label: string,
): Promise<ResolvedPublicPath> {
  const target = resolve(normalizePublicSeparators(path));
  const roots = await collectPrivateRoots(configuredRoots);
  assertPublicSpelling(target, roots, refusals, label);
  const canonical = await canonicalPublicPath(target);
  assertPublicSpelling(canonical, roots, refusals, label);
  return { target, canonical, configuredRoots: [...configuredRoots] };
}

/** Check both spellings of the path before any assistant-facing read; returns the resolved target. */
export async function resolvePublicTarget(
  path: string, configuredRoots: readonly string[], refusals: PublicSurfaceRefusals, label: string,
): Promise<string> {
  return (await resolvePublicPath(path, configuredRoots, refusals, label)).target;
}

/**
 * Validate a candidate and capture the object identity that the later open must see, so the
 * read is bound to this validated object instead of the unchecked lexical spelling.
 */
export async function validatePublicFile(
  path: string, configuredRoots: readonly string[], refusals: PublicSurfaceRefusals, label: string,
): Promise<PublicFileIdentity> {
  const { target, canonical, configuredRoots: captured } = await resolvePublicPath(path, configuredRoots, refusals, label);
  let stat: Stats;
  try {
    stat = await lstat(canonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The vocabulary decides whether raw errno (CLI envelope maps it) or a stable code (MCP) is thrown.
    if (code === 'ENOENT') throw refusals.missing(label, error);
    if (code === 'EACCES' || code === 'EPERM') throw refusals.unreadable(label, error);
    throw error;
  }
  return { target, canonical, dev: stat.dev, ino: stat.ino, configuredRoots: captured };
}

/**
 * Open a validated public file. The canonical spelling must still resolve inside public space
 * — rechecked now, not only at validation — and the descriptor must name the captured dev/ino,
 * so an ancestor swapped for a symlink or a replaced leaf between validation and open is
 * refused before any byte is read. O_NOFOLLOW covers only the final component.
 */
export async function openValidatedPublicFile(
  file: PublicFileIdentity, refusals: PublicSurfaceRefusals, label: string,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(file.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw refusals.missing(label, error);
    if (code === 'ELOOP') throw refusals.symlink(label, error);
    if (code === 'EACCES' || code === 'EPERM') throw refusals.unreadable(label, error);
    throw error;
  }
  try {
    const stat = await handle.stat();
    const canonical = await canonicalPublicPath(file.target);
    assertPublicSpelling(canonical, await collectPrivateRoots(file.configuredRoots), refusals, label);
    if (canonical !== file.canonical || stat.dev !== file.dev || stat.ino !== file.ino) throw refusals.changed(label);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Bounded single-read JSON input: no symlink leaf, no size bypass, no file content in errors. */
export async function readBoundedPublicJson(
  path: string, configuredRoots: readonly string[], refusals: PublicSurfaceRefusals, label: string, maxBytes = 4_000_000,
): Promise<unknown> {
  const handle = await openValidatedPublicFile(await validatePublicFile(path, configuredRoots, refusals, label), refusals, label);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw refusals.invalidFile(label);
    // Read once, up to the cap, so file growth cannot bypass the pre-read size check.
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > maxBytes) throw refusals.sizeExceeded(label);
    try {
      return JSON.parse(buffer.subarray(0, used).toString('utf8')) as unknown;
    } catch (error) {
      // Parse diagnostics quote file content; the channel vocabulary is the whole story.
      throw refusals.notJson(label, error);
    }
  } finally { await handle.close(); }
}
