import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, migrationConfigHash } from '../packages/core/dist/index.js';
import { collectMigrationReference, verifyMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { migrationSessionPath } from '../packages/engine/dist/migration-session.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { buildMigrationReport } from '../packages/engine/dist/quality-gates/migration-report.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';
import { canEnforcePosixModes } from './helpers/privacy.mjs';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';

// Privacy disclosures on the CLI v2 prepare/verify flow (docs/OS-PORTABILITY.md): WEAK_PRIVATE_
// PERMISSIONS and DEGRADED_ISOLATION are *expected evidence* of an opted-in degraded private store,
// never a failure, never a status downgrade and never a different exit code. Assertions cover
// disclosure codes, privacy mode and the evidence-driven status/exit code — never messages.
// The policy resolution itself (flag × environment, one decision per operation) is owned by
// tests/v2-privacy.test.mjs:59; the schema-level PASS/disclosure rules are tests/privacy-policy.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const DISCLOSURES = ['WEAK_PRIVATE_PERMISSIONS', 'DEGRADED_ISOLATION'];
const DEGRADED_ENV = { ...process.env, MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE: '1' };
const strictEnv = () => { const env = { ...process.env }; delete env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE; return env; };

// prepare/verify below run complete capture chains (real Chromium), so on a host without Chromium
// they skip explicitly instead of failing — same pattern as tests/perf-browser-cleanup.test.mjs.
// The PASS-report test builds its report from a reference collected without a browser and keeps
// running everywhere.
let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }
const withoutChromium = t => {
  if (!chromiumIssue) return false;
  t.skip(`Chromium unavailable: ${chromiumIssue}`);
  return true;
};

async function cliRun(args, options = {}) {
  try { const { stdout, stderr } = await exec(process.execPath, [cli, ...args], options); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }; }
}

test('an opted-in degraded store discloses both privacy codes while prepare and verify still pass', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'migration.json', JSON.stringify(config));
  const base = ['--config', join(root, 'migration.json'), '--workspace-root', root];
  const clean = async name => {
    for (const dir of [`artifacts/${name}`, migrationSessionPath(config)]) {
      await rm(new ArtifactStore(join(root, dir)).privateRoot, { recursive: true, force: true });
    }
  };
  t.after(() => clean('privacy-prepared'));

  const degradedPrepare = await cliRun(['prepare', ...base, '--artifact-path', 'artifacts/privacy-prepared',
    '--allow-project-commands', '--json'], { env: DEGRADED_ENV });
  assert.equal(degradedPrepare.code, 0, `a disclosure never fails the operation: ${degradedPrepare.stderr}`);
  const prepared = JSON.parse(degradedPrepare.stdout);
  assert.equal(prepared.operationStatus, 'processed');
  assert.equal(prepared.outcome, 'PASS', 'degraded privacy is evidence, not a failure');
  // On `prepare` the disclosure channel is the preflight of the baseline the preparation recorded:
  // `report` is the MIGRATION_PREPARATION itself, whose baseline carries `preflight.disclosures`.
  const codes = (prepared.report.baseline.preflight.disclosures ?? []).map(item => item.code);
  for (const code of DISCLOSURES) assert.ok(codes.includes(code), `${code} must be disclosed, got ${JSON.stringify(codes)}`);
  assert.deepEqual(prepared.diagnostics, [], 'disclosures travel on the disclosure channel, not as diagnostics');

  const degradedVerify = await cliRun(['verify', ...base, '--allow-project-commands', '--json'], { env: DEGRADED_ENV });
  assert.equal(degradedVerify.code, 0, `a disclosure never fails the operation: ${degradedVerify.stderr}`);
  const verified = JSON.parse(degradedVerify.stdout);
  assert.equal(verified.decision, 'COMPLETE');
  assert.equal(verified.outcome, 'PASS', 'the disclosures never downgrade a passing verification');
  assert.equal(verified.report.report.privacy.mode, 'DEGRADED_INSECURE');
  const reportCodes = verified.report.report.diagnostics.map(item => item.code);
  for (const code of DISCLOSURES) assert.ok(reportCodes.includes(code), `${code} missing from ${JSON.stringify(reportCodes)}`);

  if (await canEnforcePosixModes()) {
    // Same session, strict policy: the exit code and the verdict do not move, only the disclosures.
    const strictVerify = await cliRun(['verify', ...base, '--allow-project-commands', '--json'], { env: strictEnv() });
    assert.equal(strictVerify.code, 0, 'the exit code is identical under a strict store');
    const strictReported = JSON.parse(strictVerify.stdout);
    assert.equal(strictReported.outcome, 'PASS');
    assert.equal(strictReported.report.report.privacy.mode, 'STRICT');
    assert.ok(!strictReported.report.report.diagnostics.some(item => DISCLOSURES.includes(item.code)),
      'strict privacy reports carry no disclosure codes');
  }
});

