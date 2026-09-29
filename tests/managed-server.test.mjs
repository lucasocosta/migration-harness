import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { withProjectBuildServers } from '../packages/engine/dist/build-servers.js';
import { buildWorkspace, write, listen, close } from './helpers/build-workspace.mjs';

const roots = [];
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function workspace() { const fixture = await buildWorkspace(); roots.push(fixture.root); return fixture; }
const run = (fixture, use = async () => {}, extra = {}) => withProjectBuildServers({ config: fixture.config,
  workspaceRoot: fixture.root, allowProjectCommands: true, ...extra }, use);
const port = (config, side) => Number(new URL(config[side].baseUrl).port);
async function assertPortsFree(config) {
  for (const side of ['source', 'target']) {
    const held = port(config, side);
    let server;
    try { server = await listen(held); }
    catch { assert.fail(`${side} port ${held} is still held after teardown`); }
    finally { if (server) await close(server); }
  }
}
// Ephemeral-port fixtures: a node script stands in for a PHP/Java managed server.
const serveUp = `import { createServer } from 'node:http';
createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<p>managed-side</p>'); }).listen(Number(process.argv[2]), '127.0.0.1');`;
const serveSilent = `import { createServer } from 'node:http';
createServer(() => {}).listen(Number(process.argv[2]), '127.0.0.1');`;
const serveDies = 'process.exit(7);';

async function declareServe(fixture, side, script, declaration = {}) {
  await write(fixture.root, `${side}/serve.mjs`, script);
  fixture.config[side].commands.push({ id: 'serve', kind: 'serve',
    argv: [process.execPath, 'serve.mjs', String(port(fixture.config, side))], cwd: '.', timeoutMs: 5000 });
  fixture.config[side].serve = { commandId: 'serve', ...declaration };
}

test('managed serve command owns its port and the capture session reaches it', async () => {
  const fixture = await workspace();
  await declareServe(fixture, 'source', serveUp);
  const result = await run(fixture, async session => {
    const managed = await fetch(session.source.origin);
    assert.equal(managed.status, 200);
    // The child owns the port: neither the harness health header nor the static snapshot answers here.
    assert.equal(managed.headers.get('x-migration-build'), null);
    const body = await managed.text();
    assert.match(body, /managed-side/);
    assert.doesNotMatch(body, /Save/);
    return 'captured';
  });
  assert.equal(result.value, 'captured');
  assert.equal(result.checks.status, 'PASS');
  assert.equal(result.builds.source.origin, fixture.config.source.baseUrl);
  await assertPortsFree(fixture.config);
});

test('session failure tears down the managed process tree and frees both ports', async () => {
  const fixture = await workspace();
  await declareServe(fixture, 'source', serveUp);
  await declareServe(fixture, 'target', serveUp);
  await assert.rejects(run(fixture, async session => {
    assert.equal((await fetch(session.source.origin)).status, 200);
    assert.equal((await fetch(session.target.origin)).status, 200);
    throw new Error('capture failed');
  }), /capture failed/);
  await assertPortsFree(fixture.config);
});

test('readiness timeout fails closed with SERVER_READY_TIMEOUT before any capture', async () => {
  const fixture = await workspace();
  await declareServe(fixture, 'source', serveSilent, { readyTimeoutMs: 1500 });
  let entered = false;
  await assert.rejects(run(fixture, async () => { entered = true; }), error => {
    assert.equal(error.code, 'SERVER_READY_TIMEOUT');
    assert.equal(error.side, 'source');
    return true;
  });
  assert.equal(entered, false);
  await assertPortsFree(fixture.config);
});

test('a serve child exiting before readiness reports SERVER_EXITED_EARLY with its exit code', async () => {
  const fixture = await workspace();
  await declareServe(fixture, 'source', serveDies, { readyTimeoutMs: 5000 });
  let entered = false;
  await assert.rejects(run(fixture, async () => { entered = true; }), error => {
    assert.equal(error.code, 'SERVER_EXITED_EARLY');
    assert.equal(error.side, 'source');
    assert.equal(error.exitCode, 7);
    return true;
  });
  assert.equal(entered, false);
  await assertPortsFree(fixture.config);
});

test('sides without serve keep static outputDir serving', async () => {
  const mixed = await workspace();
  await declareServe(mixed, 'source', serveUp);
  const sideBySide = await run(mixed, async session => {
    const health = await fetch(`${session.target.origin}/__migration_harness_health__`);
    assert.deepEqual(await health.json(), session.target);
    const page = await fetch(session.target.origin);
    assert.equal(page.headers.get('x-migration-build'), session.target.buildHash);
    assert.match(await page.text(), /<button>Save<\/button>/);
    assert.equal((await fetch(session.source.origin)).status, 200);
    return true;
  });
  assert.equal(sideBySide.value, true);
  assert.equal(sideBySide.checks.status, 'PASS');
  await assertPortsFree(mixed.config);

  const plain = await workspace();
  const staticBoth = await run(plain, async session => {
    for (const side of ['source', 'target']) {
      const health = await fetch(`${session[side].origin}/__migration_harness_health__`);
      assert.deepEqual(await health.json(), session[side]);
      const page = await fetch(session[side].origin);
      assert.equal(page.headers.get('x-migration-build'), session[side].buildHash);
      assert.match(await page.text(), /<button>Save<\/button>/);
    }
    return true;
  });
  assert.equal(staticBoth.value, true);
  assert.equal(staticBoth.builds.source.buildHash, staticBoth.builds.target.buildHash);
  await assertPortsFree(plain.config);
});
