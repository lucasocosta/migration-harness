import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseMigrationConfig } from '../packages/core/dist/index.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// PLAN-V2 §11.2 A1 (BLOQUEIO): the shipped example must be runnable through the v2 flow as written,
// and `doctor` must say when it is not — a configuration without profile standard is schema-valid
// but every session command refuses it, so doctor reports that as a FINDING (operation processed,
// outcome untouched, same exit code) instead of passing in silence.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const exampleConfig = resolve('examples/validation-first/migration.json');

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { timeout: 180_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
const json = result => JSON.parse(result.stdout);

test('the shipped example declares profile standard, so doctor -> prepare needs no manual edit', async t => {
  // (a) The example itself: schema-valid AND standard, never edited backwards by a test.
  const example = JSON.parse(await readFile(exampleConfig, 'utf8'));
  assert.equal(example.profile, 'standard', 'examples/validation-first/migration.json carries profile: standard');
  assert.equal(parseMigrationConfig(example).profile, 'standard');

  // doctor on the example (workspace root = repository root, the paths are repo-relative): no profile
  // finding. The environment outcome itself is host-dependent (ports, chromium), never asserted here.
  const checked = await run(['doctor', '--config', exampleConfig, '--workspace-root', resolve('.'), '--json']);
  assert.ok([0, 5].includes(checked.code), `doctor answers an environment outcome, not a refusal: ${checked.code} ${checked.stderr}`);
  const envelope = json(checked);
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.diagnostics.some(item => item.code === 'STANDARD_PROFILE_REQUIRED'), false,
    'the example no longer trips the profile gate');

  // prepare reaches the engine with this very configuration: the profile refusal is gone (the run
  // then fails on the missing workspace inputs of this scratch root, which is a different reason).
  const root = await mkdtemp(join(tmpdir(), 'v2-polish-example-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'migration.json', JSON.stringify(example));
  const prepared = await run(['prepare', '--config', join(root, 'migration.json'), '--workspace-root', root,
    '--artifact-path', 'artifacts/prepared', '--allow-project-commands', '--json']);
  const refusal = json(prepared);
  assert.equal(refusal.diagnostics.some(item => item.code === 'STANDARD_PROFILE_REQUIRED'), false,
    `prepare is no longer blocked on the profile: ${JSON.stringify(refusal.diagnostics)}`);
  assert.equal(refusal.operationStatus, 'processed', 'the profile gate passes; whatever comes next is an environment outcome');
});

test('doctor reports a missing standard profile as a finding, never as a failure', async t => {
  const { root, config } = await buildWorkspace(); // no profile key: restricted shape
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'migration.json', JSON.stringify(config));
  const args = ['doctor', '--config', join(root, 'migration.json'), '--workspace-root', root, '--json'];

  const without = await run(args);
  assert.equal(without.code, 0, `a finding never changes the exit code: ${without.stderr}`);
  const envelope = json(without);
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.outcome, 'PASS', 'the environment verdict is untouched by the finding');
  assert.equal('decision' in envelope, false);
  assert.equal('sessionId' in envelope, false, 'doctor opens no session (§4)');
  const finding = envelope.diagnostics.find(item => item.code === 'STANDARD_PROFILE_REQUIRED');
  assert.ok(finding, 'the silent pass of A1 is gone');
  assert.equal(finding.fieldPath, 'profile', 'the finding names the field the operator must add');
  assert.equal(finding.category, 'CONFIGURATION');
  assert.equal(typeof finding.retryable, 'boolean');
  assert.match(finding.cause, /schema-valid/, 'it says the document is schema-valid');
  assert.match(finding.cause, /prepare\/verify\/status\/reference refuse/, 'and which commands will refuse it');
  assert.ok(finding.action.length > 0);
  assert.equal(envelope.nextActions[0].operation, 'prepare', 'the flow still points at the next command of the cycle');

  // With the field present the finding disappears — the same doctor run stays clean.
  await write(root, 'migration.json', JSON.stringify({ ...config, profile: 'standard' }));
  const withProfile = await run(args);
  assert.equal(withProfile.code, 0, withProfile.stderr);
  assert.equal(json(withProfile).diagnostics.some(item => item.code === 'STANDARD_PROFILE_REQUIRED'), false);
});
