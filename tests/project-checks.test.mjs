import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parseProjectCheckReport } from '../packages/core/dist/index.js';
import { preflightProjectChecks, runProjectChecks } from '../packages/engine/dist/project-checks.js';

const exec = promisify(execFile);
const cli = resolve('packages/cli/dist/index.js');
const roots = [];
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function write(root, path, content) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
async function workspace(script = 'console.log("private-runtime-value");') {
  const root = await mkdtemp(join(tmpdir(), 'project-checks-')); roots.push(root);
  await write(root, 'source/main.ts', 'export const source = 1;\n');
  await write(root, 'target/check.mjs', script);
  return root;
}
function config() {
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'native-checks',
    source: { root: 'source', baseUrl: 'http://localhost:4200', relevantFiles: ['main.ts'], commands: [] },
    target: { root: 'target', baseUrl: 'http://localhost:5173', relevantFiles: ['check.mjs'],
      writePaths: ['page.tsx'], protectedPaths: [], commands: [{ id: 'build', kind: 'build', argv: [process.execPath, 'check.mjs'], cwd: '.', timeoutMs: 3000 }] },
    scenarios: [{ definition: { scenarioId: 'boot', unitId: 'page', name: 'Boot', description: 'Synthetic fixture',
      entryUrl: 'http://localhost:4200/', preconditions: {}, steps: [], testDataProfile: 'standard' }, required: true,
      fixtureRoot: 'fixtures', bindings: { source: { entryUrl: 'http://localhost:4200/', steps: [] }, target: { entryUrl: 'http://localhost:5173/', steps: [] } } }],
    checks: [{ id: 'build-target', side: 'target', commandId: 'build', required: true }], requirements: [], acceptedDifferences: [],
    policy: {}, reset: { kind: 'ISOLATED_FIXTURES' }, environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 10000 },
  };
}
const run = (root, extra = {}) => runProjectChecks({ config: config(), workspaceRoot: root, phase: 'baseline', allowProjectCommands: true, ...extra });
const exists = path => stat(path).then(() => true, () => false);

test('preflight checks roots, declared inputs and command cwd without executing commands', async () => {
  const root = await workspace('import{writeFileSync}from"node:fs";writeFileSync("executed", "yes");');
  assert.equal((await preflightProjectChecks({ config: config(), workspaceRoot: root })).status, 'PASS');
  assert.equal(await exists(join(root, 'target/executed')), false);
  const missing = config(); missing.target.commands[0].cwd = 'missing';
  assert.ok((await preflightProjectChecks({ config: missing, workspaceRoot: root })).findings.some(item => item.code === 'CWD_UNAVAILABLE'));
  const absent = config(); absent.source.relevantFiles = ['missing.ts'];
  assert.ok((await preflightProjectChecks({ config: absent, workspaceRoot: root })).findings.some(item => item.code === 'INPUT_UNAVAILABLE'));
  await symlink(join(root, 'source'), join(root, 'target/linked'));
  const linked = config(); linked.target.commands[0].cwd = 'linked';
  assert.equal((await preflightProjectChecks({ config: linked, workspaceRoot: root })).status, 'INCONCLUSIVE');
});

test('commands need explicit authorization and bad preflight never executes', async () => {
  const root = await workspace('import{writeFileSync}from"node:fs";writeFileSync("executed", "yes");');
  const refused = await run(root, { allowProjectCommands: false });
  assert.equal(refused.status, 'INCONCLUSIVE');
  assert.equal(refused.checks[0].reason, 'NOT_RUN');
  assert.ok(refused.findings.some(item => item.code === 'EXECUTION_NOT_AUTHORIZED'));
  const absent = config(); absent.source.relevantFiles = ['missing.ts'];
  assert.equal((await run(root, { config: absent })).status, 'INCONCLUSIVE');
  assert.equal(await exists(join(root, 'target/executed')), false);
});

