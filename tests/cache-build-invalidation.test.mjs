/**
 * Build-cache invalidation (docs/PLAN-V2.md §4, "Ordem de alavancas" item 3).
 *
 * Every input class in the mandatory identity is exercised here: a change in any of them must
 * force a miss — never a hit — and a build that mutates an input while it runs must never be
 * published. Markers live in `<workspace>/markers/**`: outside both project roots and below the
 * workspace level the identity fingerprints, so counting executions never changes the key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assessBuildCache, buildCacheRoot, probeBuildCache } from '../packages/engine/dist/build-cache.js';
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

async function fixture(t) {
  const { root, config } = await buildWorkspace();
  // The build cache is opt-in (default off); these cases exercise identity with it enabled.
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
    root, config, lines,
    assess: side => assessBuildCache({ config, workspaceRoot: root, side }),
    key: async side => {
      const assessment = await assessBuildCache({ config, workspaceRoot: root, side });
      assert.equal(assessment.cacheable, true, `${side} must be cacheable for this case`);
      return assessment.identity.key;
    },
    cycle: () => withProjectBuildServers({ config, workspaceRoot: root, allowProjectCommands: true }, async () => 'completed'),
  };
}

test('code, build configuration and undeclared assets each force a miss', async t => {
  const f = await fixture(t);
  const first = await f.cycle();
  assert.equal(first.cache.source.status, 'MISS');
  assert.equal(first.cache.source.publish, 'PUBLISHED');
  assert.equal(first.cache.target.publish, 'PUBLISHED');
  assert.equal(await f.lines('build.log'), 2, 'one real build per side on the first cycle');
  const warm = await f.cycle();
  assert.equal(warm.cache.source.status, 'HIT');
  assert.equal(warm.cache.target.status, 'HIT');
  assert.equal(await f.lines('build.log'), 2, 'a hit never executes the build');

  // código (declared input)
  const codeKey = await f.key('source');
  await write(f.root, 'source/main.ts', 'export const value = 42;\n');
  assert.notEqual(await f.key('source'), codeKey, 'code bytes join the identity');
  const afterCode = await f.cycle();
  assert.equal(afterCode.cache.source.status, 'MISS');
  assert.equal(afterCode.cache.target.status, 'HIT', 'the untouched side keeps its entry');
  assert.equal(await f.lines('build.log'), 3);
  assert.equal((await f.cycle()).cache.source.status, 'HIT', 'stabilizes back to a hit');

  // configuração de build (o próprio script de build)
  const configKey = await f.key('source');
  await write(f.root, 'source/build.mjs', `${BUILD_SCRIPT}\n// build configuration changed`);
  assert.notEqual(await f.key('source'), configKey, 'build script bytes join the identity');
  const afterConfig = await f.cycle();
  assert.equal(afterConfig.cache.source.status, 'MISS');
  assert.equal(await f.lines('build.log'), 4);
  assert.equal((await f.cycle()).cache.source.status, 'HIT');

  // asset fora de relevantFiles: só o varrimento do projeto o enxerga
  const assetKey = await f.key('source');
  await write(f.root, 'source/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.notEqual(await f.key('source'), assetKey, 'undeclared assets join the identity');
  const afterAsset = await f.cycle();
  assert.equal(afterAsset.cache.source.status, 'MISS');
  assert.equal(await f.lines('build.log'), 5);
  assert.equal((await f.cycle()).cache.source.status, 'HIT');
  assert.equal((await f.cycle()).cache.target.status, 'HIT');
  assert.equal((await f.cycle()).checks.status, 'PASS');
});

test('a lockfile-only change forces a miss', async t => {
  const f = await fixture(t);
  await write(f.root, 'source/package.json', JSON.stringify({ name: 'source-app', version: '1.0.0', dependencies: { 'demo-lib': '^1.0.0' } }, null, 2));
  await write(f.root, 'source/pnpm-lock.yaml', 'lockfileVersion: 6.0\ndemo-lib: 1.0.0\n');
  await write(f.root, 'source/node_modules/.modules.yaml', 'lockfileVersion: "6.0"\nregistries:\n  default: https://registry.npmjs.org/\n');
  await write(f.root, 'source/node_modules/demo-lib/package.json', JSON.stringify({ name: 'demo-lib', version: '1.0.0' }, null, 2));

  await f.cycle();
  assert.equal(await f.lines('build.log'), 2);
  const warm = await f.cycle();
  assert.equal(warm.cache.source.status, 'HIT');
  assert.equal(await f.lines('build.log'), 2, 'lockfile + installation identified');

  const key = await f.key('source');
  await write(f.root, 'source/pnpm-lock.yaml', 'lockfileVersion: 6.0\ndemo-lib: 1.0.1\n');
  assert.notEqual(await f.key('source'), key, 'lockfile bytes join the identity');
  const after = await f.cycle();
  assert.equal(after.cache.source.status, 'MISS', 'a lockfile-only change must not hit');
  assert.equal(after.cache.target.status, 'HIT');
  assert.equal(await f.lines('build.log'), 3);
  assert.equal((await f.cycle()).cache.source.status, 'HIT');
});

test('a node_modules that diverges from its lockfile forces a miss', async t => {
  const f = await fixture(t);
  await write(f.root, 'source/package.json', JSON.stringify({ name: 'source-app', version: '1.0.0', dependencies: { 'demo-lib': '^1.0.0' } }, null, 2));
  await write(f.root, 'source/pnpm-lock.yaml', 'lockfileVersion: 6.0\ndemo-lib: 1.0.0\n');
  await write(f.root, 'source/node_modules/.modules.yaml', 'lockfileVersion: "6.0"\n');
  await write(f.root, 'source/node_modules/demo-lib/package.json', JSON.stringify({ name: 'demo-lib', version: '1.0.0' }, null, 2));

  await f.cycle();
  assert.equal((await f.cycle()).cache.source.status, 'HIT', 'installed state identified');

  // the lockfile is untouched; only the installation moves
  const key = await f.key('source');
  await write(f.root, 'source/node_modules/demo-lib/package.json', JSON.stringify({ name: 'demo-lib', version: '1.0.1' }, null, 2));
  assert.notEqual(await f.key('source'), key, 'the installed version joins the identity');
  const diverged = await f.cycle();
  assert.equal(diverged.cache.source.status, 'MISS', 'lockfile alone must not mask a divergent install');
  assert.equal(await f.lines('build.log'), 3);
  assert.equal((await f.cycle()).cache.source.status, 'HIT');

  // an installed entry that appears without the lockfile moving is a divergence too
  const added = await f.key('source');
  await write(f.root, 'source/node_modules/extra-lib/package.json', JSON.stringify({ name: 'extra-lib', version: '2.0.0' }, null, 2));
  assert.notEqual(await f.key('source'), added, 'the installed entry inventory joins the identity');
  const extra = await f.cycle();
  assert.equal(extra.cache.source.status, 'MISS', 'an install the lockfile does not describe must not hit');
  assert.equal((await f.cycle()).cache.source.status, 'HIT');

  // a declared dependency that disappears from the installation is another identity: miss
  const removed = await f.key('source');
  await rm(join(f.root, 'source', 'node_modules', 'demo-lib'), { recursive: true, force: true });
  assert.notEqual(await f.key('source'), removed, 'the installed entry inventory joins the identity');
  assert.equal((await f.cycle()).cache.source.status, 'MISS');
  assert.equal((await f.cycle()).cache.source.status, 'HIT');

  // and an installation that satisfies no declared dependency at all cannot be identified
  await rm(join(f.root, 'source', 'node_modules', 'extra-lib'), { recursive: true, force: true });
  const broken = await f.assess('source');
  assert.equal(broken.cacheable, false, 'an empty installation of a manifest that declares dependencies is not cacheable');
  const forced = await f.cycle();
  assert.equal(forced.cache.source.status, 'NOT_CACHEABLE', 'a forced miss, never a hit');
});

test('argv, effective environment and toolchain changes force a miss', async t => {
  const f = await fixture(t);
  await f.cycle();
  assert.equal((await f.cycle()).cache.source.status, 'HIT');

  // argv
  const argvKey = await f.key('source');
  f.config.source.commands.find(command => command.id === 'build').argv = [process.execPath, 'build.mjs', '--flag'];
  assert.notEqual(await f.key('source'), argvKey, 'argv joins the identity');
  assert.equal((await f.cycle()).cache.source.status, 'MISS');
  assert.equal(await f.lines('build.log'), 3);
  assert.equal((await f.cycle()).cache.source.status, 'HIT');
  f.config.source.commands.find(command => command.id === 'build').argv = [process.execPath, 'build.mjs'];

  // effective environment
  const previousLang = process.env.LANG;
  try {
    const envKey = await f.key('source');
    if (previousLang === undefined) process.env.LANG = 'C'; else process.env.LANG = `${previousLang}-buildcache`;
    assert.notEqual(await f.key('source'), envKey, 'the effective command environment joins the identity');
    assert.equal((await f.cycle()).cache.source.status, 'MISS');
    assert.equal((await f.cycle()).cache.source.status, 'HIT', 'the new environment is stable');
  } finally {
    if (previousLang === undefined) delete process.env.LANG; else process.env.LANG = previousLang;
  }
  assert.equal((await f.cycle()).cache.source.status, 'HIT',
    'restoring the environment returns to the identity whose artifact is already stored');

  // toolchain (simulated: same identity, executable fingerprint moved)
  const base = await f.assess('source');
  assert.equal(base.cacheable, true);
  assert.equal((await probeBuildCache(base.identity, f.root)).status, 'HIT');
  const moved = await assessBuildCache({ config: f.config, workspaceRoot: f.root, side: 'source',
    toolchain: { ...base.identity.document.toolchain, mtimeMs: base.identity.document.toolchain.mtimeMs + 1000 } });
  assert.equal(moved.cacheable, true);
  assert.notEqual(moved.identity.key, base.identity.key, 'the toolchain joins the identity');
  const simulated = await probeBuildCache(moved.identity, f.root);
  assert.equal(simulated.status, 'MISS');
  assert.equal(simulated.reason, 'ABSENT');
});

test('platform separation is simulated and forces a miss', async t => {
  const f = await fixture(t);
  await f.cycle();
  assert.equal((await f.cycle()).cache.source.status, 'HIT');

  const current = await assessBuildCache({ config: f.config, workspaceRoot: f.root, side: 'source' });
  assert.equal(current.cacheable, true);
  const otherArch = process.arch === 'x64' ? 'arm64' : 'x64';
  const foreign = await assessBuildCache({ config: f.config, workspaceRoot: f.root, side: 'source',
    platform: { os: process.platform, arch: otherArch } });
  assert.equal(foreign.cacheable, true);
  assert.notEqual(foreign.identity.key, current.identity.key, 'arch joins the identity');
  assert.equal((await probeBuildCache(foreign.identity, f.root)).status, 'MISS', 'another platform never hits');

  const foreignOs = await assessBuildCache({ config: f.config, workspaceRoot: f.root, side: 'source',
    platform: { os: process.platform === 'win32' ? 'linux' : 'win32', arch: process.arch } });
  assert.equal(foreignOs.cacheable, true);
  assert.notEqual(foreignOs.identity.key, current.identity.key, 'OS joins the identity');
  assert.equal((await probeBuildCache(foreignOs.identity, f.root)).status, 'MISS');
  assert.equal((await probeBuildCache(current.identity, f.root)).status, 'HIT', 'this platform still hits');
});

test('an input mutated by the build itself is never published', async t => {
  const f = await fixture(t);
  // The build rewrites a project file that is not a declared relevantFile, so only the identity
  // walk of this cache can see it. Nothing may be stored for that side.
  const mutating = `import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/build.log', 'run\\n');
appendFileSync('notes.txt', 'written during build\\n');
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;
  await write(f.root, 'source/build.mjs', mutating);

  const first = await f.cycle();
  assert.equal(first.checks.status, 'PASS');
  assert.equal(first.cache.source.status, 'MISS');
  assert.equal(first.cache.source.publish, 'SKIPPED:INPUTS_CHANGED_DURING_BUILD');
  assert.equal(first.cache.target.publish, 'PUBLISHED', 'the untouched side still publishes');

  const key = await f.key('source');
  assert.equal(await exists(join(buildCacheRoot(f.root), key)), false, 'no entry for an input that moved during the build');

  const second = await f.cycle();
  assert.equal(second.cache.source.status, 'MISS', 'a non-published artifact is never a hit');
  assert.equal(second.cache.source.publish, 'SKIPPED:INPUTS_CHANGED_DURING_BUILD');
  assert.equal(await exists(join(buildCacheRoot(f.root), key)), false);
  assert.equal(await f.lines('build.log'), 3, 'the first cycle built both sides, the second rebuilt only the mutated one');
  assert.equal(second.checks.status, 'PASS', 'behavior without a cache is unchanged');
});
