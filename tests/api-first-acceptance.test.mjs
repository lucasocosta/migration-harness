import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';
import { listen, close } from './helpers/build-workspace.mjs';
import './helpers/privacy.mjs';

// P7 acceptance (the P4.3 pattern for the api-first pair): a controlled regression on the
// Java target must fail verification with behavior divergence, and the restored candidate
// must verify again. Needs php, JDK and Maven; skips cleanly where toolchains are absent.
const exec = promisify(execFile), repo = resolve('.');
const cli = join(repo, 'packages/cli/dist/index.js');
const toolchains = () => [['php', '--version'], ['java', '--version'], ['mvn', '--version']]
  .every(([tool, flag]) => spawnSync(tool, [flag], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0);

// Every test here runs a real prepare/verify pair, and preflight probes Chromium before the
// preparation exists (measured 2026-10-03: without a browser `prepare` answers INCONCLUSIVE with
// `BROWSER_UNAVAILABLE`). The file moved to L3 in the same change (§11.1 item 5 asks for this
// skip when a chromium-dependent file lands in L3); checked inside `ensure`, so the guard is per
// test and still reports the toolchain skip first.
let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }

const mutations = {
  'wrong response value': {
    file: 'ApiSemantics.java', scenario: 'profile-mount',
    from: 'static final String PROFILE_NAME = "Example User";',
    to: 'static final String PROFILE_NAME = "Wrong User";',
  },
  'missing validation': {
    file: 'ApiSemantics.java', scenario: 'customer-save-invalid',
    from: 'return email != null && EMAIL_PATTERN.matcher(email).matches();',
    to: 'return true;',
  },
  'wrong flow': {
    file: 'ApiSemantics.java', scenario: 'customer-save-valid',
    from: 'return new Outcome(200, body("status", "saved", "email", email));',
    to: 'return new Outcome(404, body("error", "not found"));',
  },
};

let fixture;
const roots = [];
async function ensure(t) {
  if (!toolchains()) { t.skip('php/java/mvn toolchains unavailable'); return null; }
  if (chromiumIssue) { t.skip(`Chromium unavailable: ${chromiumIssue}`); return null; }
  if (fixture) return fixture;
  const root = await mkdtemp(join(tmpdir(), 'api-first-acceptance-'));
  roots.push(root);
  await cp(join(repo, 'examples/api-first'), join(root, 'examples/api-first'), { recursive: true });
  const configPath = join(root, 'examples/api-first/migration.json');
  // Fresh fixture session: attempts budget sized for the five-run acceptance cycle.
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.limits = { sourceRuns: 2, maxRepairAttempts: 9, maxDurationMs: 600000 };
  // The shipped example pins the ports of the pair (source baseUrl / target baseUrl and the
  // target serve argv); this copy is parametrized onto two ephemeral ports so the suite can run
  // beside any other execution instead of claiming 8310/8353 machine-wide.
  const fixedSource = new URL(config.source.baseUrl).port;
  const fixedTarget = new URL(config.target.baseUrl).port;
  assert.ok(fixedSource && fixedTarget, 'the example declares the fixed ports this test replaces');
  const reservation = { source: await listen(0), target: await listen(0) };
  const ports = { source: reservation.source.address().port, target: reservation.target.address().port };
  try {
    // One pass replaces every fixed-port token (baseUrl, entryUrl/bindings, serve argv) without
    // letting an ephemeral number collide with the other side's fixed token mid-replacement.
    const parametrized = JSON.stringify(config, null, 2).replace(
      new RegExp(`(127\\.0\\.0\\.1:|server\\.port=)(${fixedSource}|${fixedTarget})`, 'g'),
      (token, prefix, port) => prefix + (port === fixedSource ? ports.source : ports.target));
    assert.ok(parametrized.includes(`127.0.0.1:${ports.source}`) && parametrized.includes(`--server.port=${ports.target}`),
      'every fixed port of the copied configuration was parametrized');
    await writeFile(configPath, parametrized);
  } finally {
    // Reservations end immediately before the CLI that spawns the serve commands: holding them
    // longer would block prepare itself, freeing them earlier widens the window between
    // `listen(0)` and the real bind. That window still exists here (the harness boots, checks
    // and builds before it binds) — §11.1 treats `listen(0)` + early release as a race reducer,
    // not a race eliminator; no retry is added (retries are not a green criterion).
    await close(reservation.source);
    await close(reservation.target);
  }
  const run = (command, extra) => exec(process.execPath, [cli, command, '--config', configPath, '--workspace-root', root, ...extra],
    { maxBuffer: 16 * 1024 * 1024 });
  // CLI v2 (PLAN-V2 §3): `prepare` establishes the versioned reference and opens the resumable
  // standard session in one operation — the retired `prepare-migration` + `start-migration-session`
  // pair (`--preparation` no longer exists; the session owns the reference from here on).
  const prepared = JSON.parse((await run('prepare', ['--artifact-path', 'artifacts/acc-prepare',
    '--allow-project-commands', '--json'])).stdout);
  assert.equal(prepared.decision, 'READY', `prepare must open the session: ${JSON.stringify(prepared.diagnostics)}`);
  assert.equal(prepared.outcome, 'PASS', `preparation must pass before any verification: ${JSON.stringify(prepared.diagnostics)}`);
  assert.ok(prepared.sessionId, 'prepare opened the session, so §4 names it');
  fixture = { root, configPath, run };
  return fixture;
}

