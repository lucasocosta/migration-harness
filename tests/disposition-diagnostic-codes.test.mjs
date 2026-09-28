import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SuggestionReportSchema, isSuggestionOnlyDiagnostic, parseSuggestionReport,
  SUGGESTION_DETAIL_CODES,
} from '../packages/core/dist/index.js';
import { disposition } from '../packages/engine/dist/migration-session.js';

const hash = 'a'.repeat(64);
const time = '2026-09-27T12:00:00.000Z';
const identity = { migrationId: 'customer', configurationHash: hash, referenceHash: hash, candidateHash: hash, buildHash: hash };

function report(overrides = {}) {
  return {
    kind: 'MIGRATION_REPORT', version: '1', identity, evaluatedAt: time,
    status: 'FAIL', preservation: 'FAIL', requirements: 'NOT_APPLICABLE', projectChecks: 'PASS',
    referenceStatus: 'VERIFIED',
    requiredCoverage: {
      scenarios: { expected: 1, received: 1 },
      requirements: { expected: 1, received: 1 },
      checks: { expected: 1, received: 1 },
    },
    diagnostics: [], scenarios: [], checks: [], ...overrides,
  };
}

test('suggestion report schema is strict, output-only and HINT_ONLY', () => {
  const suggestion = {
    kind: 'SUGGESTION_REPORT', version: '1', generatedAt: time, authority: 'HINT_ONLY', scenarioId: 'update-customer',
    suggestions: [{
      suggestionId: 'noise-1', kind: 'NOISE_PROPOSAL', status: 'PROPOSED', rank: 0.9,
      observedFrequency: 1, runCount: 3, codes: ['NETWORK_PAYLOAD_VALUE_MISMATCH'],
      target: { scenarioId: 'update-customer', fieldPath: 'payload.updatedAt' },
      policySnippet: { kind: 'volatilePayloadFields', names: ['updatedAt'] },
      description: 'Field diverged across all source runs',
    }],
  };
  assert.deepEqual(parseSuggestionReport(suggestion), suggestion);
  assert.throws(() => parseSuggestionReport({ ...suggestion, authority: 'AUTO_APPLY' }));
  assert.throws(() => parseSuggestionReport({ ...suggestion, suggestions: [{ ...suggestion.suggestions[0], status: 'APPLIED' }] }));
  assert.equal(SuggestionReportSchema.parse(suggestion).authority, 'HINT_ONLY');
});

test('suggestion-only diagnostics never force FIX_ENVIRONMENT', () => {
  for (const detailCode of SUGGESTION_DETAIL_CODES) {
    const item = { code: 'STANDARD_WARNING', detailCode, category: 'EVIDENCE' };
    assert.equal(isSuggestionOnlyDiagnostic(item), true, detailCode);
  }
  assert.equal(isSuggestionOnlyDiagnostic({ code: 'BEHAVIOR_DIVERGENCE', detailCode: 'NOISE_PROPOSAL' }), false);
  assert.equal(isSuggestionOnlyDiagnostic({ code: 'STANDARD_WARNING', detailCode: 'STEP_FAILED' }), false);

  const onlySuggestions = {
    diagnostics: [
      { code: 'STANDARD_WARNING', detailCode: 'NOISE_PROPOSAL', category: 'EVIDENCE' },
      { code: 'STANDARD_WARNING', detailCode: 'VISUAL_MISMATCH', category: 'EVIDENCE' },
      { code: 'STANDARD_WARNING', detailCode: 'BINDING_ADAPTATION_PROPOSAL', category: 'EVIDENCE' },
    ],
    status: 'INCONCLUSIVE', preservation: 'INCONCLUSIVE', requirements: 'INCONCLUSIVE', projectChecks: 'INCONCLUSIVE',
  };
  assert.equal(disposition(report(onlySuggestions)), 'REVIEW_REFERENCE');

  const suggestionPlusRepair = {
    diagnostics: [
      { code: 'STANDARD_WARNING', detailCode: 'NOISE_PROPOSAL', category: 'EVIDENCE' },
      { code: 'BEHAVIOR_DIVERGENCE', detailCode: 'STEP_FAILED', side: 'target', stepId: 'save', category: 'IMPLEMENTATION' },
    ],
    status: 'FAIL',
  };
  assert.equal(disposition(report(suggestionPlusRepair)), 'REPAIR_IMPLEMENTATION');

  const suggestionPlusEnv = {
    diagnostics: [
      { code: 'STANDARD_WARNING', detailCode: 'VISUAL_MISMATCH', category: 'EVIDENCE' },
      { code: 'OPERATION_FAILED', detailCode: 'BOOT_FAILED', category: 'OPERATIONAL' },
    ],
    status: 'INCONCLUSIVE', preservation: 'INCONCLUSIVE', projectChecks: 'INCONCLUSIVE',
  };
  assert.equal(disposition(report(suggestionPlusEnv)), 'FIX_ENVIRONMENT');

  assert.equal(disposition(report({ status: 'PASS', preservation: 'PASS', projectChecks: 'PASS',
    diagnostics: [{ code: 'STANDARD_WARNING', detailCode: 'NOISE_PROPOSAL' }] })), 'COMPLETE');
});
