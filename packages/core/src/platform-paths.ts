import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Stable content-screen fragment for the private state root across OSes. */
export const PRIVATE_STATE_FRAGMENT = '.local/state/migration-harness';

/**
 * Single source for the private state root. Same logical layout on every OS so
 * fingerprints and containment checks stay stable. Override with
 * MIGRATION_HARNESS_STATE_DIR or the ArtifactStore privateRoot constructor.
 */
export function privateBaseDir(): string {
  const override = process.env.MIGRATION_HARNESS_STATE_DIR;
  if (override) return resolve(override);
  return join(homedir(), '.local', 'state', 'migration-harness');
}

/** Normalize an OS path to the POSIX form used in configs and fingerprints. */
export function toPosix(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/');
}

/** Convert a declared POSIX-relative path to an OS path (Node accepts `/` on Windows). */
export function fromPosix(path: string): string {
  return path;
}

/** Segment-wise membership check that does not assume `/` as the only separator. */
export function pathSegments(path: string): string[] {
  return path.split(/[/\\]/).filter(Boolean);
}

const fold = (value: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;

/**
 * Containment for absolute OS paths. Segment-wise and case-folded on
 * case-insensitive platforms for containment only; declared fingerprint
 * strings are never case-folded. A child literally named `..evil` is inside
 * its parent — `path.relative` alone would misclassify it as outside.
 */
export function isWithin(root: string, candidate: string): boolean {
  const rootParts = pathSegments(resolve(root)).map(fold);
  const candidateParts = pathSegments(resolve(candidate)).map(fold);
  if (candidateParts.length <= rootParts.length) return false;
  return rootParts.every((part, index) => candidateParts[index] === part);
}

/** Containment for declared POSIX-relative paths (case-sensitive, `/` separators). */
export function isWithinPosix(root: string, candidate: string): boolean {
  if (root === candidate) return true;
  return candidate.startsWith(`${root}/`) && !candidate.slice(root.length + 1).split('/').includes('..');
}

/** True when `candidate` equals `root` or lives under it (POSIX-relative form). */
export function coversPosix(root: string, candidate: string): boolean {
  return root === candidate || candidate.startsWith(`${root}/`);
}

/** Case-insensitive equality for path prefixes on case-insensitive filesystems. */
export function samePath(a: string, b: string): boolean {
  return fold(resolve(a)) === fold(resolve(b));
}
