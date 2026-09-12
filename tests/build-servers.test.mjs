import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from 'node:http';
import { parseMigrationConfig, migrationConfigHash } from '../packages/core/dist/index.js';
import { withProjectBuildServers } from '../packages/engine/dist/build-servers.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { buildWorkspace, buildScript, write, listen, close } from './helpers/build-workspace.mjs';

const roots = [];
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function workspace() { const fixture = await buildWorkspace(); roots.push(fixture.root); return fixture; }
const run = (fixture, use = async () => {}, extra = {}) => withProjectBuildServers({ config: fixture.config,
  workspaceRoot: fixture.root, allowProjectCommands: true, ...extra }, use);
async function released(config) {
  for (const side of ['source', 'target']) { const server = await listen(Number(new URL(config[side].baseUrl).port)); await close(server); }
}
const failure = (code, side) => error => { assert.equal(error.code, code); if (side) assert.equal(error.side, side); return true; };

test('managed build declarations require explicit disposal consent and required build checks', async () => {
  const { config } = await workspace();
  assert.doesNotThrow(() => parseMigrationConfig(config));
  const legacy = structuredClone(config); delete legacy.source.build; delete legacy.target.build;
  assert.doesNotThrow(() => parseMigrationConfig(legacy));
  for (const change of [
    c => { c.source.build.cleanOutput = false; },
    c => { delete c.source.build.cleanOutput; },
    c => { c.checks[0].required = false; },
    c => { c.source.commands[0].kind = 'test'; },
    c => { c.target.build.outputDir = 'src/generated'; },
    c => { c.target.build.outputDir = 'main.ts'; },
    c => { c.target.protectedPaths = ['dist/keep']; },
    c => { c.target.writePaths = ['dist']; },
    c => { c.source.build.outputDir = '.'; },
  ]) { const invalid = structuredClone(config); change(invalid); assert.throws(() => parseMigrationConfig(invalid)); }
});

test('serves fresh immutable build bytes with matching health and releases both ports', async () => {
  const fixture = await workspace(); await write(fixture.root, 'source/dist/old.js', 'stale');
  const result = await run(fixture, async session => {
    for (const side of ['source', 'target']) {
      const identity = session[side];
      const health = await fetch(`${identity.origin}/__migration_harness_health__`);
      assert.deepEqual(await health.json(), identity);
      assert.equal(identity.configurationHash, migrationConfigHash(fixture.config));
      const page = await fetch(identity.origin);
      assert.equal(page.headers.get('x-migration-build'), identity.buildHash);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(await page.text(), /<button>Save<\/button>/);
      assert.equal((await fetch(`${identity.origin}/old.js`)).status, 404);
      assert.equal((await fetch(`${identity.origin}/missing.js`, { headers: { accept: 'text/html' } })).status, 404);
      assert.equal((await fetch(`${identity.origin}/app.js.map`)).status, 404);
      assert.equal((await fetch(`${identity.origin}/page/42`, { headers: { accept: 'text/html' } })).status, 200);
      assert.equal((await fetch(`${identity.origin}/.env`)).status, 400);
      assert.equal((await fetch(identity.origin, { method: 'POST' })).status, 405);
      const foreignHostStatus = await new Promise((done, reject) => {
        get(identity.origin, { headers: { host: 'example.invalid' } }, response => {
          response.resume(); response.on('end', () => done(response.statusCode)); response.on('error', reject);
        }).on('error', reject);
      });
      assert.equal(foreignHostStatus, 421);
      const head = await fetch(identity.origin, { method: 'HEAD' }); assert.equal(await head.text(), '');
      assert.ok(Number(head.headers.get('content-length')) > 0);
    }
    session.source.buildHash = '0'.repeat(64);
    return 'completed';
  });
  assert.equal(result.value, 'completed'); assert.equal(result.checks.status, 'PASS');
  assert.notEqual(result.builds.source.buildHash, '0'.repeat(64));
  assert.equal(result.builds.source.buildHash, result.builds.target.buildHash);
  assert.notEqual(result.builds.source.runId, result.builds.target.runId);
  await released(fixture.config);
});

test('occupied target port preserves unrelated server and old output without executing builds', async () => {
  const fixture = await workspace();
  await write(fixture.root, 'source/dist/index.html', 'keep');
  const other = await listen(Number(new URL(fixture.config.target.baseUrl).port));
  try {
    await assert.rejects(run(fixture), failure('PORT_IN_USE', 'target'));
    assert.equal(await readFile(join(fixture.root, 'source/dist/index.html'), 'utf8'), 'keep');
    assert.equal(await fetch(fixture.config.target.baseUrl).then(r => r.text()), 'unrelated');
    const source = await listen(Number(new URL(fixture.config.source.baseUrl).port)); await close(source);
  } finally { await close(other); }
});