test('native commands receive project cwd and literal argv, not a shell or parent secrets', async () => {
  const root = await workspace('import{writeFileSync}from"node:fs";if(process.env.HARNESS_TEST_SECRET)process.exit(7);writeFileSync("argv.json",JSON.stringify(process.argv.slice(2)));console.log("private-runtime-value");');
  const c = config(); c.target.commands[0].argv.push('$(touch injected)', '; echo secret');
  const previous = process.env.HARNESS_TEST_SECRET; process.env.HARNESS_TEST_SECRET = 'do-not-inherit';
  let report;
  try { report = await run(root, { config: c }); }
  finally { if (previous === undefined) delete process.env.HARNESS_TEST_SECRET; else process.env.HARNESS_TEST_SECRET = previous; }
  assert.equal(report.status, 'PASS');
  assert.deepEqual(parseProjectCheckReport(report), report);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'target/argv.json'), 'utf8')), ['$(touch injected)', '; echo secret']);
  assert.equal(await exists(join(root, 'target/injected')), false);
  assert.equal(report.checks[0].output.omitted, true); assert.ok(report.checks[0].output.stdoutBytes > 0);
  assert.ok(!JSON.stringify(report).includes('private-runtime-value'));
});

test('baseline failure stays failing, with explicit comparisons after repairs', async () => {
  const root = await workspace('import{existsSync}from"node:fs";process.exit(existsSync("fail")?2:0);');
  await write(root, 'target/fail', 'yes');
  const baseline = await run(root); assert.equal(baseline.status, 'FAIL');
  const existing = await run(root, { phase: 'candidate', baseline });
  assert.equal(existing.status, 'FAIL'); assert.equal(existing.checks[0].baselineComparison, 'BASELINE_CHECK_FAILED');
  await rm(join(root, 'target/fail'));
  const fixed = await run(root, { phase: 'candidate', baseline });
  assert.equal(fixed.status, 'PASS'); assert.equal(fixed.checks[0].baselineComparison, 'RESOLVED');
  const passing = await run(root); await write(root, 'target/fail', 'yes');
  assert.equal((await run(root, { phase: 'candidate', baseline: passing })).checks[0].baselineComparison, 'NEW_CHECK_FAILURE');
  const mismatch = config(); mismatch.target.commands[0].timeoutMs++;
  const refused = await run(root, { config: mismatch, phase: 'candidate', baseline });
  assert.equal(refused.status, 'INCONCLUSIVE'); assert.equal(refused.checks[0].reason, 'NOT_RUN');
  assert.ok(refused.findings.some(item => item.code === 'BASELINE_MISMATCH'));
});

test('all checks run; optional failures do not satisfy or replace required checks', async () => {
  const root = await workspace(); const c = config();
  c.target.commands.push({ id: 'lint', kind: 'lint', argv: [process.execPath, '-e', 'process.exit(2)'], cwd: '.', timeoutMs: 3000 });
  c.checks.push({ id: 'lint-target', side: 'target', commandId: 'lint', required: true });
  const required = await run(root, { config: c });
  assert.equal(required.checks.length, 2); assert.equal(required.status, 'FAIL');
  c.checks[1].required = false;
  const advisory = await run(root, { config: c });
  assert.equal(advisory.status, 'PASS'); assert.equal(advisory.checks[1].status, 'FAIL');
});

test('timeouts, output limits, missing executables and aborts are inconclusive', async () => {
  for (const [script, expected] of [
    ['setInterval(()=>{},10);', 'TIMEOUT'],
    ['process.stdout.write("x".repeat(2_000_000));', 'OUTPUT_LIMIT'],
  ]) {
    const root = await workspace(script), c = config(); c.target.commands[0].timeoutMs = 500;
    const result = await run(root, { config: c });
    assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.checks[0].reason, expected);
  }
  const root = await workspace(), missing = config(); missing.target.commands[0].argv = ['missing-executable-harness-fixture'];
  assert.equal((await run(root, { config: missing })).checks[0].reason, 'SPAWN_FAILED');
  const controller = new AbortController(); controller.abort();
  assert.equal((await run(root, { signal: controller.signal })).checks[0].reason, 'ABORTED');
});

