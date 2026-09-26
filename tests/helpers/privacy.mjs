import { mkdtemp, mkdir, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { mkdirSync, writeFileSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sync probe so the env default is installed as soon as this helper is imported.
{
  const root = mkdtempSync(join(tmpdir(), 'modes-probe-sync-'));
  try {
    mkdirSync(join(root, 'd'), { mode: 0o700 });
    writeFileSync(join(root, 'f'), 'x', { mode: 0o600 });
    const enforced = (statSync(join(root, 'd')).mode & 0o077) === 0 && (statSync(join(root, 'f')).mode & 0o077) === 0;
    if (!enforced) process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE = '1';
  } catch {
    process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE = '1';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let modesProbe;
/** True when the filesystem enforces POSIX 0700/0600 (Linux/macOS native). */
export async function canEnforcePosixModes() {
  if (modesProbe !== undefined) return modesProbe;
  const root = await mkdtemp(join(tmpdir(), 'modes-probe-'));
  try {
    await mkdir(join(root, 'd'), { mode: 0o700 });
    const dirMode = (await stat(join(root, 'd'))).mode & 0o077;
    await writeFile(join(root, 'f'), 'x', { mode: 0o600 });
    const fileMode = (await stat(join(root, 'f'))).mode & 0o077;
    modesProbe = dirMode === 0 && fileMode === 0;
  } catch {
    modesProbe = false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // Allow library/API tests that cannot pass store options to run under DEGRADED privacy.
  if (!modesProbe) process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE = '1';
  return modesProbe;
}

/** ArtifactStore options that allow private writes on filesystems without POSIX modes. */
export async function storeOptions(extra = {}) {
  return (await canEnforcePosixModes()) ? extra : { ...extra, allowInsecurePrivateStore: true };
}

/** CLI args for the same policy. */
export async function cliPrivacyArgs() {
  return (await canEnforcePosixModes()) ? [] : ['--allow-insecure-private-store'];
}

let symlinkProbe;
/** True when the process can create symlinks (Developer Mode / admin on Windows). */
export async function canCreateSymlink() {
  if (symlinkProbe !== undefined) return symlinkProbe;
  const root = await mkdtemp(join(tmpdir(), 'symlink-probe-'));
  try {
    await writeFile(join(root, 'target'), 'x');
    await symlink(join(root, 'target'), join(root, 'link'));
    symlinkProbe = true;
  } catch {
    symlinkProbe = false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return symlinkProbe;
}