test('no-op and failing builds cannot reuse preexisting artifacts', async () => {
  for (const [script, code] of [['', 'BUILD_OUTPUT_MISSING'], ['process.exit(2);', 'BUILD_CHECK_FAILED']]) {
    const fixture = await workspace();
    await write(fixture.root, 'source/dist/index.html', 'old');
    await write(fixture.root, 'source/build.mjs', script);
    await assert.rejects(run(fixture), failure(code, code === 'BUILD_OUTPUT_MISSING' ? 'source' : undefined));
    await released(fixture.config);
  }
});

test('callback errors, cancellation and session timeout close only owned servers', async () => {
  for (const mode of ['throw', 'abort', 'timeout']) {
    const fixture = await workspace(), controller = new AbortController();
    const sentinel = new Error('callback failure');
    if (mode === 'timeout') fixture.config.limits.maxDurationMs = 3000;
    let entered = false;
    await assert.rejects(run(fixture, async ({ signal }) => {
      entered = true;
      if (mode === 'throw') throw sentinel;
      const cancelled = new Promise(done => signal.addEventListener('abort', done, { once: true }));
      if (mode === 'abort') controller.abort();
      await cancelled;
    }, { signal: controller.signal }), mode === 'throw' ? error => error === sentinel : failure(mode === 'abort' ? 'ABORTED' : 'SESSION_TIMEOUT'));
    assert.ok(entered); await released(fixture.config);
  }
});

test('changes to declared code during serving invalidate the session', async () => {
  const fixture = await workspace();
  await assert.rejects(run(fixture, async () => write(fixture.root, 'source/main.ts', 'changed')), failure('BUILD_INPUT_CHANGED'));
  await released(fixture.config);
});

test('disk mutation cannot change bytes already served and invalidates the final result', async () => {
  const fixture = await workspace();
  await assert.rejects(run(fixture, async ({ target }) => {
    const before = await fetch(target.origin).then(r => r.text());
    await write(fixture.root, 'target/dist/index.html', 'replaced');
    assert.equal(await fetch(target.origin).then(r => r.text()), before);
  }), failure('BUILD_DISK_CHANGED', 'target'));
  await released(fixture.config);
});

test('unsafe output roots and fixture overlap are refused before cleaning', async () => {
  for (const mode of ['symlink', 'fixtures']) {
    const fixture = await workspace();
    if (mode === 'symlink') await symlink(join(fixture.root, 'source'), join(fixture.root, 'target/dist'));
    else fixture.config.scenarios[0].fixtureRoot = 'target/dist';
    await assert.rejects(run(fixture), failure('UNSAFE_BUILD_DIRECTORY', 'target'));
    assert.match(await readFile(join(fixture.root, 'source/main.ts'), 'utf8'), /export/);
  }
});

test('unsafe, incomplete and oversized build artifacts are not served', async () => {
  for (const [extra, code] of [
    ['writeFileSync("dist/.env", "secret");', 'BUILD_OUTPUT_UNSAFE'],
    ['writeFileSync("dist/server.key", "secret");', 'BUILD_OUTPUT_UNSAFE'],
    ['import {symlinkSync} from "node:fs";symlinkSync("../main.ts", "dist/linked.txt");', 'BUILD_OUTPUT_UNSAFE'],
    ['import {linkSync} from "node:fs";linkSync("main.ts", "dist/linked.txt");', 'BUILD_OUTPUT_UNSAFE'],
    ['writeFileSync("dist/index.html", "");', 'BUILD_OUTPUT_MISSING'],
    ['writeFileSync("dist/huge.js", Buffer.alloc(8 * 1024 * 1024 + 1));', 'BUILD_OUTPUT_TOO_LARGE'],
  ]) {
    const fixture = await workspace(); await write(fixture.root, 'source/build.mjs', `${buildScript}\n${extra}`);
    await assert.rejects(run(fixture), failure(code, 'source')); await released(fixture.config);
  }
});

test('authorization, local serving configuration and initial cancellation are mandatory', async () => {
  const fixture = await workspace();
  await assert.rejects(run(fixture, undefined, { allowProjectCommands: false }), failure('EXECUTION_NOT_AUTHORIZED'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(fixture, undefined, { signal: controller.signal }), failure('ABORTED'));
  delete fixture.config.source.build;
  await assert.rejects(run(fixture), failure('SERVING_CONFIG_MISSING', 'source'));
  fixture.config.source.build = { commandId: 'build', outputDir: 'dist', cleanOutput: true };
  fixture.config.source.baseUrl = 'https://example.invalid';
  fixture.config.scenarios[0].bindings.source.entryUrl = 'https://example.invalid/';
  await assert.rejects(run(fixture), failure('SERVING_CONFIG_MISSING', 'source'));
});

test('managed build settings participate in reference environment identity', async () => {
  const fixture = await workspace();
  const collect = () => collectMigrationReference({ config: fixture.config, workspaceRoot: fixture.root });
  const before = await collect(); fixture.config.source.build.outputDir = 'output';
  const after = await collect();
  assert.notEqual(before.criteria.environmentHash, after.criteria.environmentHash);
});