test('owned descendants are cleaned after timeout and after successful parent exit', async () => {
  for (const hang of [true, false]) {
    const root = await workspace(`import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";
      const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},10)"],{stdio:"ignore"});
      writeFileSync("child.pid",String(child.pid));child.unref();${hang ? 'setInterval(()=>{},10);' : ''}`);
    const c = config(); c.target.commands[0].timeoutMs = 500;
    const result = await run(root, { config: c }); assert.equal(result.status, hang ? 'INCONCLUSIVE' : 'PASS');
    const pid = Number(await readFile(join(root, 'target/child.pid'), 'utf8'));
    for (let i = 0; i < 20; i++) {
      const state = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (!state || state.split(' ')[2] === 'Z') break;
      await delay(50);
    }
    const state = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!state || state.split(' ')[2] === 'Z', 'owned child must no longer be executing');
  }
});

test('changes to declared inputs during checks invalidate the result', async () => {
  const root = await workspace('import{writeFileSync}from"node:fs";writeFileSync("../source/main.ts","changed");');
  const result = await run(root); assert.equal(result.status, 'INCONCLUSIVE');
  assert.ok(result.findings.some(item => item.code === 'INPUT_CHANGED'));
  assert.equal(result.checks[0].status, 'PASS');
});

test('timeout cleanup does not terminate an unrelated process', async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], { detached: true, stdio: 'ignore' });
  try {
    const root = await workspace('setInterval(()=>{},10);'), c = config(); c.target.commands[0].timeoutMs = 300;
    assert.equal((await run(root, { config: c })).checks[0].reason, 'TIMEOUT');
    assert.doesNotThrow(() => process.kill(other.pid, 0));
  } finally {
    const ended = new Promise(done => other.once('exit', done));
    other.kill('SIGKILL'); await ended;
  }
});

test('check-projects CLI separates preflight, authorization, baseline and native failure exit codes', async () => {
  const help = await exec(process.execPath, [cli, 'check-projects', '--help']);
  assert.match(help.stdout, /Not behavioral equivalence/);
  const root = await workspace('process.exit(2);'); await write(root, 'config.json', JSON.stringify(config()));
  const args = ['--config', join(root, 'config.json'), '--workspace-root', root, '--artifact-root', join(root, 'results')];
  const call = async (...more) => {
    try { return { ...await exec(process.execPath, [cli, 'check-projects', ...args, ...more]), code: 0 }; }
    catch (error) { return error; }
  };
  assert.equal((await call('--preflight-only', '--out', 'preflight.json')).code, 0);
  assert.equal(JSON.parse(await readFile(join(root, 'results/preflight.json'), 'utf8')).kind, 'PROJECT_PREFLIGHT');
  assert.equal((await call('--out', 'refused.json')).code, 5);
  assert.equal((await call('--allow-project-commands', '--out', 'baseline.json')).code, 4);
  assert.equal(JSON.parse(await readFile(join(root, 'results/baseline.json'), 'utf8')).phase, 'baseline');
  assert.equal((await call('--allow-project-commands', '--phase', 'candidate', '--baseline', join(root, 'results/baseline.json'), '--out', 'candidate.json')).code, 4);
  assert.equal((await call('--allow-project-commands', '--out', '../escaped.json')).code, 1);
});

test('CLI refuses existing or project-local outputs before executing a command', async () => {
  const root = await workspace('import{writeFileSync}from"node:fs";writeFileSync("executed","yes");');
  await write(root, 'config.json', JSON.stringify(config()));
  await write(root, 'results/existing.json', 'keep');
  for (const [artifact, output] of [[join(root, 'results'), 'existing.json'], [join(root, 'target'), 'new-result.json']]) {
    await assert.rejects(exec(process.execPath, [cli, 'check-projects', '--config', join(root, 'config.json'),
      '--workspace-root', root, '--artifact-root', artifact, '--out', output, '--allow-project-commands']));
    assert.equal(await exists(join(root, 'target/executed')), false);
  }
  assert.equal(await readFile(join(root, 'results/existing.json'), 'utf8'), 'keep');
});
