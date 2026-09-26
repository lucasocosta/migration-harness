import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { killTree, supportsTreeKill, executionPlatform } from '../packages/engine/dist/process-tree.js';

test('supportsTreeKill is available on the current platform', () => {
  assert.equal(supportsTreeKill(), true);
});

test('executionPlatform matches process.platform', () => {
  assert.equal(executionPlatform(), process.platform);
});

test('killTree on a process group terminates a grandchild tree', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX group semantics; Windows tree kill is covered by CI integration');
    return;
  }
  // Parent spawns a long-lived child and stays alive; group kill must take both.
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { grand.kill('SIGKILL'); process.exit(0); });
  `], { detached: true, stdio: 'ignore' });
  await delay(200);
  assert.ok(child.pid);
  assert.equal(killTree(child, 'SIGTERM'), true);
  await delay(300);
  // Group should be gone; a second kill reports already-dead or throws ESRCH-equivalent false.
  assert.equal(killTree(child, 'SIGKILL'), false);
  child.unref();
});

test('killTree is a no-op without a pid', () => {
  assert.equal(killTree(undefined, 'SIGKILL'), false);
  assert.equal(killTree({}, 'SIGKILL'), false);
});
