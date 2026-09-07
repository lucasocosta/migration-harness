import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';
import { runProjectReset } from '../packages/engine/dist/project-checks.js';

async function fixture(t, script = 'import{writeFileSync}from"node:fs";writeFileSync("reset-done", "yes");console.log("runtime-private");') {
  const value = await buildWorkspace(); t.after(() => rm(value.root, { recursive: true, force: true }));
  value.config.reset = { kind: 'COMMANDS', sourceCommandId: 'reset', targetCommandId: 'reset' };
  for (const side of ['source', 'target']) {
    await write(value.root, `${side}/reset.mjs`, script);
    value.config[side].relevantFiles.push('reset.mjs');
    value.config[side].commands.push({ id: 'reset', kind: 'reset', argv: [process.execPath, 'reset.mjs'], cwd: '.', timeoutMs: 1500 });
  }
  return value;
}
const run = (fixture, extra = {}) => runProjectReset({ config: fixture.config, workspaceRoot: fixture.root,
  side: 'source', allowProjectCommands: true, ...extra });

test('engine entrypoint does not load Playwright for non-browser operations', async () => {
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import {createRequire} from 'node:module';
    await import('./packages/engine/dist/index.js');
    const loaded=Object.keys(createRequire(import.meta.url).cache);
    if(loaded.some(path=>['/playwright/','/playwright-core/','/@playwright/test/'].some(part=>path.includes(part))))process.exit(2);
  `]);
});

test('reset uses the declared command, preserves output privacy and needs authorization', async t => {
  const value = await fixture(t);
  assert.equal((await run(value, { allowProjectCommands: false })).reason, 'EXECUTION_NOT_AUTHORIZED');
  await assert.rejects(readFile(join(value.root, 'source/reset-done')));
  const result = await run(value);
  assert.equal(result.status, 'PASS'); assert.equal(result.reason, 'COMPLETED');
  assert.ok(result.outcome.output.stdoutBytes > 0); assert.ok(!JSON.stringify(result).includes('runtime-private'));
  assert.equal(await readFile(join(value.root, 'source/reset-done'), 'utf8'), 'yes');
});

test('failed, timed-out, aborted and input-mutating resets cannot claim successful isolation', async t => {
  for (const [script, reason] of [
    ['process.exit(2);', 'EXIT_NONZERO'], ['setInterval(()=>{},10);', 'TIMEOUT'],
    ['import{writeFileSync}from"node:fs";writeFileSync("main.ts", "changed");', 'INPUT_CHANGED'],
  ]) {
    const value = await fixture(t, script); value.config.source.commands[1].timeoutMs = 300;
    const result = await run(value); assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.reason, reason);
  }
  const value = await fixture(t), controller = new AbortController(); controller.abort();
  assert.equal((await run(value, { signal: controller.signal })).reason, 'ABORTED');
});

test('reset cwd is independently checked; isolated fixtures execute no project command', async t => {
  const value = await fixture(t);
  await symlink(join(value.root, 'source'), join(value.root, 'source/linked'));
  value.config.source.commands[1].cwd = 'linked';
  assert.equal((await run(value)).reason, 'CWD_UNAVAILABLE');
  value.config.reset = { kind: 'ISOLATED_FIXTURES' };
  assert.equal((await run(value)).reason, 'ISOLATED_CONTEXT');
  await assert.rejects(readFile(join(value.root, 'source/reset-done')));
});
