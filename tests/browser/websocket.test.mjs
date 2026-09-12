import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { captureScenario } from '../../packages/scenario-runner/dist/index.js';
import { sanitizeTrace } from '../../packages/trace-sanitizer/dist/index.js';
import { EquivalenceValidator } from '../../packages/equivalence-validator/dist/index.js';
import { trace, event, contract } from '../helpers.mjs';
import { webSocketFixture } from './websocket-fixture.mjs';

const base = (scenarioId, entryUrl) => ({ scenarioId, unitId: 'ws', name: scenarioId, description: '', entryUrl, preconditions: {}, testDataProfile: 'standard' });
const policy = { pseudonymizationKey: 'browser-test-key'.repeat(3), allowedPayloadKeys: ['hello', 'second', 'done', 'omitted', 'reason', 'byteLength'] };
const frames = t => t.events.filter(e => e.type === 'WEBSOCKET_FRAME');

test('scenario WebSocket opt-in records sent and received frames with correlation and interaction causality', { timeout: 60000 }, async () => {
  const fixture = await webSocketFixture();
  const browser = await chromium.launch();
  try {
    const scenario = {
      ...base('ws-live', `${fixture.url}/page-live`),
      steps: [{ stepId: 'send-second', action: 'click', targetRole: 'button', targetName: 'Send' }],
      completionSignal: { type: 'WEBSOCKET_FRAME', urlPattern: '**/live', direction: 'received', payloadShape: { second: 'number' }, timeoutMs: 15000 },
    };
    const captured = await captureScenario(scenario, 1, { browser, baseUrl: fixture.url });
    const ws = frames(captured);
    assert.deepEqual(ws.map(e => [e.direction, e.payload]), [
      ['sent', { hello: 'world', token: 'raw-secret' }],
      ['received', { hello: 'world', token: 'raw-secret' }],
      ['sent', { second: 2 }],
      ['received', { second: 2 }],
    ]);
    assert.equal(new Set(ws.map(e => e.url)).size, 1);
    assert.match(ws[0].url, /^ws:\/\/127\.0\.0\.1:\d+\/live$/);
    assert.equal(new Set(ws.map(e => e.correlationId)).size, 1, 'frames on one connection share a correlation id');
    const interaction = captured.events.find(e => e.type === 'USER_INTERACTION' && e.stepId === 'send-second');
    assert.deepEqual(ws[2].causedByEventIds, [interaction.eventId]);
    assert.ok(!ws[0].causedByEventIds, 'frames before any interaction carry no causal parent');
    assert.ok(fixture.connections.some(c => c.path === '/live' && c.frames.some(f => f.direction === 'in' && /second/.test(f.text ?? ''))));
    // Sanitizer treats frame payloads like HTTP payloads: default-deny, pseudonymized, URL-safe.
    const sanitized = sanitizeTrace(captured, { pseudonymizationKey: policy.pseudonymizationKey });
    const clean = frames(sanitized);
    assert.deepEqual(clean[0].payload, {}); // no allowed keys -> structural denial, values never survive raw
    assert.doesNotMatch(JSON.stringify(sanitized), /raw-secret|world/);
    // Identical runs are equivalent through the WebSocket comparator.
    assert.equal(new EquivalenceValidator().validate({ source: sanitizeTrace(captured, policy), target: sanitizeTrace(structuredClone(captured), policy), contract: contractFor('ws-live') }).divergences.filter(d => d.code.startsWith('WEBSOCKET_')).length, 0);
  } finally { await browser.close(); await fixture.close(); }
});

