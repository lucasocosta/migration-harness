import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { buildWorkspace, write, listen, close } from '../helpers/build-workspace.mjs';
import { captureProjectSuite } from '../../packages/engine/dist/capture-suite.js';
import { captureScenario } from '../../packages/engine/dist/scenario-runner/index.js';

const diagnostics = report => JSON.stringify({ failureCode: report.failureCode,
  captures: report.captures.map(({ scenarioId, side, runIndex, status, reason, stepId, executionCode }) =>
    ({ scenarioId, side, runIndex, status, reason, stepId, executionCode })) });

async function fixture(t, commandReset = true) {
  const value = await buildWorkspace(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let count = 0; const actions = [];
  const api = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/reset') { count = 0; actions.push('reset'); response.end('{}'); }
    else { actions.push('read'); response.end(JSON.stringify({ count: ++count })); }
  });
  await new Promise(done => api.listen(0, '127.0.0.1', done)); t.after(() => close(api));
  const origin = `http://127.0.0.1:${api.address().port}`;
  for (const side of ['source', 'target']) {
    const html = `<!doctype html><button>${side === 'source' ? 'Save' : 'Commit'}</button><output>Ready</output><script src="/app.js"></script>`;
    const js = `document.querySelector('button').onclick=async()=>{const data=await fetch('${origin}/value').then(r=>r.json());document.querySelector('output').textContent=String(data.count);localStorage.setItem('ready','yes');};`;
    await write(value.root, `${side}/build.mjs`, `import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.html',${JSON.stringify(html)});writeFileSync('dist/app.js',${JSON.stringify(js)});`);
    await write(value.root, `${side}/reset.mjs`, `const response=await fetch('${origin}/reset');if(!response.ok)process.exit(2);`);
    value.config[side].relevantFiles.push('reset.mjs');
    value.config[side].commands.push({ id: 'reset', kind: 'reset', argv: [process.execPath, 'reset.mjs'], cwd: '.', timeoutMs: 2500 });
  }
  value.config.policy = { allowedOrigins: [origin], sanitization: { allowedPayloadKeys: ['count'] } };
  if (commandReset) value.config.reset = { kind: 'COMMANDS', sourceCommandId: 'reset', targetCommandId: 'reset' };
  const scenario = value.config.scenarios[0];
  scenario.definition.steps = [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save',
    completionSignal: { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'ready', timeoutMs: 2500 } }];
  scenario.bindings.source.entryUrl = `${value.config.source.baseUrl}/source-page`;
  scenario.bindings.target.entryUrl = `${value.config.target.baseUrl}/target-page`;
  scenario.bindings.target.steps = [{ stepId: 'save', targetRole: 'button', targetName: 'Commit' }];
  const second = structuredClone(scenario); second.definition.scenarioId = 'repeat';
  value.config.scenarios.push(second); value.config.limits.maxDurationMs = 45000;
  return { ...value, actions };
}
const run = (value, extra = {}) => captureProjectSuite({ config: value.config, workspaceRoot: value.root,
  artifactPath: 'results/run', allowProjectCommands: true, ...extra });
async function portsReleased(config) {
  for (const side of ['source', 'target']) { const server = await listen(Number(new URL(config[side].baseUrl).port)); await close(server); }
}

test('suite resets real backend before every bound scenario run and records build-linked sanitized evidence', async t => {
  const value = await fixture(t), report = await run(value);
  assert.equal(report.status, 'COMPLETED', diagnostics(report)); assert.equal(report.captures.length, 6);
  assert.deepEqual(value.actions, Array.from({ length: 6 }, () => ['reset', 'read']).flat());
  assert.ok(report.stability.every(item => item.result.observations.status === 'STABLE'));
  assert.equal(new Set(report.captures.map(item => item.traceRunId)).size, 6);
  for (const item of report.captures) {
    assert.equal(item.status, 'COMPLETED'); assert.equal(item.buildHash, report.builds[item.side].buildHash);
    assert.equal(item.buildRunId, report.builds[item.side].runId);
    const trace = JSON.parse(await readFile(join(value.root, 'results/run', item.evidencePath), 'utf8'));
    assert.ok(trace.sanitization); assert.equal(trace.runId, item.traceRunId);
    assert.ok(trace.events.some(event => event.type === 'HTTP_RESPONSE' && event.body?.count === 1));
  }
  const persisted = JSON.parse(await readFile(join(value.root, 'results/run/capture-suite.json'), 'utf8'));
  assert.deepEqual(persisted, report); assert.ok(!JSON.stringify(report).includes('Ready'));
  await portsReleased(value.config);
});

