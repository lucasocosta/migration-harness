/**
 * Containment: the build cache is opt-in and **off by default**. Without
 * `MIGRATION_HARNESS_BUILD_CACHE=1` no probe, restore or publish runs, no artifact or cache directory
 * is created, and the cycle is byte-identical to having no cache. This is the containment for the
 * identity limits recorded in `build-cache.ts`, not a claim those limits are gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCacheRoot } from '../packages/engine/dist/build-cache.js';
import { withProjectBuildServers } from '../packages/engine/dist/build-servers.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const BUILD_SCRIPT = `import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/build.log', 'run\\n');
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;
const LINT_SCRIPT = `import { mkdirSync, appendFileSync } from 'node:fs';
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/lint.log', 'run\\n');`;

const exists = async path => { try { await access(path); return true; } catch { return false; } };
const entries = async root => (await readdir(buildCacheRoot(root)).catch(() => [])).filter(name => /^[a-f0-9]{64}$/.test(name));
/** Drop the only two fields that legitimately differ between two runs of the same workspace. */
const normalize = report => JSON.parse(JSON.stringify(report, (key, value) =>
  key === 'durationMs' || key === 'evaluatedAt' ? undefined : value));

async function fixture(t) {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const side of ['source', 'target']) {
    await write(root, `${side}/build.mjs`, BUILD_SCRIPT);
    await write(root, `${side}/lint.mjs`, LINT_SCRIPT);
    config[side].commands.push({ id: 'lint', kind: 'lint', argv: [process.execPath, 'lint.mjs'], cwd: '.', timeoutMs: 3000 });
    config.checks.push({ id: `lint-${side}`, side, commandId: 'lint', required: true });
  }
  const lines = async name => (await readFile(join(root, 'markers', name), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  return {
    root, config, lines,
    cycle: () => withProjectBuildServers({ config, workspaceRoot: root, allowProjectCommands: true }, async () => 'completed'),
  };
}

test('default off: no probe, restore or publish and no cache artifact is created', async t => {
  delete process.env.MIGRATION_HARNESS_BUILD_CACHE;
  delete process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE;
  const f = await fixture(t);

  const first = await f.cycle();
  assert.equal(first.cache.source.status, 'DISABLED');
  assert.equal(first.cache.source.reason, 'OPT_IN_REQUIRED');
  assert.equal(first.cache.target.status, 'DISABLED');
  assert.equal(first.checks.status, 'PASS', 'behavior is unchanged without the cache');
  assert.equal(await f.lines('build.log'), 2, 'the real build still ran');
  assert.deepEqual(await entries(f.root), [], 'nothing is stored without opt-in');
  assert.equal(await exists(buildCacheRoot(f.root)), false, 'not even the cache directory is created');

  const second = await f.cycle();
  assert.equal(second.cache.source.status, 'DISABLED');
  assert.equal(second.cache.source.publish, undefined, 'a disabled cache never reports a publication');
  assert.equal(await f.lines('build.log'), 4, 'every cycle builds when the cache is off');
  assert.equal(await exists(buildCacheRoot(f.root)), false);
  assert.deepEqual(await entries(f.root), []);
});

test('default off is byte-identical to the explicit A/B no-cache switch', async t => {
  delete process.env.MIGRATION_HARNESS_BUILD_CACHE;
  delete process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE;
  const f = await fixture(t);

  const off = await f.cycle();
  process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE = '1';
  let ab;
  try { ab = await f.cycle(); } finally { delete process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE; }

  assert.equal(off.cache.source.status, 'DISABLED');
  assert.equal(off.cache.source.reason, 'OPT_IN_REQUIRED');
  assert.equal(ab.cache.source.status, 'DISABLED');
  assert.equal(ab.cache.source.reason, 'ENV_FLAG', 'the explicit switch keeps its own reason');
  assert.deepEqual(normalize(off.checks), normalize(ab.checks), 'the default-off path proves the same report');
  assert.equal(off.builds.source.buildHash, ab.builds.source.buildHash, 'and serves byte-identical build bytes');
  assert.deepEqual(await entries(f.root), []);
});

test('opting in enables the cache; the A/B force-off still wins', async t => {
  const f = await fixture(t);
  process.env.MIGRATION_HARNESS_BUILD_CACHE = '1';
  try {
    const cold = await f.cycle();
    assert.equal(cold.cache.source.status, 'MISS');
    assert.equal(cold.cache.source.publish, 'PUBLISHED');
    assert.equal((await entries(f.root)).length, 2, 'opt-in really stores entries');
    const warm = await f.cycle();
    assert.equal(warm.cache.source.status, 'HIT');
    assert.equal(await f.lines('build.log'), 2, 'the hit never re-executes the build');

    process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE = '1';
    const forced = await f.cycle();
    assert.equal(forced.cache.source.status, 'DISABLED');
    assert.equal(forced.cache.source.reason, 'ENV_FLAG', 'the force-off outranks the opt-in');
    assert.equal(await f.lines('build.log'), 4);
  } finally {
    delete process.env.MIGRATION_HARNESS_BUILD_CACHE;
    delete process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE;
  }
});
