/**
 * Core entry-point weight: importing `@migration-harness/core` must not statically load `typescript`.
 * The AST validators live behind `llm-worker/bounded-worker`, while the content screens the public
 * entry point actually needs (`fileHash`, `screenPatchContent`) live in the lightweight leaf module.
 * The retired `DockerSandbox` must not reappear on any public surface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('importing the core entry point does not load typescript', async () => {
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    await import('./packages/core/dist/index.js');
    const loaded = Object.keys(createRequire(import.meta.url).cache);
    if (loaded.some(path => path.includes('/typescript/'))) process.exit(2);
  `]);
});

test('the worker surface stays complete while DockerSandbox is retired', async () => {
  const worker = await import('../packages/core/dist/llm-worker/index.js');
  assert.equal('DockerSandbox' in worker, false, 'DockerSandbox had no production call-site and was removed');
  for (const name of ['BoundedWorker', 'HttpWorkerProvider', 'fileHash', 'screenPatchContent',
    'collectTraceValues', 'changedBytes', 'validatePatches', 'assertCandidatePath']) {
    assert.equal(typeof worker[name], 'function', `${name} must stay exported by the worker module`);
  }
  const core = await import('../packages/core/dist/index.js');
  assert.equal('DockerSandbox' in core, false);
  assert.equal(typeof core.fileHash, 'function');
  assert.equal(typeof core.screenPatchContent, 'function');
});