test('--allow-insecure-private-store stamps the report degraded without changing its status or exit code', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'migration.json', JSON.stringify(config));
  const base = ['--config', join(root, 'migration.json'), '--workspace-root', root];
  for (const dir of ['artifacts/verify-degraded', migrationSessionPath(config)]) {
    t.after(() => rm(new ArtifactStore(join(root, dir)).privateRoot, { recursive: true, force: true }));
  }

  const prepared = await cliRun(['prepare', ...base, '--artifact-path', 'artifacts/verify-degraded',
    '--allow-project-commands', '--allow-insecure-private-store', '--json']);
  assert.equal(prepared.code, 0, prepared.stderr);
  const verified = await cliRun(['verify', ...base, '--allow-project-commands', '--allow-insecure-private-store', '--json']);
  assert.equal(verified.code, 0, 'disclosures never move the exit code');
  const envelope = JSON.parse(verified.stdout);
  assert.equal(envelope.outcome, 'PASS', 'the degraded flag never changes the verdict');
  assert.equal(envelope.report.report.status, 'PASS');
  assert.equal(envelope.report.report.privacy.mode, 'DEGRADED_INSECURE');
  const codes = envelope.report.report.diagnostics.map(item => item.code);
  for (const code of DISCLOSURES) assert.ok(codes.includes(code), `${code} missing from ${JSON.stringify(codes)}`);

  if (await canEnforcePosixModes()) {
    const strict = await cliRun(['verify', ...base, '--allow-project-commands', '--json']);
    assert.equal(strict.code, 0, 'the exit code is identical without the flag');
    const strictEnvelope = JSON.parse(strict.stdout);
    assert.equal(strictEnvelope.outcome, 'PASS');
    assert.equal(strictEnvelope.report.report.privacy.mode, 'STRICT');
    assert.ok(!strictEnvelope.report.report.diagnostics.some(item => DISCLOSURES.includes(item.code)),
      'strict privacy reports carry no disclosure codes');
  }
});

test('a PASS report may carry both disclosures without being downgraded', async t => {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE;
  process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE;
    else process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE = previous;
  });
  const input = { config, workspaceRoot: root };
  const reference = await collectMigrationReference({ ...input,
    sourceObservations: { status: 'STABLE', runs: 2, executionHashes: [digest('source'), digest('source')] } });
  const verification = await verifyMigrationReference({ ...input, reference });
  assert.equal(verification.status, 'VERIFIED');
  const identity = { migrationId: config.migrationId, configurationHash: migrationConfigHash(config),
    referenceHash: verification.referenceHash, candidateHash: digest('candidate'), buildHash: digest('build') };
  const report = buildMigrationReport(config, {
    identity, evaluatedAt: new Date().toISOString(), referenceVerified: true, reference: verification,
    scenarios: config.scenarios.map(item => ({ identity, scenarioId: item.definition.scenarioId, status: 'PASS',
      requirements: [], diagnostics: [], evidencePaths: [] })),
    checks: config.checks.map(item => ({ identity, checkId: item.id, status: 'PASS', diagnostics: [], evidencePaths: [] })),
  });
  assert.equal(report.status, 'PASS', 'privacy disclosures never downgrade a passing report');
  assert.equal(report.preservation, 'PASS');
  assert.equal(report.privacy.mode, 'DEGRADED_INSECURE');
  const codes = report.diagnostics.map(item => item.code);
  for (const code of DISCLOSURES) assert.ok(codes.includes(code), `${code} missing from ${JSON.stringify(codes)}`);
});
