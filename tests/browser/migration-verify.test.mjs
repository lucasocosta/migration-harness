import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { ArtifactStore } from '../../packages/engine/dist/artifacts.js';
import { migrationSessionPath } from '../../packages/engine/dist/migration-session.js';
import { listen, close } from '../helpers/build-workspace.mjs';
import '../helpers/privacy.mjs';

const exec = promisify(execFile), root = resolve('.');
const cli = 'packages/cli/dist/index.js';
const exampleConfig = 'examples/validation-first/migration.json';
let config = exampleConfig;
const app = 'examples/validation-first/react/App.tsx';
const originalBody = 'JSON.stringify({ email })', tamperedBody = `JSON.stringify({ email: 'tamired@example.test' })`;
/** One CLI v2 invocation against the copied example; `--json` prints exactly one envelope. */
const migration = (command, extra) => exec(process.execPath,
  [cli, command, '--config', config, '--workspace-root', '.', ...extra, '--json'], { maxBuffer: 16 * 1024 * 1024 });
const json = run => JSON.parse(run.stdout);
/** The envelope's `report` is the session result; the migration report is nested inside it. */
const migrationReport = envelope => envelope.report.report;

test('validation-first example prepares a reference, verifies PASS, fails the documented regression and recovers', async t => {
  let probe;
  try { probe = await chromium.launch({ headless: true }); } catch { t.skip('Chromium is unavailable'); return; }
  finally { await probe?.close(); }
  for (const port of [4320, 4353]) {
    const server = await listen(port).catch(() => undefined);
    assert.ok(server, `port ${port} must be free: the harness reserves it`);
    await close(server);
  }
  const base = `artifacts/tmp-migration-verify-${process.pid}-${randomUUID().slice(0, 8)}`;
  const baseline = `${base}/baseline`;
  t.after(async () => {
    await rm(join(root, base), { recursive: true, force: true });
    await rm(new ArtifactStore(join(root, baseline)).privateRoot, { recursive: true, force: true });
  });
  // The example ships profile: "standard" and the v2 flow is the whole surface: `prepare` opens the
  // session on a fresh artifact path, `verify` reports through the session-owned envelope.
  await mkdir(join(root, base), { recursive: true });
  const example = JSON.parse(await readFile(join(root, exampleConfig), 'utf8'));
  config = `${base}/migration.json`;
  await writeFile(join(root, config), JSON.stringify(example, null, 2));
  // The v2 `prepare` opens a deterministic session in the workspace; a leftover journal makes every
  // later run refuse with SESSION_ALREADY_EXISTS (the A4 contract), so remove the session whole.
  t.after(async () => {
    await rm(new ArtifactStore(join(root, migrationSessionPath(example))).privateRoot, { recursive: true, force: true });
    await rm(join(root, migrationSessionPath(example)), { recursive: true, force: true });
  });

  const prepared = await migration('prepare', ['--artifact-path', baseline, '--allow-project-commands']);
  assert.equal(json(prepared).decision, 'READY', prepared.stdout);
  const preparation = json(prepared).report;
  assert.equal(preparation.kind, 'MIGRATION_PREPARATION');
  assert.equal(preparation.status, 'PASS');
  assert.equal(preparation.artifactPath, baseline);
  assert.equal(JSON.parse(await readFile(join(root, baseline, 'reference-verification.json'), 'utf8')).status, 'VERIFIED');

  const passing = await migration('verify', ['--allow-project-commands']);
  const passEnvelope = json(passing);
  assert.equal(passEnvelope.decision, 'COMPLETE');
  assert.equal(passEnvelope.outcome, 'PASS');
  assert.equal(migrationReport(passEnvelope).status, 'PASS');

  const source = await readFile(join(root, app), 'utf8');
  assert.ok(source.includes(originalBody), 'the example app must keep the documented regression hook');
  try {
    await writeFile(join(root, app), source.replace(originalBody, tamperedBody));
    let failure;
    try { await migration('verify', ['--allow-project-commands']); }
    catch (error) { failure = error; }
    assert.ok(failure, 'a diverging destination must not verify');
    assert.equal(failure.code, 4, 'a behavior divergence exits FAIL, never inconclusive');
    const diverged = JSON.parse(String(failure.stdout));
    assert.equal(diverged.decision, 'REPAIR_IMPLEMENTATION');
    assert.equal(diverged.outcome, 'FAIL');
    const report = migrationReport(diverged);
    assert.equal(report.status, 'FAIL');
    assert.ok(report.diagnostics.some(item => item.code === 'BEHAVIOR_DIVERGENCE' && item.scenarioId === 'save'));
  } finally { await writeFile(join(root, app), source); }

  const restored = await migration('verify', ['--allow-project-commands']);
  const restoredEnvelope = json(restored);
  assert.equal(restoredEnvelope.decision, 'COMPLETE');
  assert.equal(migrationReport(restoredEnvelope).status, 'PASS');
});
