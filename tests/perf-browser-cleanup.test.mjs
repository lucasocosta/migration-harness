import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildWorkspace, write, listen, close } from './helpers/build-workspace.mjs';
import { captureProjectSuite } from '../packages/engine/dist/capture-suite.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';

/**
 * Lifecycle safety net for the browser-process reuse stage (docs/PLAN-V2.md §4, lever 2): a capture
 * that is aborted, and an operation that is killed outright, may never leave a Chromium process
 * behind. Assertions walk the real process tree (`ps`), scoped to the processes this test owns, so
 * unrelated Chromium instances on the machine are never part of the verdict.
 */

let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }
const withoutChromium = t => {
  if (!chromiumIssue) return false;
  t.skip(`Chromium unavailable: ${chromiumIssue}`);
  return true;
};
const withoutPosixTree = t => {
  if (process.platform !== 'win32') return false;
  t.skip('POSIX process-tree semantics; Windows tree kill is covered by CI integration');
  return true;
};

const processRows = () => execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
  .split('\n').map(line => line.trim())
  .map(line => { const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/); return match ? { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] } : undefined; })
  .filter(Boolean);

const descendantsOf = root => {
  const byParent = new Map();
  for (const row of processRows()) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const tree = [], stack = [root];
  while (stack.length) for (const child of byParent.get(stack.pop()) ?? []) { tree.push(child); stack.push(child.pid); }
  return tree;
};

/** Chromium processes Playwright started under a given pid (the binary path carries `ms-playwright`). */
const browserProcessesOf = pid => descendantsOf(pid).filter(row => row.args.includes('ms-playwright'));
const isAlive = pid => {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim().length > 0; }
  catch { return false; }
};
/** Poll until `check` reports a clean tree (or the deadline expires). Returns true when clean. */
const untilGone = async check => {
  for (let attempt = 0; attempt < 50; attempt++) { if (!check()) return true; await delay(100); }
  return !check();
};
const describe = rows => rows.map(row => `${row.pid}:${row.args.slice(0, 120)}`).join(' | ');

async function portsReleased(config) {
  for (const side of ['source', 'target']) {
    const server = await listen(Number(new URL(config[side].baseUrl).port));
    await close(server);
  }
}

/**
 * The cheapest workspace whose capture blocks: builds are the fixture's node scripts and the
 * scenario waits for a locator that never appears, so an abort always lands mid-capture.
 */
async function hangingFixture(t) {
  const value = await buildWorkspace();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const hits = [];
  const api = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/hit') hits.push(Date.now());
    response.end('{}');
  });
  await new Promise(done => api.listen(0, '127.0.0.1', done));
  t.after(() => close(api));
  const origin = `http://127.0.0.1:${api.address().port}`;
  for (const side of ['source', 'target']) {
    const html = '<!doctype html><html lang="en"><body><button>Save</button><div role="status">idle</div><script src="/app.js"></script></body></html>';
    const js = `fetch('${origin}/hit').catch(function () {});`;
    await write(value.root, `${side}/build.mjs`,
      `import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.html',${JSON.stringify(html)});writeFileSync('dist/app.js',${JSON.stringify(js)});`);
  }
  value.config.policy = { allowedOrigins: [origin] };
  value.config.limits = { ...value.config.limits, maxDurationMs: 60_000 };
  value.config.scenarios[0].definition.completionSignal = { type: 'LOCATOR_VISIBLE', targetRole: 'button', targetName: 'Never appears', timeoutMs: 45_000 };
  return { ...value, hits };
}

test('aborting a suite mid-capture closes its browser and leaves no orphan Chromium process', async t => {
  if (withoutPosixTree(t) || withoutChromium(t)) return;
  const fixture = await hangingFixture(t);
  const controller = new AbortController();
  const suite = captureProjectSuite({ config: fixture.config, workspaceRoot: fixture.root,
    artifactPath: 'results/abort', allowProjectCommands: true, signal: controller.signal });
  try {
    for (let waited = 0; !fixture.hits.length && waited < 30_000; waited += 50) await delay(50);
    assert.ok(fixture.hits.length, 'a capture must have navigated before the abort');
  } finally {
    controller.abort();
  }
  const report = await suite;
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.ok(report.captures.some(record => record.reason === 'ABORTED'),
    `the in-flight capture records the abort: ${JSON.stringify(report.captures.map(record => [record.status, record.reason]))}`);
  assert.ok(report.captures.some(record => record.status === 'NOT_RUN'),
    'captures after the abort never ran: no capture can run past an aborted session');

  const survivors = browserProcessesOf(process.pid);
  assert.ok(await untilGone(() => browserProcessesOf(process.pid).length > 0),
    `the suite browser outlived the aborted operation: ${describe(survivors)}`);
  await portsReleased(fixture.config);
});

/** Runs a real `prepareMigration` whose capture hangs; the parent kills it mid-capture. */
const CRASH_CHILD = `
import { prepareMigration } from './packages/engine/dist/migration-operations.js';
import { buildWorkspace } from './tests/helpers/build-workspace.mjs';
const fixture = await buildWorkspace();
fixture.config.limits = { ...fixture.config.limits, maxDurationMs: 120000 };
fixture.config.scenarios[0].definition.completionSignal = { type: 'LOCATOR_VISIBLE', targetRole: 'button', targetName: 'Never appears', timeoutMs: 60000 };
console.log('ROOT ' + fixture.root);
await prepareMigration({ config: fixture.config, workspaceRoot: fixture.root, artifactPath: 'artifacts/crash', allowProjectCommands: true });
console.log('DONE');
`;

test('a hard crash during a capture leaves no orphan Chromium process behind', async t => {
  if (withoutPosixTree(t) || withoutChromium(t)) return;
  const child = spawn(process.execPath, ['--input-type=module', '-e', CRASH_CHILD], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let workspace;
  try {
    for (let waited = 0; !/ROOT /.test(output) && child.exitCode === null && waited < 60_000; waited += 100) await delay(100);
    workspace = /ROOT (\S+)/.exec(output)?.[1];
    assert.ok(workspace, `the child never reported its workspace: ${output}`);

    // A renderer process exists only while a page is open, i.e. inside a capture — never during
    // the preflight probe alone, so this is the "mid-capture" marker.
    let pageProcesses = [];
    for (let waited = 0; waited < 30_000 && !pageProcesses.length; waited += 100) {
      pageProcesses = browserProcessesOf(child.pid).filter(row => row.args.includes('--type=renderer'));
      if (!pageProcesses.length) await delay(100);
    }
    assert.ok(pageProcesses.length, `no capture was in progress under the child: ${output}`);
    const launched = browserProcessesOf(child.pid);
    assert.ok(launched.length >= 1, `Chromium processes missing from the child's tree: ${output}`);

    child.kill('SIGKILL');
    await once(child, 'exit');
    const survivors = launched.filter(row => isAlive(row.pid));
    assert.ok(await untilGone(() => launched.filter(row => isAlive(row.pid)).length > 0),
      `Chromium processes survived the crash: ${describe(survivors)}`);
    assert.ok(!output.includes('DONE'), 'the operation must still be running when it is killed');
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    if (workspace) {
      await rm(new ArtifactStore(join(workspace, 'artifacts/crash')).privateRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }
});
