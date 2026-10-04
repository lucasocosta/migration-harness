import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findCommand } from '../packages/cli/dist/help.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// Profile/interface characterization after the kill switch (PLAN-V2 §8.2): the restricted
// verification interface — a caller-selected `--preparation` + `--artifact-path` outside the
// session — is gone, so the only way to drive verification is the session the v2 flow owns.
// Asserts are exit codes and structured codes only. The rest of the old profile net migrated:
// the non-standard refusal without handover is tests/v2-commands.test.mjs, the doctor finding is
// tests/v2-polish-profile.test.mjs, sessionless authorisation is tests/v2-commands.test.mjs, and
// "a session discovered under a non-standard config" stays with the MCP boundary
// (tests/mcp-boundary.test.mjs): it was the last surface that still accepted a non-standard
// profile, and with the retired `preparationPath` gone from its tools it now answers
// STANDARD_PROFILE_REQUIRED like every v2 command — no surface accepts one.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('the registry of every session command is free of the retired sessionless flags', () => {
  const flagsOf = command => findCommand(command).flags.map(flag => flag.name);
  for (const command of ['prepare', 'verify', 'status', 'reference']) {
    assert.ok(!flagsOf(command).includes('--preparation'),
      `${command} never accepts a caller-selected preparation: the session owns the reference`);
  }
  for (const command of ['verify', 'status']) {
    assert.ok(!flagsOf(command).includes('--artifact-path'),
      `${command} never accepts a caller-selected output: the session owns the output`);
  }
  // The flags the session flow does own stay registered.
  assert.ok(flagsOf('prepare').includes('--artifact-path'));
  assert.ok(flagsOf('reference').includes('--artifact-path'));
  assert.ok(flagsOf('reference').includes('--owner-decision'));
});

test('a sessionless reference or output argument is refused as an unknown option, exit 1', async t => {
  const root = await mkdtemp(join(tmpdir(), 'profiles-interface-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await buildWorkspace();
  config.profile = 'standard';
  await write(root, 'migration.json', JSON.stringify(config));
  const base = ['--config', join(root, 'migration.json'), '--workspace-root', root, '--json'];

  const cases = [
    ['verify', ['--preparation', join(root, 'preparation.json')]],
    ['verify', ['--artifact-path', 'artifacts/bypass']],
    ['status', ['--preparation', join(root, 'preparation.json')]],
    ['status', ['--artifact-path', 'artifacts/bypass']],
    ['prepare', ['--preparation', join(root, 'preparation.json')]],
    ['reference', ['--preparation', join(root, 'preparation.json')]],
  ];
  for (const [command, extra] of cases) {
    const refused = await run([command, ...base, ...extra]);
    assert.equal(refused.code, 1, `${command} ${extra.join(' ')}`);
    const envelope = JSON.parse(refused.stdout);
    assert.equal(envelope.operationStatus, 'refused', `${command} ${extra.join(' ')}`);
    assert.equal(envelope.diagnostics[0].code, 'UNKNOWN_OPTION', `${command} ${extra.join(' ')}`);
    assert.equal('report' in envelope, false, 'a refused invocation evaluates nothing');
  }
});
