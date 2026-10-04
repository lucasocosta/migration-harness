import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario, parseSanitizedTrace, urlPatternMatches, matchesDeclaredShape, valueShape } from '../packages/core/dist/index.js';
import { sanitizeTrace, projectTraceForLlm } from '../packages/core/dist/trace-sanitizer/index.js';
import { EquivalenceValidator, parseValidationPolicy } from '../packages/engine/dist/equivalence/index.js';
import { trace, event } from './helpers.mjs';

const scenario = signal => ({ scenarioId: 'ws', unitId: 'unit', name: 'ws', description: '', entryUrl: 'http://app.test/', preconditions: {}, steps: [], testDataProfile: 'standard', ...signal ? { completionSignal: signal } : {} });
const wsSignal = extra => ({ type: 'WEBSOCKET_FRAME', urlPattern: '**/live', direction: 'received', payloadShape: { hello: 'string' }, timeoutMs: 5000, ...extra });
const key = 'x'.repeat(40);
const frame = (t, direction, payload, overrides = {}) => event(t, 'WEBSOCKET_FRAME', { url: 'ws://app.test/live', direction, payload, correlationId: 'conn-a', ...overrides });
const rawTrace = () => { const { sanitization, ...rest } = trace(); return rest; };
const validator = new EquivalenceValidator();

test('scenario schema accepts WEBSOCKET_FRAME signals and refuses malformed or unknown structures', () => {
  assert.equal(parseScenario(scenario(wsSignal())).completionSignal.type, 'WEBSOCKET_FRAME');
  assert.equal(parseScenario(scenario(wsSignal({ payloadShape: {} }))).completionSignal.payloadShape.hello, undefined);
  assert.deepEqual(parseScenario(scenario(wsSignal({ payloadShape: { meta: { level: 'number' }, tags: 'array', any: 'any' } }))).completionSignal.payloadShape.meta.level, 'number');
  for (const bad of [
    wsSignal({ direction: 'both' }),
    wsSignal({ extra: true }),
    wsSignal({ payloadShape: { hello: 'uuid' } }),
    { ...wsSignal(), timeoutMs: 0 },
    { ...wsSignal(), urlPattern: '' },
    wsSignal({ payloadShape: ['string'] }),
  ]) assert.throws(() => parseScenario(scenario(bad)), 'expected refusal for ' + JSON.stringify(bad));
  assert.throws(() => parseScenario({ ...scenario(wsSignal()), webSocketUrl: 'ws://x' }), /Unrecognized|webSocketUrl/);
});

test('trace schema accepts the eighth event additively and keeps strictness', () => {
  const t = frame(trace(), 'sent', { hello: 'world', count: 2 });
  const parsed = parseSanitizedTrace(structuredClone(t));
  assert.deepEqual(parsed.events.at(-1), { eventId: 'event-3', timestampMs: 3, sequenceIndex: 3, type: 'WEBSOCKET_FRAME', url: 'ws://app.test/live', direction: 'sent', payload: { hello: 'world', count: 2 }, correlationId: 'conn-a' });
  parseSanitizedTrace(frame(trace(), 'received', 'plain text frame'));
  parseSanitizedTrace(frame(trace(), 'received', { omitted: true, reason: 'BINARY_FRAME', byteLength: 3 }));
  const missingUrl = frame(trace(), 'sent', {}); delete missingUrl.events.at(-1).url;
  const smuggled = frame(trace(), 'sent', {}); smuggled.events.at(-1).origin = 'x';
  const ghostCause = frame(trace(), 'sent', {}); ghostCause.events.at(-1).causedByEventIds = ['ghost'];
  const outOfOrder = frame(trace(), 'sent', {}); outOfOrder.events.at(-1).sequenceIndex = 0;
  for (const bad of [frame(trace(), 'sideways', {}), missingUrl, smuggled, ghostCause, outOfOrder])
    assert.throws(() => parseSanitizedTrace(structuredClone(bad)), 'expected a strict refusal');
});

