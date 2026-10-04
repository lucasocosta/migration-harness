/**
 * Identity-gap regressions from the final audit (all exercised with the cache opted in):
 *   a. an input in a **sibling directory declared by the config** — covered by extending the walk to
 *      the declared roots outside the project root, so changing the sibling forces a miss;
 *   b. **content inside an installed dependency** with no manifest change — covered by fingerprinting
 *      the managed entry content, so editing the package forces a miss;
 *   c. a build whose **network input is not visible in argv** (an intermediate script calling fetch) —
 *      fail-closed through the conservative eligibility scan, so it is never cached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assessBuildCache, buildCacheRoot } from '../packages/engine/dist/build-cache.js';
import { withProjectBuildServers } from '../packages/engine/dist/build-servers.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// The managed build reads a sibling declared as the scenario fixture root: `../shared/template`.
const SHARED_BUILD = `import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/build.log', 'run\\n');
const template = readFileSync('../shared/template', 'utf8');
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>' + template + '</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;
const LINT_SCRIPT = `import { mkdirSync, appendFileSync } from 'node:fs';
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/lint.log', 'run\\n');`;

async function fixture(t, build = SHARED_BUILD) {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  // The cache is opt-in; every case in this file enables it explicitly.
  process.env.MIGRATION_HARNESS_BUILD_CACHE = '1';
  t.after(() => { delete process.env.MIGRATION_HARNESS_BUILD_CACHE; });
  // Declare the sibling directory: the audit's "sibling input declared by the config".
  config.scenarios[0].fixtureRoot = 'shared';
  await write(root, 'shared/template', 'v1');
  for (const side of ['source', 'target']) {
    await write(root, `${side}/build.mjs`, build);
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

test('a. a declared sibling input joins the identity and forces a miss when it changes', async t => {
  const f = await fixture(t);
  const first = await f.cycle();
  assert.equal(first.cache.source.status, 'MISS');
  assert.equal(first.cache.source.publish, 'PUBLISHED');
  assert.equal(await f.lines('build.log'), 2);
  assert.equal((await f.cycle()).cache.source.status, 'HIT', 'the declared sibling is stable between cycles');
  assert.equal(await f.lines('build.log'), 2, 'a hit never executes the build');

  const key = await f.key('source');
  await write(f.root, 'shared/template', 'v2');
  assert.notEqual(await f.key('source'), key, 'the declared sibling bytes join the identity');
  const after = await f.cycle();
  assert.equal(after.cache.source.status, 'MISS', 'a sibling input change must not be served from cache');
  assert.equal(after.cache.target.status, 'MISS', 'both sides read the declared sibling, so both rebuild');
  assert.equal(after.checks.status, 'PASS');
  assert.equal(await f.lines('build.log'), 4, 'the changed sibling rebuilt both sides');
  assert.equal((await f.cycle()).cache.source.status, 'HIT', 'the new identity is stable');
  assert.equal(await f.lines('build.log'), 4);
});

test('b. content edited inside an installed dependency joins the identity and forces a miss', async t => {
  const f = await fixture(t);
  await write(f.root, 'source/package.json', JSON.stringify({ name: 'source-app', version: '1.0.0', dependencies: { 'demo-lib': '^1.0.0' } }, null, 2));
  await write(f.root, 'source/pnpm-lock.yaml', 'lockfileVersion: 6.0\ndemo-lib: 1.0.0\n');
  await write(f.root, 'source/node_modules/.modules.yaml', 'lockfileVersion: "6.0"\n');
  await write(f.root, 'source/node_modules/demo-lib/package.json', JSON.stringify({ name: 'demo-lib', version: '1.0.0' }, null, 2));
  await write(f.root, 'source/node_modules/demo-lib/index.js', 'export const value = 1;\n');

  await f.cycle();
  assert.equal((await f.cycle()).cache.source.status, 'HIT', 'the installation is identified');
  assert.equal(await f.lines('build.log'), 2);

  // No manifest, lockfile or state file moves — only the executed package content.
  const key = await f.key('source');
  await write(f.root, 'source/node_modules/demo-lib/index.js', 'export const value = 2;\n');
  assert.notEqual(await f.key('source'), key, 'installed content bytes join the identity');
  const after = await f.cycle();
  assert.equal(after.cache.source.status, 'MISS', 'post-install content tampering must not hit');
  assert.equal(after.cache.target.status, 'HIT', 'the untouched side keeps its entry');
  assert.equal(await f.lines('build.log'), 3);
  assert.equal((await f.cycle()).cache.source.status, 'HIT', 'the tampered identity is stable');
});

test('c. a build entry that reaches the network through a local script is never cacheable', async t => {
  const networkBuild = `import './network-helper.mjs';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/build.log', 'run\\n');
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;
  const f = await fixture(t);
  // Only the source side reaches the network, and only through an intermediate script:
  // invisible to the argv classifier (argv is just `node build.mjs`).
  await write(f.root, 'source/build.mjs', networkBuild);
  await write(f.root, 'source/network-helper.mjs', "export const remote = () => fetch('https://example.invalid/data');\n");

  const assessment = await f.assess('source');
  assert.equal(assessment.cacheable, false, 'the conservative eligibility scan refuses it');
  assert.equal(assessment.reason, 'NETWORK_REFERENCE');

  const result = await f.cycle();
  assert.equal(result.cache.source.status, 'NOT_CACHEABLE');
  assert.equal(result.cache.source.reason, 'NETWORK_REFERENCE');
  assert.equal(result.cache.target.status, 'MISS', 'the target has no network input and stays cacheable');
  assert.equal(result.checks.status, 'PASS', 'behavior is identical to having no cache');
  assert.equal(await f.lines('build.log'), 2, 'the build really ran');

  const stored = (await readdir(buildCacheRoot(f.root)).catch(() => [])).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.equal(stored.length, 1, 'only the network-free side is stored');
  assert.equal((await f.cycle()).cache.source.status, 'NOT_CACHEABLE', 'a non-cacheable build is never retried into a hit');
});
