/**
 * Guardrails for the optimization itself (docs/PLAN-V2.md §9.1, first alarm): a required build
 * really runs on the first cycle, required checks keep running on every cycle — hit or miss — and
 * a cache hit can never hide a required failure. The A/B switch keeps the no-cache path available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '../packages/core/dist/index.js';
import { buildCacheRoot } from '../packages/engine/dist/build-cache.js';
import { withProjectBuildServers } from '../packages/engine/dist/build-servers.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const entries = async root => (await readdir(buildCacheRoot(root)).catch(() => [])).filter(name => /^[a-f0-9]{64}$/.test(name));

const BUILD_SCRIPT = `import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/build.log', 'run\\n');
if (existsSync('../markers/fail-build')) process.exit(2);
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;
const LINT_SCRIPT = `import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/lint.log', 'run\\n');
if (existsSync('../markers/fail-lint')) process.exit(1);`;

async function fixture(t) {
  const { root, config } = await buildWorkspace();
  // The build cache is opt-in (default off); these guardrails exercise it enabled. The A/B switch
  // below sets MIGRATION_HARNESS_DISABLE_BUILD_CACHE on top of the opt-in.
  process.env.MIGRATION_HARNESS_BUILD_CACHE = '1';
  t.after(() => { delete process.env.MIGRATION_HARNESS_BUILD_CACHE; });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const side of ['source', 'target']) {
    await write(root, `${side}/build.mjs`, BUILD_SCRIPT);
    await write(root, `${side}/lint.mjs`, LINT_SCRIPT);
    config[side].commands.push({ id: 'lint', kind: 'lint', argv: [process.execPath, 'lint.mjs'], cwd: '.', timeoutMs: 3000 });
    config.checks.push({ id: `lint-${side}`, side, commandId: 'lint', required: true });
  }
  const lines = async name => (await readFile(join(root, 'markers', name), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  return {
    root, config, lines, entries: () => entries(root),
    cycle: use => withProjectBuildServers({ config, workspaceRoot: root, allowProjectCommands: true }, use ?? (async () => 'completed')),
  };
}

/** Drop the only two fields that legitimately differ between two runs of the same workspace. */
const normalize = report => JSON.parse(JSON.stringify(report, (key, value) =>
  key === 'durationMs' || key === 'evaluatedAt' ? undefined : value));

test('the required build really runs on the first cycle and required checks run on every cycle', async t => {
  const f = await fixture(t);
  const first = await f.cycle();
  assert.equal(first.cache.source.status, 'MISS');
  assert.equal(first.cache.target.status, 'MISS');
  assert.equal(await f.lines('build.log'), 2, 'cycle 1 executed one required build per side');
  assert.equal(await f.lines('lint.log'), 2, 'cycle 1 executed the required checks');
  assert.equal(first.checks.checks.length, f.config.checks.length, 'one row per declared check');
  assert.equal(first.checks.status, 'PASS');

  for (const cycle of [2, 3, 4]) {
    const result = await f.cycle();
    assert.equal(result.cache.source.status, 'HIT', `cycle ${cycle} reuses the build artifact`);
    assert.equal(result.cache.target.status, 'HIT');
    assert.equal(await f.lines('build.log'), 2, `cycle ${cycle} never re-executes the build`);
    assert.equal(await f.lines('lint.log'), cycle * 2, `cycle ${cycle} still executes every required check`);
    assert.equal(result.checks.checks.length, f.config.checks.length, 'no declared check row disappears on a hit');
    assert.equal(result.checks.status, 'PASS');
  }
  // Every row identifies the very command it claims to describe.
  const last = await f.cycle();
  for (const row of last.checks.checks) {
    const command = f.config[row.side].commands.find(item => item.id === row.commandId);
    assert.equal(row.commandHash, digest(command), `${row.checkId} records its real command hash`);
  }
  assert.equal(await f.lines('build.log'), 2, 'the extra identity run does not build either');
});

