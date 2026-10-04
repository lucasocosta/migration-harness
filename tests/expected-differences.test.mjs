import test from 'node:test';
import assert from 'node:assert/strict';
import { trace } from './helpers.mjs';
import { EquivalenceValidator, evaluateUnitAssertions, resolveExpectedDifferences } from '../packages/engine/dist/equivalence/index.js';
import { parseMigrationConfig, migrationConfigHash } from '../packages/core/dist/index.js';
import { readFile } from 'node:fs/promises';

const assertion = value => ({ checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'REQUEST_OBSERVED', method: 'PUT',
  pathPattern: '/api/customers/123', count: 1, payloadValues: { title: value } } });
const targetRequirement = { ...assertion('correct'), id: 'trim', required: true };
const difference = { id: 'trim', scenarioId: 'update-customer', description: 'Explicit fixture correction', decisionReference: 'synthetic-owner-decision',
  resolution: { sourceAssertions: [assertion(' correct ')], targetRequirementIds: ['trim'],
    matches: [{ code: 'NETWORK_PAYLOAD_VALUE_MISMATCH', requestPath: '/api/customers/123', field: 'payload.title', count: 1 }] } };
const evaluate = (source, target, differences = [difference], extra = []) => {
  const comparison = new EquivalenceValidator().validate({ source, target, policy: { network: { comparePayloadValues: true } } });
  const assertions = evaluateUnitAssertions({ source, target, assertions: [targetRequirement] });
  return { comparison, assertions, ...resolveExpectedDifferences({ differences, scenarioId: source.scenarioId, source, target,
    divergences: [...comparison.divergences, ...extra], targetOutcomes: assertions.outcomes }) };
};

test('approved value correction requires exact location, counts and independent claims; original verdict stays failing', () => {
  const source = trace('PUT', { title: ' correct ', duration: 100 }), target = trace('PUT', { title: 'correct', duration: 100 });
  const result = evaluate(source, target);
  assert.equal(result.comparison.status, 'NOT_EQUIVALENT');
  assert.equal(result.acceptedDivergenceIds.length, 1);
  assert.equal(result.evidence[0].status, 'APPLIED');
  assert.equal(source.events[0].payload.title, ' correct ');
  for (const changed of [
    { ...difference, resolution: { ...difference.resolution, matches: [{ ...difference.resolution.matches[0], count: 2 }] } },
    { ...difference, resolution: { ...difference.resolution, matches: [{ ...difference.resolution.matches[0], requestPath: '/api/other' }] } },
    { ...difference, resolution: { ...difference.resolution, matches: [{ ...difference.resolution.matches[0], field: 'payload.duration' }] } },
    { ...difference, resolution: { ...difference.resolution, sourceAssertions: [assertion('wrong')] } },
    { ...difference, scenarioId: 'other' },
    { ...difference, resolution: undefined },
  ]) assert.equal(evaluate(source, target, [changed]).acceptedDivergenceIds.length, 0);
});

test('a target defect or absent value cannot use an approved exception', () => {
  const source = trace('PUT', { title: ' correct ' });
  for (const payload of [{ title: 'wrong' }, {}, { title: ' correct ' }]) {
    const result = evaluate(source, trace('PUT', payload));
    assert.equal(result.acceptedDivergenceIds.length, 0);
    assert.notEqual(result.assertions.outcomes.find(item => item.side === 'target').status, 'SATISFIED');
  }
  const doubled = trace('PUT', { title: 'correct' });
  doubled.events.push(...structuredClone(doubled.events).map((event, i) => ({ ...event, eventId: `second-${i}`, sequenceIndex: i + 3, correlationId: 'c2' })));
  assert.equal(evaluate(source, doubled).acceptedDivergenceIds.length, 0);
});

test('unrelated value, method and evidence failures remain blocking', () => {
  const source = trace('PUT', { title: ' correct ', duration: 100 }), target = trace('PUT', { title: 'correct', duration: 200 });
  const result = evaluate(source, target, [difference], [{ divergenceId: 'evidence', scenarioId: source.scenarioId,
    code: 'NETWORK_INCOMPLETE_EXCHANGE', dimension: 'NETWORK', severity: 'BLOCKING', message: 'Incomplete' }]);
  assert.equal(result.acceptedDivergenceIds.length, 1);
  assert.equal(result.comparison.divergences.filter(item => !result.acceptedDivergenceIds.includes(item.divergenceId)).length, 1);
  assert.equal(result.acceptedDivergenceIds.includes('evidence'), false);
  assert.equal(evaluate(source, trace('POST', { title: 'correct', duration: 100 })).acceptedDivergenceIds.length, 0);
});

test('expected missing PUT is bounded and guarded on both sides', () => {
  const source = trace('PUT', { title: 'fractional', duration: 1.5 }), target = trace('GET', null);
  source.events.push(...structuredClone(target.events).map((event, i) => ({ ...event, eventId: `get-${i}`, correlationId: 'get', sequenceIndex: i + 3 })));
  const claim = { id: 'no-put', required: true, checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NO_REQUEST', method: 'PUT', pathPattern: '/api/customers/123' } };
  const rule = { ...difference, resolution: { sourceAssertions: [assertion('fractional')], targetRequirementIds: ['no-put'],
    matches: [{ code: 'NETWORK_MISSING_REQUEST', requestPath: '/api/customers/123', method: 'PUT', count: 1 }] } };
  const divergences = new EquivalenceValidator().validate({ source, target }).divergences;
  const result = resolveExpectedDifferences({ differences: [rule], scenarioId: source.scenarioId, source, target, divergences,
    targetOutcomes: evaluateUnitAssertions({ source, target, assertions: [claim] }).outcomes });
  assert.equal(result.acceptedDivergenceIds.length, 1);
});

test('configuration fingerprints exception semantics and refuses optional or missing target guards', async () => {
  const config = JSON.parse(await readFile(new URL('../examples/validation-first/migration.json', import.meta.url)));
  config.acceptedDifferences = [{ ...difference, scenarioId: 'save' }];
  config.requirements.push({ id: 'trim', scenarioId: 'save', description: 'Required exact value', origin: 'SPECIFICATION', sourceReference: 'fixture', required: true, assertion: assertion('correct') });
  const hash = migrationConfigHash(config);
  config.acceptedDifferences[0].resolution.matches[0].count = 2;
  assert.notEqual(migrationConfigHash(config), hash);
  config.requirements.at(-1).required = false;
  assert.throws(() => parseMigrationConfig(config));
  config.requirements.at(-1).required = true;
  config.acceptedDifferences[0].resolution.matches[0].code = 'NETWORK_INCOMPLETE_EXCHANGE';
  assert.throws(() => parseMigrationConfig(config));
});
