import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SandboxPolicy { image: string; timeoutMs: number; memoryMb: number; maxOutputBytes: number; }
export interface SandboxResult { exitCode: number; stdout: string; stderr: string; }

/** Generated commands run only in a disposable container with a read-only candidate mount. */
export class DockerSandbox {
  constructor(private readonly policy: SandboxPolicy) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(policy.image)) throw new Error('Sandbox image must be pinned by digest.');
    for (const value of [policy.timeoutMs, policy.memoryMb, policy.maxOutputBytes]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid sandbox budget.');
  }
  async run(candidateRoot: string, command: string[]): Promise<SandboxResult> {
    if (!command.length || command.some(arg => arg.includes('\0'))) throw new Error('Invalid sandbox command.');
    const root = resolve(candidateRoot);
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('Sandbox candidate root must be a real directory.');
    if (root.includes(',')) throw new Error('Unsupported candidate root.');
    const name = `harness-${randomUUID()}`;
    const args = ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', `--memory=${this.policy.memoryMb}m`, '--cpus=1', '--user=65534:65534', '--tmpfs=/tmp:rw,noexec,nosuid,size=64m', '--mount', `type=bind,src=${root},dst=/candidate,readonly`, '--workdir=/candidate', this.policy.image, ...command];
    return new Promise((resolveResult, reject) => {
      const child = spawn('docker', args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0, failure: Error | undefined;
      const stop = (reason: string): void => {
        if (failure) return;
        failure = new Error(reason);
        const cleanup = spawn('docker', ['rm', '-f', name], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: 'ignore' });
        cleanup.on('error', () => undefined);
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => stop('Sandbox deadline exceeded.'), this.policy.timeoutMs);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > this.policy.maxOutputBytes) stop('Sandbox output limit exceeded.'); else stdout += String(chunk); });
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > this.policy.maxOutputBytes) stop('Sandbox output limit exceeded.'); else stderr += String(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(new Error(`Sandbox unavailable: ${error.message}`)); });
      child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolveResult({ exitCode: code ?? 1, stdout, stderr }); });
    });
  }
}
