import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { captureScenario } from '../../packages/scenario-runner/dist/index.js';
import { sanitizeTrace } from '../../packages/trace-sanitizer/dist/index.js';
import { EquivalenceValidator } from '../../packages/equivalence-validator/dist/index.js';
import { serviceWorkerFixture } from './serviceworker-fixture.mjs';

const policy = { pseudonymizationKey: 'browser-test-key'.repeat(3), allowedPayloadKeys: ['value'], allowedStorageKeys: ['sw-controlled', 'sw-uncontrolled', 'data-loaded'] };
const scenario = (scenarioId, extra) => ({
  scenarioId, unitId: 'sw', name: scenarioId, description: '', entryUrl: '/app', preconditions: {}, testDataProfile: 'standard',
  steps: [{ stepId: 'fetch-data', action: 'click', targetRole: 'button', targetName: 'Fetch', completionSignal: { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'data-loaded', timeoutMs: 20000 } }],
  ...extra,
});
const storageKeys = captured => captured.events.filter(e => e.type === 'STORAGE_DELTA' && e.mutationType === 'SET').map(e => e.key);
const apiResponses = captured => captured.events.filter(e => e.type === 'HTTP_RESPONSE' && e.url.endsWith('/api/data'));

test('service workers stay blocked without an explicit scenario opt-in', { timeout: 60000 }, async () => {
  const fixture = await serviceWorkerFixture();
  const browser = await chromium.launch();
  try {
    const captured = await captureScenario(scenario('sw-default-block', { entryUrl: `${fixture.url}/app` }), 1, { browser, baseUrl: fixture.url });
    assert.equal(captured.completion?.status, 'COMPLETED');
    assert.ok(storageKeys(captured).includes('sw-uncontrolled'), 'the page never gains a controller');
    assert.ok(!storageKeys(captured).includes('sw-controlled'));
    assert.equal(apiResponses(captured).length, 1, 'the application fetch is still observed normally');
    assert.ok(apiResponses(captured).every(e => e.servedByServiceWorker === undefined), 'blocked traces stay byte-identical to pre-SW behavior');
    assert.ok(!fixture.requests.includes('/sw.js'), 'registration is blocked before the worker script is ever fetched');
  } finally { await browser.close(); await fixture.close(); }
});

test('serviceWorkers allow lets a worker register, marks its passthrough responses as SW-served, and identical runs stay EQUIVALENT', { timeout: 60000 }, async () => {
  const fixture = await serviceWorkerFixture();
  const browser = await chromium.launch();
  try {
    const definition = scenario('sw-opt-in', { entryUrl: `${fixture.url}/app`, serviceWorkers: 'allow' });
    const first = await captureScenario(definition, 1, { browser, baseUrl: fixture.url });
    assert.equal(first.completion?.status, 'COMPLETED');
    assert.ok(fixture.requests.includes('/sw.js'), 'the opted-in worker script is really fetched');
    assert.ok(storageKeys(first).includes('sw-controlled'), 'the worker claims the page');
    const served = apiResponses(first);
    assert.equal(served.length, 1, 'the SW passthrough must not double-record the exchange: only the page-level request is trace evidence');
    assert.equal(served[0].servedByServiceWorker, true, 'a fetch routed through the opted-in worker is marked SW-served');
    assert.equal(served[0].statusCode, 200, 'network shape is unchanged by the detour through the worker');
    // Two runs of the same scenario on identical apps must be EQUIVALENT: the SW evidence field never enters any comparison.
    const second = await captureScenario(definition, 2, { browser, baseUrl: fixture.url });
    assert.equal(apiResponses(second).at(-1).servedByServiceWorker, true, 'a fresh context registers the worker again');
    const result = new EquivalenceValidator().validate({ source: sanitizeTrace(first, policy), target: sanitizeTrace(second, policy) });
    assert.deepEqual(result.divergences, [], 'no dimension may observe the servedByServiceWorker difference-carrying shape');
    assert.equal(result.status, 'EQUIVALENT');
  } finally { await browser.close(); await fixture.close(); }
});