test('WebSocket frames honour size caps, binary omission and stop at the completion deadline', { timeout: 60000 }, async () => {
  const fixture = await webSocketFixture();
  const browser = await chromium.launch();
  try {
    const scenario = {
      ...base('ws-limits', `${fixture.url}/page-limits`),
      steps: [],
      completionSignal: { type: 'WEBSOCKET_FRAME', urlPattern: '**/limits', direction: 'received', payloadShape: { done: 'boolean' }, timeoutMs: 15000 },
    };
    const captured = await captureScenario(scenario, 1, { browser, baseUrl: fixture.url });
    const ws = frames(captured);
    // Every frame is captured on both sides with caps applied. (Message-level delivery order through the
    // routing proxy may interleave mixed-size messages, so this fixture asserts per-direction multisets;
    // strict within-connection ordering is asserted for small frames in the first test and the unit matrix.)
    const perDirection = direction => ws.filter(e => e.direction === direction).map(e => JSON.stringify(e.payload)).sort();
    assert.deepEqual(perDirection('sent'), perDirection('received'), 'echo server: sent and received content must mirror');
    const payloads = perDirection('sent');
    assert.equal(payloads.length, 3);
    assert.equal(payloads.filter(p => /FRAME_TOO_LARGE/.test(p) && /"byteLength":40000/.test(p)).length, 1, 'oversized text is capped, never stored raw');
    assert.equal(payloads.filter(p => /BINARY_FRAME/.test(p) && /"byteLength":3/.test(p)).length, 1, 'binary frames are described, never embedded');
    assert.equal(payloads.filter(p => /"done":true/.test(p)).length, 1);
    assert.equal(ws.filter(e => JSON.stringify(e.payload).includes('"late":true')).length, 0, 'the delayed server push must not be in the trace');
    assert.doesNotMatch(JSON.stringify(captured), /xxxxx|"late":true/, 'oversized content and post-deadline frames must not leak into the trace');
  } finally { await browser.close(); await fixture.close(); }
});

test('WebSockets stay blocked without an explicit scenario opt-in', { timeout: 60000 }, async () => {
  const fixture = await webSocketFixture();
  const browser = await chromium.launch();
  try {
    const scenario = {
      ...base('ws-blocked', `${fixture.url}/page-blocked`),
      steps: [],
      completionSignal: { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'blocked', timeoutMs: 10000 },
    };
    const captured = await captureScenario(scenario, 1, { browser, baseUrl: fixture.url });
    assert.deepEqual(frames(captured), []);
    assert.equal(captured.completion?.status, 'COMPLETED', 'the page only reaches its blocked marker; no socket ever opened');
    assert.deepEqual(fixture.connections.filter(c => c.path !== '/blank'), [], 'the application never reaches a WebSocket server while blocked');
  } finally { await browser.close(); await fixture.close(); }
});

function contractFor(scenarioId) {
  const approved = contract();
  approved.scenarios[0].scenarioId = scenarioId;
  return approved;
}

// Static trace-level guards that need the browser stack are kept here; pure-matrix checks live in tests/websocket.test.mjs.
test('recorder completion refuses a shape-mismatched frame with a timeout', { timeout: 60000 }, async () => {
  const fixture = await webSocketFixture();
  const browser = await chromium.launch();
  try {
    const scenario = {
      ...base('ws-timeout', `${fixture.url}/page-live`),
      steps: [],
      completionSignal: { type: 'WEBSOCKET_FRAME', urlPattern: '**/live', direction: 'received', payloadShape: { never: 'string' }, timeoutMs: 500 },
    };
    await assert.rejects(captureScenario(scenario, 1, { browser, baseUrl: fixture.url }), /Timed out waiting for a matching WebSocket frame/);
    // Even though the run failed, the frames that were recorded honour the same strict envelope after sanitization.
    const t = event(trace(), 'WEBSOCKET_FRAME', { url: 'ws://app.test/live', direction: 'sent', payload: { hello: 'world' }, correlationId: 'conn-1' });
    const { sanitization, ...rawOnly } = structuredClone(t);
    assert.equal(frames(sanitizeTrace(rawOnly, policy)).length, 1);
    assert.equal(new EquivalenceValidator().validate({ source: trace(), target: t }).divergences.some(d => d.code === 'WEBSOCKET_FRAME_UNEXPECTED'), true);
    assert.equal(new EquivalenceValidator().validate({ source: t, target: trace() }).divergences.some(d => d.code === 'WEBSOCKET_FRAME_MISSING'), true);
    assert.equal(new EquivalenceValidator().validate({ source: t, target: structuredClone(t) }).status, 'EQUIVALENT');
  } finally { await browser.close(); await fixture.close(); }
});