test('url pattern globbing and declared shape matching are exact and structural', () => {
  assert.equal(urlPatternMatches('**/live', 'ws://127.0.0.1:80/live'), true);
  assert.equal(urlPatternMatches('ws://127.0.0.1:80/live', 'ws://127.0.0.1:80/live'), true);
  assert.equal(urlPatternMatches('ws://127.0.0.1:80/live', 'ws://127.0.0.1:80/other'), false);
  assert.equal(urlPatternMatches('ws://host/a*b', 'ws://host/axxb'), true);
  assert.equal(urlPatternMatches('ws://host/a*b', 'ws://host/ax/yb'), false);
  assert.equal(matchesDeclaredShape({ hello: 'string' }, valueShape({ hello: 'world', extra: 1 })), true);
  assert.equal(matchesDeclaredShape({ hello: 'string' }, valueShape({ hello: 5 })), false);
  assert.equal(matchesDeclaredShape({ nested: { level: 'number' } }, valueShape({ nested: { level: 1 } })), true);
  assert.equal(matchesDeclaredShape({ tags: 'array' }, valueShape({ tags: ['a'] })), true);
  assert.equal(matchesDeclaredShape({ any: 'any' }, valueShape({ any: { deep: true } })), true);
  assert.equal(matchesDeclaredShape({}, valueShape('plain string')), false);
  assert.equal(matchesDeclaredShape({}, valueShape({ anything: 1 })), true);
});

test('sanitizer applies default-deny payload policy, scrubs PII and redacts connection query strings', () => {
  const t = frame(rawTrace(), 'sent', { email: 'josé@example.test', token: 'secret-token', message: 'raw runtime string', count: 7, nested: { api_key: 'x', ok: 'y' } });
  t.events.at(-1).url = 'ws://app.test/live?room=main&authorization=Bearer%20zzz';
  const sanitized = sanitizeTrace(structuredClone(t), { pseudonymizationKey: key });
  const clean = sanitized.events.at(-1);
  assert.deepEqual(clean.payload, {}, 'default-deny: no policy means no payload fields survive');
  assert.ok(sanitized.sanitization.redactionsCount >= 4);
  assert.doesNotMatch(JSON.stringify(sanitized), /josé|secret-token|raw runtime string|Bearer|zzz|api_key/);
  assert.ok(clean.url.includes('room') && !/authorization/.test(clean.url), 'query stripping applies to the connection URL');
  const allowed = sanitizeTrace(structuredClone(t), { pseudonymizationKey: key, allowedPayloadKeys: ['message', 'count', 'piiProbe'] });
  const piiSource = structuredClone(t);
  piiSource.events.at(-1).payload = { piiProbe: 'contact person@example.test now', email: 'josé@example.test' };
  const revealed = sanitizeTrace(piiSource, { pseudonymizationKey: key, allowedPayloadKeys: ['piiProbe'] }).events.at(-1);
  assert.deepEqual(Object.keys(revealed.payload), ['piiProbe']);
  assert.match(revealed.payload.piiProbe, /^contact p_[a-f0-9]{24} now$/, 'PII inside allowed values is pseudonymized, never kept raw');
  assert.deepEqual(Object.keys(allowed.events.at(-1).payload).sort(), ['count', 'message']);
  // Adversarial structural payloads stay inside the deny wall.
  const hostile = frame(rawTrace(), 'received', JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"nested":[{"email":"a@b.test"}]}'));
  assert.doesNotMatch(JSON.stringify(sanitizeTrace(structuredClone(hostile), { pseudonymizationKey: key })), /polluted|a@b\.test/);
  assert.equal({}.polluted, undefined);
});

test('LLM projection of WebSocket frames is structure-only: no runtime strings, pseudonyms or URLs', () => {
  const t = frame(rawTrace(), 'received', { hello: 'world', count: 2, nested: { secret: 'text', list: ['verbatim'] } });
  const projected = projectTraceForLlm(sanitizeTrace(structuredClone(t), { pseudonymizationKey: key, allowedPayloadKeys: ['hello', 'count', 'nested'] }));
  const ws = projected.events.find(e => e.type === 'WEBSOCKET_FRAME');
  assert.deepEqual(Object.keys(ws).sort(), ['direction', 'frameTypes', 'type']);
  assert.deepEqual(ws.frameTypes, ['number', 'string'], 'leaf type names only — default-deny already removed non-allowed nested keys');
  assert.doesNotMatch(JSON.stringify(projected), /world|verbatim|p_[a-f0-9]{8}|app\.test|secret|hello/i);
});

