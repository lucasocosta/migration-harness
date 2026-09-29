import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { listen, close } from './helpers/build-workspace.mjs';
import './helpers/privacy.mjs';

// P7 acceptance (the P4.3 pattern for the api-first pair): a controlled regression on the
// Java target must fail verification with behavior divergence, and the restored candidate
// must verify again. Needs php, JDK and Maven; skips cleanly where toolchains are absent.
const exec = promisify(execFile), repo = resolve('.');
const cli = join(repo, 'packages/cli/dist/index.js');
const toolchains = () => [['php', '--version'], ['java', '--version'], ['mvn', '--version']]
  .every(([tool, flag]) => spawnSync(tool, [flag], { encoding: 'utf8' }).status === 0);

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
  if (fixture) return fixture;
  for (const port of [8310, 8353]) {
    const server = await listen(port).catch(() => undefined);
    assert.ok(server, `port ${port} must be free: the example reserves it`);
    await close(server);
  }
  const root = await mkdtemp(join(tmpdir(), 'api-first-acceptance-'));
  roots.push(root);
  await cp(join(repo, 'examples/api-first'), join(root, 'examples/api-first'), { recursive: true });
  const configPath = join(root, 'examples/api-first/migration.json');
  // Fresh fixture session: attempts budget sized for the five-run acceptance cycle.
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.limits = { sourceRuns: 2, maxRepairAttempts: 9, maxDurationMs: 600000 };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const run = (command, extra) => exec(process.execPath, [cli, command, '--config', configPath, '--workspace-root', root, ...extra],
    { maxBuffer: 16 * 1024 * 1024 });
  const prepared = await run('prepare-migration', ['--artifact-path', 'artifacts/acc-prepare', '--allow-project-commands']);
  assert.match(prepared.stdout, /^MIGRATION_PREPARATION: PASS\b/);
  // --preparation resolves against the process cwd (unlike --artifact-path, which is workspace
  // relative), so it must be absolute whenever workspace root != cwd.
  const started = await run('start-migration-session', ['--preparation', join(root, 'artifacts/acc-prepare/preparation.json')]);
  assert.match(started.stdout, /MIGRATION_SESSION_STARTED/);
  fixture = { root, configPath, run };
  return fixture;
}

async function verify(f) {
  try {
    const { stdout } = await f.run('verify-migration', ['--allow-project-commands']);
    return { ok: true, stdout };
  } catch (error) { return { ok: false, code: error.code, stdout: String(error.stdout ?? '') }; }
}

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
  assert.match(result.stdout, /MIGRATION_SESSION_RESULT: COMPLETE/);
  assert.match(result.stdout, /Migration api-first-example: PASS/);
});

for (const [name, mutation] of Object.entries(mutations)) {
  test(`api-first acceptance: controlled regression (${name}) is detected on ${mutation.scenario}`, async t => {
    const f = await ensure(t); if (!f) return;
    const path = join(f.root, 'examples/api-first/target/src/main/java/com/example/apifirst/', mutation.file);
    const original = await readFile(path, 'utf8');
    assert.ok(original.includes(mutation.from), `mutation anchor exists for ${name}`);
    await writeFile(path, original.replace(mutation.from, mutation.to));
    try {
      const result = await verify(f);
      assert.equal(result.ok, false, 'a diverging candidate must not verify');
      assert.equal(result.code, 4, 'a behavior divergence exits FAIL, never inconclusive');
      assert.ok(result.stdout.includes('BEHAVIOR_DIVERGENCE'), result.stdout);
      assert.ok(result.stdout.includes(`scenario=${mutation.scenario}`), result.stdout);
    } finally { await writeFile(path, original); }
  });
}

test('api-first acceptance: the restored candidate verifies PASS again', async t => {
  const f = await ensure(t); if (!f) return;
  const result = await verify(f);
  assert.ok(result.ok, result.stdout);
  assert.match(result.stdout, /MIGRATION_SESSION_RESULT: COMPLETE/);
  const { stdout } = await f.run('migration-session-status', []);
  const status = JSON.parse(stdout.slice(stdout.indexOf('{')));
  assert.equal(status.scope, 'PASS', 'the restored workspace is authorized by the session');
  assert.equal(status.lastReportMatchesWorkspace, true);
});