test('a required check failing during a cache hit is still reported as a failure', async t => {
  const f = await fixture(t);
  await f.cycle();
  assert.equal((await f.cycle()).cache.source.status, 'HIT');
  assert.equal(await f.lines('lint.log'), 4);

  await write(f.root, 'markers/fail-lint', 'x');
  const failing = await f.cycle();
  assert.equal(failing.cache.source.status, 'HIT', 'the build artifact is still valid');
  assert.equal(failing.checks.status, 'FAIL', 'a required mutation is detected on a hit cycle');
  const lintRow = failing.checks.checks.find(row => row.checkId === 'lint-source');
  const buildRow = failing.checks.checks.find(row => row.checkId === 'build-source');
  assert.equal(lintRow.status, 'FAIL');
  assert.equal(lintRow.reason, 'EXIT_NONZERO');
  assert.equal(buildRow.status, 'PASS');
  assert.equal(await f.lines('lint.log'), 6, 'the failing check really executed');

  await rm(join(f.root, 'markers', 'fail-lint'), { force: true });
  const recovered = await f.cycle();
  assert.equal(recovered.checks.status, 'PASS');
  assert.equal(recovered.checks.checks.find(row => row.checkId === 'lint-source').baselineComparison, 'NOT_COMPARED');
  assert.equal(await f.lines('build.log'), 2, 'no build ran through the failure or the recovery');
});

test('a failing required build is reported and never published', async t => {
  const f = await fixture(t);
  await write(f.root, 'markers/fail-build', 'x');
  await assert.rejects(f.cycle(), error => error.code === 'BUILD_CHECK_FAILED');
  assert.deepEqual(await f.entries(), [], 'a build that did not succeed leaves no artifact behind');
  assert.equal(await f.lines('lint.log'), 2, 'the checks still ran and reported');
  await rm(join(f.root, 'markers', 'fail-build'), { force: true });
  const passed = await f.cycle();
  assert.equal(passed.checks.status, 'PASS');
  assert.equal((await f.entries()).length, 2, 'only a passing build is published');
  assert.equal((await f.cycle()).cache.source.status, 'HIT');
});

test('the A/B switch keeps the no-cache path available for comparison', async t => {
  const f = await fixture(t);
  process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE = '1';
  try {
    const disabled = await f.cycle();
    assert.equal(disabled.cache.source.status, 'DISABLED');
    assert.equal(disabled.cache.source.reason, 'ENV_FLAG');
    assert.equal(disabled.checks.status, 'PASS');
    assert.deepEqual(await f.entries(), [], 'a disabled cache stores nothing');
    assert.equal(await f.lines('build.log'), 2);
    const again = await f.cycle();
    assert.equal(again.cache.source.status, 'DISABLED');
    assert.equal(await f.lines('build.log'), 4, 'without the cache every cycle builds');
    assert.deepEqual(await f.entries(), []);
  } finally { delete process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE; }

  const cold = await f.cycle();
  assert.equal(cold.cache.source.status, 'MISS');
  assert.equal(cold.cache.source.publish, 'PUBLISHED');
  assert.equal(await f.lines('build.log'), 6, 'the switch does not change what a miss costs');
  const warm = await f.cycle();
  assert.equal(warm.cache.source.status, 'HIT');
  assert.equal(await f.lines('build.log'), 6, 'the switch does not change what a hit saves');
});

test('a hit report equals the no-cache report for the same workspace', async t => {
  const f = await fixture(t);
  const stored = await f.cycle();
  assert.equal(stored.cache.source.status, 'MISS');

  process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE = '1';
  let withoutCache;
  try { withoutCache = await f.cycle(); } finally { delete process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE; }
  assert.equal(withoutCache.cache.source.status, 'DISABLED');
  assert.equal(withoutCache.checks.checks.length, f.config.checks.length);

  const hit = await f.cycle();
  assert.equal(hit.cache.source.status, 'HIT');
  assert.equal(hit.checks.status, withoutCache.checks.status);
  assert.deepEqual(normalize(hit.checks), normalize(withoutCache.checks),
    'a hit changes only how the build row was obtained, never what the report proves');
  assert.equal(hit.builds.source.buildHash, withoutCache.builds.source.buildHash,
    'the restored artifact is byte-identical to a fresh build');
  assert.equal(hit.builds.target.buildHash, withoutCache.builds.target.buildHash);
});
