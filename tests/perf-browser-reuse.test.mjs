import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { captureScenario, launchBrowser, preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';
import { migrationComparisonPolicy, verifySourceStability } from '../packages/engine/dist/equivalence/index.js';
import { sanitizeTrace } from '../packages/core/dist/trace-sanitizer/index.js';

/**
 * Safety net for browser-process reuse inside one operation (docs/PLAN-V2.md §4, lever 2), plus the
 * §9.1 alarm signal "tests that pass in isolation and fail depending on order/pooling".
 *
 * The contract under test: one `Browser` may be shared by every capture of an operation, but each
 * capture opens a fresh `BrowserContext` — cookies, localStorage, listeners and mocks of one
 * scenario, side or run may never reach the next capture. The fixture reports what the page
 * actually sent back to the server, so a leaked value is observable even when the trace is scrubbed.
 *
 * Coverage: scenario→scenario contamination, source↔target isolation (same origin — the strongest
 * case, no origin separation to fall back on), consecutive runs, shared vs dedicated process, and
 * order independence.
 */

let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }
const withoutChromium = t => {
  if (!chromiumIssue) return false;
  t.skip(`Chromium unavailable: ${chromiumIssue}`);
  return true;
};

const PAGE = `<!doctype html><html lang="en"><head><title>Echo fixture</title></head><body>
<button>Save</button><div role="status">idle</div>
<script>
// NB: no \`var status\` — that is window.status, whose setter coerces to a string.
var indicator = document.querySelector('[role="status"]');
function probe() {
  return fetch('/probe?leak=' + encodeURIComponent(localStorage.getItem('leak') || 'none')).then(function (r) { return r.json(); });
}
probe().then(function () { indicator.textContent = 'ready'; });
document.querySelector('button').onclick = function () {
  localStorage.setItem('leak', '1');
  document.cookie = 'leak=1';
  probe().then(function () { indicator.textContent = 'saved'; });
};
</script></body></html>`;

/** Echo server: `/probe` records exactly what the captured page could see of its own context. */
async function echoFixture(t) {
  const captures = [];
  let current;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://echo.test');
    if (url.pathname === '/probe') {
      current?.probes.push({ leak: url.searchParams.get('leak') ?? 'none', cookie: request.headers.cookie ?? '' });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.close(() => done()); server.closeAllConnections(); }));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Label the probes the next capture sends, so each capture's view of the state stays separable. */
    mark: label => { current = { label, probes: [] }; captures.push(current); return current; },
  };
}

const checkScenario = url => ({
  scenarioId: 'echo-check', unitId: 'echo', name: 'Check', description: 'Reads storage and cookie without writing',
  entryUrl: `${url}/`, preconditions: {}, testDataProfile: 'standard', steps: [],
  completionSignal: { type: 'RESPONSE_RECEIVED', responseUrlPattern: '/probe', responseMethod: 'GET', timeoutMs: 5000 },
});

const seedScenario = url => ({
  scenarioId: 'echo-seed', unitId: 'echo', name: 'Seed', description: 'Writes storage and a cookie',
  entryUrl: `${url}/`, preconditions: {}, testDataProfile: 'standard',
  steps: [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save',
    completionSignal: { type: 'LOCATOR_VISIBLE', targetRole: 'status', text: 'saved', timeoutMs: 5000 } }],
});

const policy = migrationComparisonPolicy({});
const sanitize = raw => sanitizeTrace(raw, { pseudonymizationKey: 'k'.repeat(40),
  allowedPayloadKeys: ['ok'], allowedStorageKeys: ['leak'], sensitiveKeys: [] });
const assertStable = (left, right, label) => {
  const stability = verifySourceStability({ runs: [sanitize(left), sanitize(right)], requiredRuns: 2,
    reset: { kind: 'ISOLATED_FIXTURES' }, policy });
  assert.equal(stability.observations.status, 'STABLE', `${label}: ${JSON.stringify(stability)}`);
};
const CLEAN = [{ leak: 'none', cookie: '' }];

test('a shared browser keeps one scenario\'s storage and cookie out of the next capture', async t => {
  if (withoutChromium(t)) return;
  const fixture = await echoFixture(t);
  const browser = await launchBrowser(); t.after(() => browser.close());

  const seed = fixture.mark('seed');
  await captureScenario(seedScenario(fixture.url), 1, { browser });
  assert.equal(browser.contexts().length, 0, 'the seeding capture closes its context before returning');
  const check = fixture.mark('check');
  await captureScenario(checkScenario(fixture.url), 1, { browser });
  assert.equal(browser.contexts().length, 0, 'the following capture closes its own context too');

  // The seeding capture really wrote both values, so the assertion below is sensitive to a leak.
  assert.ok(seed.probes.some(probe => probe.leak === '1' && probe.cookie.includes('leak=1')),
    `the seeding capture must observe its own writes: ${JSON.stringify(seed.probes)}`);
  assert.deepEqual(check.probes, CLEAN, 'the next scenario starts from clean storage and no cookie');
});

