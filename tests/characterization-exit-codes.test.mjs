import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// The CLI exit-code contract, only where this file is the owner (PLAN-V2 §11.1 item 4, kill switch
// §8.2): exit 1 for a rejected invocation, on the real v2 command surface. Everything else moved to
// its canonical owner — the priority table (0/1/3/4/5) is tests/v2-envelope.test.mjs:59, REFUSED_SCOPE
// exit 3 is tests/v2-commands.test.mjs, decision × exit is tests/v2-decisions.test.mjs and native
// check exits (FAIL → 4, INCONCLUSIVE → 5) are tests/project-checks.test.mjs.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('exit 1 marks invalid flags, missing input, malformed JSON and unknown commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-exit-1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await buildWorkspace();
  config.profile = 'standard';
  await write(root, 'broken.json', '{ not json');
  const configPath = join(root, 'migration.json');
  await write(root, 'migration.json', JSON.stringify(config));

  // Unknown command and every retired compatibility command: the v2 surface is the whole CLI, so a
  // legacy name is an ordinary unknown command — structured refusal on stderr, exit 1, empty stdout.
  for (const command of ['definitely-not-a-command', 'prepare-migration', 'verify-migration', 'apply-patch', 'check-projects']) {
    const unknown = await run([command, '--config', configPath, '--workspace-root', root]);
    assert.equal(unknown.code, 1, command);
    assert.match(unknown.stderr, /ERROR UNKNOWN_COMMAND/, command);
    assert.equal(unknown.stdout, '', `${command} prints no result on a refusal`);
  }

  // Unknown option, missing required option and an unreadable configuration are all exit 1.
  const unknownFlag = await run(['doctor', '--config', configPath, '--workspace-root', root, '--drop-tables', '--json']);
  assert.equal(unknownFlag.code, 1);
  assert.equal(JSON.parse(unknownFlag.stdout).diagnostics[0].code, 'UNKNOWN_OPTION');

  const missingFlag = await run(['doctor', '--workspace-root', root, '--json']);
  assert.equal(missingFlag.code, 1);
  assert.equal(JSON.parse(missingFlag.stdout).diagnostics[0].code, 'MISSING_FLAG');

  const malformed = await run(['doctor', '--config', join(root, 'broken.json'), '--workspace-root', root, '--json']);
  assert.equal(malformed.code, 1);
  assert.equal(JSON.parse(malformed.stdout).diagnostics[0].code, 'INVALID_JSON');
});

test('a refused operation writes no output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-exit-1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await buildWorkspace();
  config.profile = 'standard';
  delete config.scenarios; // schema-invalid: the refusal happens before any artifact is reserved
  await write(root, 'migration.json', JSON.stringify(config));

  const refused = await run(['prepare', '--config', join(root, 'migration.json'), '--workspace-root', root,
    '--artifact-path', 'artifacts/prepared', '--allow-project-commands', '--json']);
  assert.equal(refused.code, 1);
  const envelope = JSON.parse(refused.stdout);
  assert.equal(envelope.operationStatus, 'refused');
  assert.equal(envelope.diagnostics[0].code, 'INVALID_INPUT');
  await assert.rejects(readFile(join(root, 'artifacts/prepared')), error => error.code === 'ENOENT',
    'a rejected input creates no artifact output');
  await assert.rejects(readFile(join(root, 'artifacts')), error => error.code === 'ENOENT');
});
