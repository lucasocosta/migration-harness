import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeNoiseSuggestions, verifySourceStability, migrationComparisonPolicy,
} from '../packages/engine/dist/equivalence/index.js';
import { parseSuggestionReport, HarnessPolicySchema, MigrationConfigSchema } from '../packages/core/dist/index.js';
import { event } from './helpers.mjs';

const reset = { kind: 'ISOLATED_FIXTURES' };

function trace(options = {}) {
  const { write = { name: 'ANA' }, runIndex = 1, updatedAt = '2026-01-01' } = options;
  const value = {
    scenarioId: 'update-customer', runIndex, startedAt: '2026-09-05T00:00:00.000Z',
    environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' },
    sanitization: { version: 'test', appliedAt: '2026-09-05T00:00:01.000Z', redactionsCount: 0 },
    events: [],
  };
  event(value, 'USER_INTERACTION', { stepId: 'save', action: 'click', targetAriaRole: 'button', targetAriaName: 'Salvar' });
  event(value, 'HTTP_REQUEST', {
    correlationId: 'w1', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {},
    payload: { ...write, updatedAt },
  });
  event(value, 'HTTP_RESPONSE', {
    correlationId: 'w1', method: 'PUT', url: 'https://app.test/api/customers/123', headers: {},
    statusCode: 204, body: null, requestToResponseEndMs: 1,
  });
  return value;
}

test('noise suggestions rank fields and propose policy snippets without applying them', () => {
  const policy = migrationComparisonPolicy({});
  const runs = [
    trace({ runIndex: 1, updatedAt: 't1' }),
    trace({ runIndex: 2, updatedAt: 't2' }),
    trace({ runIndex: 3, updatedAt: 't3' }),
  ];
  const stability = verifySourceStability({ runs, requiredRuns: 3, reset, policy });
  assert.equal(stability.observations.status, 'UNSTABLE');
  assert.ok(stability.suggestions, 'suggestions attached');
  const report = parseSuggestionReport(stability.suggestions);
  assert.equal(report.authority, 'HINT_ONLY');
  assert.ok(report.suggestions.length >= 1);
  const update = report.suggestions.find(item => item.target.fieldPath === 'payload.updatedAt');
  assert.ok(update, 'updatedAt ranked');
  assert.equal(update.status, 'PROPOSED');
  assert.equal(update.kind, 'NOISE_PROPOSAL');
  assert.equal(update.policySnippet.kind, 'volatilePayloadFields');
  assert.deepEqual(update.policySnippet.names, ['updatedAt']);
  assert.equal(update.observedFrequency, 1);
  // Ranking is frequency-first; volatile field proposals sort above unrelated noise when equal.
  assert.ok(report.suggestions[0].rank >= update.rank);
  // Output-only: stability result never gains top-level policy fields.
  assert.ok(!('volatilePayloadFields' in stability));
  assert.ok(!('acceptedDifferences' in stability));
  assert.ok(!JSON.stringify(report).includes('t1') && !JSON.stringify(report).includes('ANA'));
});

test('declared volatility removes the noise source and proposal disappears', () => {
  const declared = migrationComparisonPolicy({ network: { volatilePayloadFields: ['updatedAt'] } });
  const runs = [
    trace({ runIndex: 1, updatedAt: 't1' }),
    trace({ runIndex: 2, updatedAt: 't2' }),
    trace({ runIndex: 3, updatedAt: 't3' }),
  ];
  const stability = verifySourceStability({ runs, requiredRuns: 3, reset, policy: declared });
  assert.equal(stability.observations.status, 'STABLE');
  assert.equal(stability.suggestions, undefined);
});

test('snippets parse under existing policy and accepted-difference shapes', () => {
  const report = proposeNoiseSuggestions({
    scenarioId: 'update-customer',
    runCount: 3,
    divergences: [
      {
        divergenceId: '1', scenarioId: 'update-customer', dimension: 'NETWORK',
        code: 'NETWORK_PAYLOAD_VALUE_MISMATCH', severity: 'BLOCKING', message: 'NETWORK_PAYLOAD_VALUE_MISMATCH at /api/customers/123 payload.name',
        source: { path: 'payload.name', kind: 'string' }, target: { path: 'payload.name', kind: 'string' },
      },
      {
        divergenceId: '2', scenarioId: 'update-customer', dimension: 'NETWORK',
        code: 'NETWORK_PAYLOAD_VALUE_MISMATCH', severity: 'BLOCKING', message: 'NETWORK_PAYLOAD_VALUE_MISMATCH at /api/customers/123 payload.name',
        source: { path: 'payload.name', kind: 'string' }, target: { path: 'payload.name', kind: 'string' },
      },
      {
        divergenceId: '3', scenarioId: 'update-customer', dimension: 'STATE',
        code: 'STATE_STORAGE_VALUE_DIFFERS', severity: 'BLOCKING', message: 'storage saved',
        source: { path: 'storage.saved' }, target: { path: 'storage.saved' },
      },
    ],
    generatedAt: '2026-09-27T12:00:00.000Z',
  });
  assert.equal(report.suggestions.length, 2);
  const payload = report.suggestions.find(item => item.target.fieldPath === 'payload.name');
  assert.equal(payload.policySnippet.kind, 'volatilePayloadFields');
  HarnessPolicySchema.parse({ network: { volatilePayloadFields: payload.policySnippet.names } });
  const storage = report.suggestions.find(item => item.target.fieldPath === 'storage.saved');
  assert.equal(storage.policySnippet.kind, 'volatileStorageValues');
  HarnessPolicySchema.parse({ observables: { volatileStorageValues: [{ storageType: 'localStorage', key: 'saved' }] } });
  // Suggestion snippets are config fragments, not an approved acceptedDifferences entry.
  assert.throws(() => MigrationConfigSchema.shape.acceptedDifferences.parse([payload.policySnippet]));
});
