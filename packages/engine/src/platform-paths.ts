import { constants } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  isWithin, pathSegments, privateBaseDir, samePath,
  PRIVATE_STATE_FRAGMENT, coversPosix, fromPosix, isWithinPosix, toPosix,
} from '@migration-harness/core';

export {
  PRIVATE_STATE_FRAGMENT, coversPosix, fromPosix, isWithin, isWithinPosix,
  pathSegments, privateBaseDir, samePath, toPosix,
};

/** Permission outcome for a private-domain write. Never silently ignored. */
export type PrivatePermissionMode = 'STRICT' | 'DEGRADED';

export interface PrivateDirResult {
  path: string;
  mode: PrivatePermissionMode;
}

/**
 * Create a private directory at mode 0700 and verify the filesystem enforces it.
 * Under `allowDegraded`, a filesystem that cannot enforce the mode is accepted
 * as DEGRADED instead of throwing; strict remains the default.
 */
/**
 * Refuse a path whose leaf is a symlink. Parents may be system aliases
 * (macOS `/var` -> `/private/var`); comparing realpath to the literal path
 * would false-fail there. The security intent is the owned entry itself.
 */
export async function assertNotSymlinkLeaf(path: string, message: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(message);
}

export async function ensurePrivateDir(path: string, options: { allowDegraded?: boolean } = {}): Promise<PrivateDirResult> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNotSymlinkLeaf(path, 'Private directory must not contain symlinks.');
  const enforced = ((await lstat(path)).mode & 0o077) === 0;
  if (enforced) return { path, mode: 'STRICT' };
  if (options.allowDegraded) return { path, mode: 'DEGRADED' };
  throw new Error('Private artifact filesystem must enforce mode 0700. See docs/OS-PORTABILITY.md.');
}

export interface PrivateFileOptions {
  allowDegraded?: boolean;
  flags?: number;
}

export interface PrivateFileResult {
  handle: FileHandle;
  mode: PrivatePermissionMode;
}

/**
 * Open a private file with exclusive-create and O_NOFOLLOW at mode 0600.
 * Returns the permission mode so callers can stamp DEGRADED_ISOLATION disclosures.
 */
export async function openPrivateFile(path: string, options: PrivateFileOptions = {}): Promise<PrivateFileResult> {
  const flags = options.flags ?? (constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
  const handle = await open(path, flags, 0o600);
  let settled = false;
  try {
    const enforced = ((await handle.stat()).mode & 0o077) === 0;
    if (enforced) { settled = true; return { handle, mode: 'STRICT' }; }
    if (options.allowDegraded) { settled = true; return { handle, mode: 'DEGRADED' }; }
    throw new Error('Private artifact filesystem must enforce mode 0600. See docs/OS-PORTABILITY.md.');
  } finally {
    if (!settled) await handle.close().catch(() => {});
  }
}

/** Reject a path that resolves into the private state root or the .migration-private segment. */
export function assertNotPrivateWorkspace(workspace: string, privateBase = privateBaseDir()): void {
  const segments = pathSegments(workspace);
  if (segments.includes('.migration-private') || isWithin(privateBase, workspace) || samePath(privateBase, workspace)) {
    throw new Error('PRIVATE_WORKSPACE');
  }
}

let permissionProbe: PrivatePermissionMode | undefined;

/**
 * Probe once per process whether the filesystem enforces 0700/0600.
 * Used to stamp preflight disclosures; never silent.
 */
export async function probePrivatePermissionMode(): Promise<PrivatePermissionMode> {
  if (permissionProbe) return permissionProbe;
  if (process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE === '1') {
    permissionProbe = 'DEGRADED';
    return permissionProbe;
  }
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'privacy-probe-'));
  try {
    const result = await ensurePrivateDir(join(root, 'd'));
    permissionProbe = result.mode;
  } catch {
    permissionProbe = 'DEGRADED';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return permissionProbe;
}
