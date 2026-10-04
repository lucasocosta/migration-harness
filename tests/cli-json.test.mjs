import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// Output modes of the CLI v2 surface (PLAN-V2 §3.1): `--json` always yields exactly one JSON
// document on stdout (the envelope, or the { ok: false, error } envelope of a refusal) and text
// mode never prints JSON. The same help index — `harness --help`, `harness help` and `--help
// --json` — is asserted to project exactly the six v2 commands, since the compatibility commands
// were retired by the kill switch.
const execFileAsync = promisify(execFile);
const cli = resolve('packages/cli/dist/index.js');
const V2_COMMANDS = ['doctor', 'init', 'prepare', 'reference', 'status', 'verify'];
const RETIRED = ['prepare-migration', 'verify-migration', 'start-migration-session', 'migration-session-status',
  'update-migration-session', 'check-projects', 'brief', 'apply-patch', 'compare', 'trace', 'synthesize', 'purge-raw'];

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code: error.code ?? 1 };
  }
}

test('--json prints exactly one envelope and text mode stays human-readable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await buildWorkspace();
  // Deliberately left without `profile: standard`: the refusal below is the non-standard refusal
  // (STANDARD_PROFILE_REQUIRED), which is the configuration this output-mode test is exercising.
  await write(root, 'migration.json', JSON.stringify(config));

  const created = await run(['init', '--out', join(root, 'generated.json'), '--json']);
  assert.equal(created.code, 0, created.stderr);
  const envelope = JSON.parse(created.stdout);
  assert.equal(envelope.schemaVersion, '1');
  assert.equal(envelope.operation, 'init');
  assert.equal(envelope.operationStatus, 'processed');

  const text = await run(['init', '--out', join(root, 'generated-text.json')]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^init: processed \| exit 0/);
  assert.doesNotMatch(text.stdout.trimStart(), /^\{/, 'text mode is not JSON by default');

  // A refusal answers the same contract: one envelope on stdout in --json mode, prose otherwise.
  const base = ['--config', join(root, 'migration.json'), '--workspace-root', root];
  const refusedJson = await run(['status', ...base, '--json']);
  assert.equal(refusedJson.code, 1);
  const refusal = JSON.parse(refusedJson.stdout);
  assert.equal(refusal.schemaVersion, '1');
  assert.equal(refusal.operationStatus, 'refused');
  assert.equal(refusal.diagnostics[0].code, 'STANDARD_PROFILE_REQUIRED');

  const refusedText = await run(['status', ...base]);
  assert.equal(refusedText.code, 1);
  assert.match(refusedText.stdout, /^status: refused \| exit 1/);
  assert.doesNotMatch(refusedText.stdout.trimStart(), /^\{/, 'text mode is not JSON by default');
  assert.match(refusedText.stderr, /ERROR STANDARD_PROFILE_REQUIRED/);
});

test('the help index lists exactly the six v2 commands, in both output modes', async () => {
  const structured = await run(['help', '--json']);
  assert.equal(structured.code, 0);
  const index = JSON.parse(structured.stdout);
  assert.deepEqual(index.commands.map(item => item.command).sort(), V2_COMMANDS);
  assert.deepEqual(index.exitCodes.map(item => item.code), [0, 1, 3, 4, 5]);
  assert.equal(index.errors, 'docs/reference/errors.md');
  for (const retired of RETIRED) {
    assert.ok(!index.commands.some(item => item.command === retired), `${retired} is retired`);
  }

  const text = await run(['--help']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^Migration Harness CLI — 6 commands/);
  for (const command of V2_COMMANDS) assert.match(text.stdout, new RegExp(`^  ${command}\\b`, 'm'), command);
  for (const retired of RETIRED) {
    assert.ok(!new RegExp(`(?<![\\w-])${retired}(?![\\w-])`).test(text.stdout), `${retired} is retired`);
  }
  assert.doesNotMatch(text.stdout.trimStart(), /^\{/, 'text mode is not JSON by default');
});
