import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { captureScenario, ScenarioRunner } from '../../packages/scenario-runner/dist/index.js';
import { TemporalTraceRecorder } from '../../packages/trace-recorder/dist/index.js';
import { checkAccessibility } from '../../packages/quality-gates/dist/index.js';
import { canCreateSymlink } from '../helpers/privacy.mjs';

async function server() {
  const instance = createServer((req, res) => {
    if (req.url === '/api/error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":true}'); return; }
    if (req.url === '/api/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('binary'); return; }
    if (req.url === '/api/large') { const body = JSON.stringify({ text: 'x'.repeat(1000) }); res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body); return; }
    if (req.url === '/api/fail') { req.socket.destroy(); return; }
    if (req.url === '/api/hang') return;
    if (req.url === '/api/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"done":true}'); }, 100); return; }
    if (req.url === '/api/fast') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><button id="go">Go</button><button id="next">Next</button><script>window.initial=localStorage.getItem("seed");document.querySelector("#go").onclick=()=>fetch("/api/fast");document.querySelector("#next").onclick=()=>{localStorage.setItem("seed","changed");location.href="/next"}</script></body></html>');
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${instance.address().port}`, close: () => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }) };
}

test('recorder drains delayed responses, distinguishes HTTP 500 and transport failures, caps bodies', { timeout: 30000 }, async () => {
  const fixture = await server(), browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto(fixture.url);
    const recorder = new TemporalTraceRecorder(page, { maxResponseBodyBytes: 100 }); recorder.start();
    await page.evaluate(async () => { await Promise.all(['/api/error', '/api/binary', '/api/large', '/api/fail'].map(path => fetch(path).then(response => response.text()).catch(() => undefined))); });
    await page.evaluate(() => { void fetch('/api/slow'); });
    const trace = await recorder.finish('recording', 1);
    assert.ok(trace.events.some(e => e.type === 'HTTP_RESPONSE' && e.statusCode === 500));
    assert.ok(trace.events.some(e => e.type === 'HTTP_FAILED' && e.url.endsWith('/api/fail')));
    assert.equal(trace.events.find(e => e.type === 'HTTP_RESPONSE' && e.url.endsWith('/api/large')).body.reason, 'BODY_TOO_LARGE');
    assert.equal(trace.events.find(e => e.type === 'HTTP_RESPONSE' && e.url.endsWith('/api/binary')).body.reason, 'CONTENT_TYPE_NOT_ALLOWED');
    assert.ok(trace.events.some(e => e.type === 'HTTP_RESPONSE' && e.url.endsWith('/api/slow')));
    assert.equal(page.listenerCount('request'), 0); assert.equal(page.listenerCount('requestfinished'), 0);
    const hanging = new TemporalTraceRecorder(page, { drainTimeoutMs: 50 }); hanging.start();
    await page.evaluate(() => { void fetch('/api/hang'); });
    await assert.rejects(hanging.finish('hanging', 1), /Timed out/);
    assert.equal(page.listenerCount('request'), 0);
  } finally { await browser.close(); await fixture.close(); }
});
test('global response observers precede actions; storage initialization survives navigation', { timeout: 30000 }, async () => {
  const fixture = await server(), browser = await chromium.launch();
  const scenario = { scenarioId: 'fast', unitId: 'test', name: 'Fast', description: '', entryUrl: fixture.url, preconditions: {}, testDataProfile: 'standard', steps: [{ stepId: 'go', action: 'click', targetRole: 'button', targetName: 'Go' }], completionSignal: { type: 'RESPONSE_RECEIVED', responseUrlPattern: '/api/fast', responseMethod: 'GET', timeoutMs: 1000 } };
  try {
    const trace = await captureScenario(scenario, 1, { browser });
    assert.ok(trace.events.some(e => e.type === 'HTTP_RESPONSE'));
    const context = await browser.newContext(), page = await context.newPage();
    const runner = new ScenarioRunner(page);
    const navigation = { ...scenario, preconditions: { storageInitialState: { local: { seed: 'original' } } }, steps: [{ stepId: 'next', action: 'click', targetRole: 'button', targetName: 'Next' }], completionSignal: { type: 'LOCATOR_VISIBLE', targetRole: 'button', targetName: 'Go', timeoutMs: 1000 } };
    const navigated = await runner.run(navigation, 1);
    assert.equal(await page.evaluate(() => window.initial), 'changed');
    assert.ok(navigated.events.some(e => e.type === 'NAVIGATION' && e.toUrl.endsWith('/next')));
    await assert.rejects(runner.run(navigation, 2), /fresh/); await context.close();
  } finally { await browser.close(); await fixture.close(); }
});

test('mock fixtures cannot escape their root or bypass the network origin boundary', { timeout: 30000 }, async (t) => {
  const fixture = await server(), browser = await chromium.launch(), root = await mkdtemp(join(tmpdir(), 'harness-mocks-'));
  const scenario = { scenarioId: 'mocks', unitId: 'test', name: 'Mocks', description: '', entryUrl: `${fixture.url}/probe`, preconditions: {}, testDataProfile: 'standard', steps: [], completionSignal: { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'result', timeoutMs: 1000 } };
  await writeFile(join(root, 'allowed.json'), '{}');
  const canLink = await canCreateSymlink();
  const outside = join(tmpdir(), `outside-${Date.now()}.json`); await writeFile(outside, 'private');
  if (canLink) await symlink(outside, join(root, 'link.json'));
  try {
    for (const fixturePath of [outside, ...(canLink ? ['link.json'] : [])]) {
      const input = { ...scenario, preconditions: { mockInitialApiResponses: [{ urlPattern: '**/api/fast', method: 'GET', statusCode: 200, fixturePath }] } };
      await assert.rejects(captureScenario(input, 1, { browser, fixtureBaseDir: root }), /escapes/);
    }
    if (!canLink) t.diagnostic('symlink unavailable; link.json escape case skipped');
    const context = await browser.newContext(), page = await context.newPage();
    await page.route(scenario.entryUrl, route => route.fulfill({ contentType: 'text/html', body: '<html><body><button>Go</button><script>fetch("https://blocked.test/api").then(()=>localStorage.setItem("result","leaked")).catch(()=>localStorage.setItem("result","blocked"))</script></body></html>' }));
    const input = { ...scenario, preconditions: { mockInitialApiResponses: [{ urlPattern: 'https://blocked.test/api', method: 'GET', statusCode: 200, fixturePath: 'allowed.json' }] } };
    await new ScenarioRunner(page, { fixtureBaseDir: root, allowedOrigins: [fixture.url] }).run(input, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('result')), 'blocked'); await context.close();
  } finally { await browser.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { force: true }); }
});

test('axe accessibility adapter reports violations without claiming complete conformance', { timeout: 30000 }, async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.setContent('<html lang="en"><head><title>Fixture</title></head><body><main><button></button></main></body></html>');
    const report = await checkAccessibility(page);
    assert.equal(report.passed, false); assert.ok(report.violations.some(v => v.id === 'button-name')); assert.equal(report.manualReviewRequired, true);
    await context.close();
  } finally { await browser.close(); }
});
