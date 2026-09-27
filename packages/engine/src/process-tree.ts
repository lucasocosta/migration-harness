import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Tree-kill a spawned project-command process and its ordinary descendants.
 * POSIX keeps the owned process-group kill; Windows uses taskkill /T so no
 * native addon is required. Residual risk: a descendant that reparents itself
 * between the soft and hard pass can escape; see docs/OS-PORTABILITY.md.
 * Returns true when the kill request was issued; false when already dead.
 */
export function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals): boolean {
  if (!child?.pid) return false;
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    try {
      execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      return true;
    } catch (error) {
      // taskkill exits nonzero when the process is already gone.
      if ((error as { status?: number }).status !== undefined) return false;
      throw error;
    }
  }
  try { process.kill(-child.pid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Whether this platform can bound ordinary project-command descendants. */
export function supportsTreeKill(): boolean {
  // POSIX process groups, or taskkill /T on Windows (always present on supported Windows).
  return true;
}

/** Platform label used in privacy/isolation disclosures. */
export function executionPlatform(): string {
  return process.platform;
}

/**
 * Resolve a command argv[0] for spawn({ shell: false }).
 * Windows package shims (`npm`, `pnpm`) are `.cmd` files and are not found as
 * bare names; prefer the `.cmd` form when `where` locates it.
 */
export function resolveExecutable(name: string): string {
  if (process.platform !== 'win32' || /[/\\]/.test(name) || /\.[a-z]{1,5}$/i.test(name)) return name;
  try {
    execFileSync('where', [`${name}.cmd`], { stdio: 'ignore', windowsHide: true });
    return `${name}.cmd`;
  } catch {
    return name;
  }
}
