import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyPrivacyPolicy, PRIVACY_ENV, resolvePrivacyPolicy } from '../packages/cli/dist/v2/privacy.js';
import { buildWorkspace } from './helpers/build-workspace.mjs';
import { canEnforcePosixModes } from './helpers/privacy.mjs';

// PLAN-V2 §3.1 / §8.1 item 4 / §9.1: one effective privacy policy per operation. The flag and the
// environment variable used to feed different channels (store/report vs. preflight probe); now the
// operation resolves them once, refuses a conflict without widening permissions, and propagates the
// decision so preflight, store and report cannot disagree.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');

async function doctor(args, env) {
  try {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env });
    return { code: 0, envelope: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, envelope: JSON.parse(String(error.stdout)) };
  }
}
const baseEnv = () => { const env = { ...process.env }; delete env[PRIVACY_ENV]; return env; };

test('the effective policy is resolved once from flag and environment and never widens permissions', () => {
  assert.deepEqual(resolvePrivacyPolicy({}), { mode: 'STRICT', allowInsecurePrivateStore: false, source: 'default' });
  assert.deepEqual(resolvePrivacyPolicy({ env: undefined }), { mode: 'STRICT', allowInsecurePrivateStore: false, source: 'default' });
  assert.deepEqual(resolvePrivacyPolicy({ allowInsecurePrivateStore: true }),
    { mode: 'DEGRADED_INSECURE', allowInsecurePrivateStore: true, source: 'flag' });
  assert.deepEqual(resolvePrivacyPolicy({ env: '1' }),
    { mode: 'DEGRADED_INSECURE', allowInsecurePrivateStore: true, source: 'environment' });
  assert.deepEqual(resolvePrivacyPolicy({ allowInsecurePrivateStore: true, env: '1' }),
    { mode: 'DEGRADED_INSECURE', allowInsecurePrivateStore: true, source: 'flag+environment' });
  // A declaration the harness would silently ignore stays strict (matching the engine), never degraded.
  assert.equal(resolvePrivacyPolicy({ env: 'yes' }).mode, 'STRICT');
  // A conflict is refused instead of guessed: the flag opts in while the environment says otherwise.
  assert.throws(() => resolvePrivacyPolicy({ allowInsecurePrivateStore: true, env: '0' }), /Conflicting privacy declarations/);
  assert.throws(() => resolvePrivacyPolicy({ allowInsecurePrivateStore: true, env: 'false' }), /Conflicting privacy declarations/);
});

test('applying the policy aligns the environment-fed channel with the decision', () => {
  const previous = process.env[PRIVACY_ENV];
  try {
    delete process.env[PRIVACY_ENV];
    applyPrivacyPolicy(resolvePrivacyPolicy({ allowInsecurePrivateStore: true }));
    assert.equal(process.env[PRIVACY_ENV], '1', 'the flag alone propagates to the env-fed channels (preflight probe, report stamping)');
    delete process.env[PRIVACY_ENV];
    applyPrivacyPolicy(resolvePrivacyPolicy({}));
    assert.equal(process.env[PRIVACY_ENV], undefined, 'strict does not opt anything in');
  } finally {
    if (previous === undefined) delete process.env[PRIVACY_ENV];
    else process.env[PRIVACY_ENV] = previous;
  }
});

test('one policy per operation: doctor stamps the same privacy evidence on every channel', async t => {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'migration.json');
  await writeFile(configPath, JSON.stringify(config));
  const args = ['doctor', '--config', configPath, '--workspace-root', root, '--json'];

  const strict = await doctor(args, baseEnv());
  assert.equal(strict.code, 0, strict.envelope.diagnostics?.[0]?.cause);
  assert.equal(strict.envelope.operationStatus, 'processed');
  assert.equal(strict.envelope.outcome, 'PASS');
  if (await canEnforcePosixModes()) {
    assert.equal(strict.envelope.report.checks.disclosures, undefined,
      'STRICT policy leaves no degraded-store disclosure behind');
  }

  // The flag alone (environment unset) must reach the preflight permission probe too: before the
  // unification, preflight reported STRICT while the store was degraded (§8.1 item 4).
  const flagOnly = await doctor([...args.slice(0, -1), '--allow-insecure-private-store', '--json'], baseEnv());
  assert.equal(flagOnly.code, 0, flagOnly.envelope.diagnostics?.[0]?.cause);
  const disclosures = flagOnly.envelope.report.checks.disclosures.map(item => item.code);
  assert.ok(disclosures.includes('WEAK_PRIVATE_PERMISSIONS'), 'expected disclosure, not a failure');
  assert.ok(disclosures.includes('DEGRADED_ISOLATION'));

  const fromEnv = await doctor(args, { ...baseEnv(), [PRIVACY_ENV]: '1' });
  assert.equal(fromEnv.code, 0, fromEnv.envelope.diagnostics?.[0]?.cause);
  assert.ok(fromEnv.envelope.report.checks.disclosures.map(item => item.code).includes('WEAK_PRIVATE_PERMISSIONS'));

  // Inconsistent declarations are refused — exit 1, pointed at the environment variable, no widening.
  const conflict = await doctor([...args.slice(0, -1), '--allow-insecure-private-store', '--json'], { ...baseEnv(), [PRIVACY_ENV]: '0' });
  assert.equal(conflict.code, 1);
  assert.equal(conflict.envelope.operationStatus, 'refused');
  assert.equal(conflict.envelope.diagnostics[0].code, 'INVALID_FLAG');
  assert.equal(conflict.envelope.diagnostics[0].fieldPath, PRIVACY_ENV);
  assert.match(conflict.envelope.diagnostics[0].cause, /Conflicting privacy declarations/);
  assert.equal('report' in conflict.envelope, false, 'a refused operation produces no report');
});