test('equivalence compares frame streams per connection with strict within-connection order', () => {
  const mk = build => { const t = trace(); build(t); return t; };
  const source = mk(t => { frame(t, 'sent', { hello: 'world' }); frame(t, 'received', { hello: 'world', ack: true }); });
  assert.equal(validator.validate({ source, target: structuredClone(source) }).divergences.filter(d => d.code.startsWith('WEBSOCKET_')).length, 0);
  assert.equal(validator.validate({ source, target: structuredClone(source) }).status, 'EQUIVALENT');
  const directionFlip = mk(t => { frame(t, 'received', { hello: 'world' }); frame(t, 'sent', { hello: 'world', ack: true }); });
  assert.ok(validator.validate({ source, target: directionFlip }).divergences.some(d => d.code === 'WEBSOCKET_DIRECTION_MISMATCH' && d.severity === 'BLOCKING' && d.dimension === 'NETWORK'));
  const shapeChange = mk(t => { frame(t, 'sent', { hello: 1 }); frame(t, 'received', { hello: 'world', ack: true }); });
  assert.ok(validator.validate({ source, target: shapeChange }).divergences.some(d => d.code === 'WEBSOCKET_PAYLOAD_SHAPE_MISMATCH'));
  const missing = mk(t => { frame(t, 'sent', { hello: 'world' }); });
  assert.ok(validator.validate({ source, target: missing }).divergences.some(d => d.code === 'WEBSOCKET_FRAME_MISSING'));
  const extra = structuredClone(source); frame(extra, 'received', { unsolicited: true });
  assert.ok(validator.validate({ source, target: extra }).divergences.some(d => d.code === 'WEBSOCKET_FRAME_UNEXPECTED'));
  // Reordering within one connection is meaningful: an ordered protocol conversation cannot swap.
  const reordered = mk(t => { frame(t, 'received', { hello: 'world', ack: true }); frame(t, 'sent', { hello: 'world' }); });
  assert.equal(validator.validate({ source, target: reordered }).divergences.some(d => d.severity === 'BLOCKING'), true);
  // Different connections group by URL; volatile fields apply per declared policy.
  const withVolatile = mk(t => { frame(t, 'sent', { hello: 'world', seq: 1 }); });
  const shifted = mk(t => { frame(t, 'sent', { hello: 'world', seq: '99' }); });
  assert.equal(validator.validate({ source: withVolatile, target: shifted }).divergences.some(d => d.code === 'WEBSOCKET_PAYLOAD_SHAPE_MISMATCH'), true);
  assert.equal(validator.validate({ source: withVolatile, target: shifted, policy: parseValidationPolicy({ websockets: { volatileWebSocketFields: ['seq'] } }) }).divergences.filter(d => d.code.startsWith('WEBSOCKET_')).length, 0);
  const singleLive = mk(t => { frame(t, 'sent', { hello: 'world' }); });
  const secondConnection = mk(t => { frame(t, 'sent', { hello: 'world' }); frame(t, 'sent', { ping: 1 }, { url: 'ws://app.test/presence', correlationId: 'conn-b' }); });
  const split = validator.validate({ source: singleLive, target: secondConnection });
  assert.ok(split.divergences.some(d => d.code === 'WEBSOCKET_FRAME_UNEXPECTED' && d.message.includes('/presence')));
  assert.equal(split.divergences.filter(d => d.code.startsWith('WEBSOCKET_') && !d.message.includes('/presence')).length, 0, 'frames pair per connection URL, not across connections');
});

test('WebSocket divergences gate releases as blocking network-family evidence', () => {
  const source = frame(trace(), 'sent', { hello: 'world' });
  const target = frame(trace(), 'sent', { hello: 12 });
  const result = validator.validate({ source, target });
  const ws = result.divergences.find(d => d.code === 'WEBSOCKET_PAYLOAD_SHAPE_MISMATCH');
  assert.equal(result.status, 'NOT_EQUIVALENT');
});