test('fresh browser contexts alone do not make a stateful source stable', async t => {
  const value = await fixture(t, false), report = await run(value);
  assert.equal(report.status, 'COMPLETED', diagnostics(report));
  assert.ok(report.stability.every(item => item.result.observations.status === 'UNSTABLE'));
  assert.equal(value.actions.filter(action => action === 'reset').length, 0);
  assert.ok(report.stability[0].result.unstableCodes.length > 0);
});

test('a failed reset prevents that capture but does not hide other scenarios', async t => {
  const value = await fixture(t); await write(value.root, 'target/reset.mjs', 'console.log("private-failure");process.exit(2);');
  const report = await run(value);
  assert.equal(report.status, 'INCONCLUSIVE'); assert.equal(report.captures.length, 6);
  assert.ok(report.captures.filter(item => item.side === 'target').every(item => item.reason === 'RESET_FAILED' && !item.evidencePath));
  assert.ok(report.captures.filter(item => item.side === 'source').every(item => item.status === 'COMPLETED'));
  assert.ok(!JSON.stringify(report).includes('private-failure')); await portsReleased(value.config);
});

test('scenario errors are retained, remaining scenarios run, and timeout records missing captures after cleanup', async t => {
  const value = await fixture(t, false);
  value.config.scenarios[0].definition.steps = [];
  value.config.scenarios[0].bindings.target.steps = [];
  value.config.scenarios[0].definition.completionSignal = { type: 'LOCATOR_VISIBLE', targetRole: 'button', targetName: 'Missing', timeoutMs: 100 };
  const report = await run(value);
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.ok(report.captures.filter(item => item.scenarioId === 'boot').every(item => item.reason === 'CAPTURE_FAILED'));
  assert.ok(report.captures.filter(item => item.scenarioId === 'repeat').every(item => item.status === 'COMPLETED'));
  value.config.scenarios[0].definition.completionSignal.timeoutMs = 30000;
  value.config.limits.maxDurationMs = 1500;
  const timeout = await run(value, { artifactPath: 'results/timeout' });
  assert.equal(timeout.status, 'INCONCLUSIVE'); assert.equal(timeout.failureCode, 'SESSION_TIMEOUT');
  assert.ok(timeout.captures.some(item => item.status === 'NOT_RUN')); await portsReleased(value.config);
  assert.deepEqual(JSON.parse(await readFile(join(value.root, 'results/timeout/capture-suite.json'), 'utf8')), timeout);
});

test('suite refuses reused/project-local output before builds and retains a build failure as inconclusive', async t => {
  const value = await fixture(t);
  await assert.rejects(run(value, { artifactPath: 'source/evidence' }), /UNSAFE_SUITE_OUTPUT/);
  await write(value.root, 'results/existing/keep', 'yes');
  await assert.rejects(run(value, { artifactPath: 'results/existing' }));
  await assert.rejects(readFile(join(value.root, 'source/dist/index.html')));
  await write(value.root, 'source/build.mjs', 'process.exit(2);');
  const report = await run(value);
  assert.equal(report.status, 'INCONCLUSIVE'); assert.equal(report.failureCode, 'BUILD_CHECK_FAILED');
  assert.ok(report.captures.every(item => item.status === 'NOT_RUN')); await portsReleased(value.config);
});

test('capture rejects a document without the expected build and cancels without closing a caller browser', async t => {
  const server = await listen(); t.after(() => close(server));
  const browser = await chromium.launch(); t.after(() => browser.close());
  const scenario = { scenarioId: 'identity', unitId: 'page', name: 'Identity', description: 'Synthetic',
    entryUrl: `http://127.0.0.1:${server.address().port}`, steps: [], preconditions: {}, testDataProfile: 'standard' };
  await assert.rejects(captureScenario(scenario, 0, { browser, expectedBuild: { origin: scenario.entryUrl, buildHash: 'a'.repeat(64) } }), /SERVED_BUILD_MISMATCH/);
  assert.equal(browser.contexts().length, 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(captureScenario({ ...scenario, completionSignal: { type: 'LOCATOR_VISIBLE', targetRole: 'button', targetName: 'Missing', timeoutMs: 30000 } }, 1, { browser, signal: controller.signal }));
  } finally { clearTimeout(timer); }
  assert.ok(browser.isConnected()); assert.equal(browser.contexts().length, 0);
});