test('source captures never leak into target captures (nor the reverse) in one shared browser', async t => {
  if (withoutChromium(t)) return;
  const fixture = await echoFixture(t);
  const browser = await launchBrowser(); t.after(() => browser.close());

  // Same origin for both sides: without origin separation, only the per-capture context can isolate.
  const sourceSeed = fixture.mark('source-seed');
  await captureScenario(seedScenario(fixture.url), 0, { browser });
  const targetCheck = fixture.mark('target-check');
  await captureScenario(checkScenario(fixture.url), 0, { browser });
  assert.ok(sourceSeed.probes.some(probe => probe.leak === '1'), `source wrote state: ${JSON.stringify(sourceSeed.probes)}`);
  assert.deepEqual(targetCheck.probes, CLEAN, 'target starts clean after a source capture');

  const targetSeed = fixture.mark('target-seed');
  await captureScenario(seedScenario(fixture.url), 1, { browser });
  const sourceCheck = fixture.mark('source-check');
  await captureScenario(checkScenario(fixture.url), 1, { browser });
  assert.ok(targetSeed.probes.some(probe => probe.leak === '1'), `target wrote state: ${JSON.stringify(targetSeed.probes)}`);
  assert.deepEqual(sourceCheck.probes, CLEAN, 'source starts clean after a target capture');
});

test('consecutive runs in one shared browser observe identical state (run 2 ≡ run 1)', async t => {
  if (withoutChromium(t)) return;
  const fixture = await echoFixture(t);
  const browser = await launchBrowser(); t.after(() => browser.close());

  // State exists in the operation (a seeding capture ran); it must not reach either check run.
  await captureScenario(seedScenario(fixture.url), 1, { browser });
  const first = fixture.mark('run-1');
  const run1 = await captureScenario(checkScenario(fixture.url), 1, { browser });
  const second = fixture.mark('run-2');
  const run2 = await captureScenario(checkScenario(fixture.url), 2, { browser });

  assert.deepEqual(first.probes, CLEAN);
  assert.deepEqual(second.probes, first.probes, 'run 2 observes exactly what run 1 observed');
  assert.notEqual(run1.runId, run2.runId, 'distinct executions, not a replayed trace');
  assert.deepEqual(run1.completion, run2.completion);
  assertStable(run1, run2, 'consecutive runs must be STABLE');
});

test('shared and dedicated browser processes produce the same observations', async t => {
  if (withoutChromium(t)) return;
  const fixture = await echoFixture(t);

  const shared = await launchBrowser();
  const sharedCapture = fixture.mark('shared');
  const viaShared = await captureScenario(checkScenario(fixture.url), 1, { browser: shared });
  assert.equal(shared.contexts().length, 0, 'a shared browser still closes the per-capture context');
  await shared.close();

  const dedicatedCapture = fixture.mark('dedicated');
  // No `browser` given: this capture launches and closes its own process (the pre-reuse behaviour).
  const viaDedicated = await captureScenario(checkScenario(fixture.url), 2, {});

  assert.deepEqual(sharedCapture.probes, CLEAN);
  assert.deepEqual(dedicatedCapture.probes, sharedCapture.probes, 'same observations for both lifecycles');
  assert.deepEqual(viaShared.completion, viaDedicated.completion);
  assertStable(viaShared, viaDedicated, 'shared vs dedicated execution must be STABLE');
});

test('the observation does not depend on the order scenarios ran in (§9.1 order/pooling signal)', async t => {
  if (withoutChromium(t)) return;
  const fixture = await echoFixture(t);

  // Order A: a state-writing scenario ran first in the same browser process.
  const first = await launchBrowser();
  await captureScenario(seedScenario(fixture.url), 1, { browser: first });
  const checkAfterSeed = fixture.mark('check-after-seed');
  const runAfterSeed = await captureScenario(checkScenario(fixture.url), 1, { browser: first });
  await first.close();

  // Order B: the observing scenario runs first, in its own process.
  const second = await launchBrowser();
  const checkFirst = fixture.mark('check-first');
  const runFirst = await captureScenario(checkScenario(fixture.url), 1, { browser: second });
  await second.close();

  assert.deepEqual(checkAfterSeed.probes, CLEAN, 'the observation after a seeding scenario stays clean');
  assert.deepEqual(checkFirst.probes, CLEAN, 'the same observation without a predecessor stays clean');
  assert.deepEqual(checkAfterSeed.probes, checkFirst.probes, 'order must not change what the capture observes');
  assertStable(runAfterSeed, runFirst, 'both orders must be STABLE');
});
