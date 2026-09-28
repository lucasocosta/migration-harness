#!/usr/bin/env node
// Cross-platform e2e fixture driver: build then run the pilot.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
process.chdir(root);
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
// Windows resolves .cmd shims through the shell; POSIX prefers an exact binary.
let build = run('pnpm', ['build']);
if (build.error || (build.status !== 0 && build.status !== null)) {
  build = run('npx', ['--yes', 'pnpm@10.15.0', 'build']);
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const pilot = run(process.execPath, ['scripts/pilot.mjs']);
process.exit(pilot.status ?? 1);