/** One v2 `verify`: stdout is exactly one envelope, so a failure keeps the report it printed. */
async function verify(f) {
  try {
    const { stdout } = await f.run('verify', ['--allow-project-commands', '--json']);
    return { ok: true, stdout, envelope: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout ?? '');
    let envelope;
    try { envelope = JSON.parse(stdout); } catch { envelope = undefined; }
    return { ok: false, code: error.code, stdout, envelope };
  }
}
const migrationReport = envelope => envelope.report.report;

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
    await rm(new ArtifactStore(join(root, 'artifacts/acc-prepare')).privateRoot, { recursive: true, force: true });
  }
});

test('api-first acceptance: prepare and the untouched candidate verify PASS', async t => {
  const f = await ensure(t); if (!f) return;
  const result = await verify(f);
  assert.ok(result.ok, result.stdout);
  const envelope = result.envelope;
  assert.equal(envelope.operation, 'verify');
  assert.equal(envelope.decision, 'COMPLETE');
  assert.equal(envelope.outcome, 'PASS');
  const report = migrationReport(envelope);
  assert.equal(report.status, 'PASS');
  assert.equal(report.preservation, 'PASS');
  assert.equal(report.identity.migrationId, 'api-first-example');
  assert.equal(report.referenceStatus, 'VERIFIED');
  assert.ok(report.requiredCoverage.scenarios.received >= 1, 'the acceptance scenarios were evaluated');
});

for (const [name, mutation] of Object.entries(mutations)) {
  test(`api-first acceptance: controlled regression (${name}) is detected on ${mutation.scenario}`, async t => {
    const f = await ensure(t); if (!f) return;
    const path = join(f.root, 'examples/api-first/java/src/main/java/com/example/apifirst/', mutation.file);
    const original = await readFile(path, 'utf8');
    assert.ok(original.includes(mutation.from), `mutation anchor exists for ${name}`);
    await writeFile(path, original.replace(mutation.from, mutation.to));
    try {
      const result = await verify(f);
      assert.equal(result.ok, false, 'a diverging candidate must not verify');
      assert.equal(result.code, 4, 'a behavior divergence exits FAIL, never inconclusive');
      const envelope = result.envelope;
      assert.ok(envelope, `a FAIL still prints one envelope: ${result.stdout}`);
      assert.equal(envelope.operationStatus, 'processed');
      assert.equal(envelope.outcome, 'FAIL');
      const report = migrationReport(envelope);
      assert.equal(report.status, 'FAIL');
      assert.ok(report.diagnostics.some(item => item.code === 'BEHAVIOR_DIVERGENCE'
        && item.scenarioId === mutation.scenario),
      `the FAIL is attributed to ${mutation.scenario}: ${JSON.stringify(report.diagnostics)}`);
    } finally { await writeFile(path, original); }
  });
}

test('api-first acceptance: the restored candidate verifies PASS again', async t => {
  const f = await ensure(t); if (!f) return;
  const result = await verify(f);
  assert.ok(result.ok, result.stdout);
  assert.equal(result.envelope.decision, 'COMPLETE');
  assert.equal(migrationReport(result.envelope).status, 'PASS');
  // `status` (the v2 replacement of the retired `migration-session-status`) reads the state the
  // session owns: authorized scope and a last report that still matches this workspace.
  const { stdout } = await f.run('status', ['--json']);
  const status = JSON.parse(stdout);
  assert.equal(status.operation, 'status');
  assert.equal(status.decision, 'COMPLETE', 'the restored workspace is authorized by the session');
  assert.equal('outcome' in status, false, 'reading state is not an evaluation');
  assert.equal(status.report.scope, 'PASS', 'the restored workspace is authorized by the session');
  assert.equal(status.report.lastReportMatchesWorkspace, true);
  assert.ok(status.report.attemptsUsed >= 5, `every acceptance verification was recorded: ${status.report.attemptsUsed}`);
});
