import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStateClaims, compareStateProjections, resolveStateAcceptedDivergence } from '../packages/engine/dist/quality-gates/index.js';

// STATE_SNAPSHOT envelope as the engine writes it (structural reader in quality-gates trusts the shape).
const snapshot = (captureId, projection, extra = {}) => ({
  kind: 'STATE_SNAPSHOT', version: '1', captureId, checkpoint: 'SCENARIO_END', side: 'target',
  scenarioId: 'save-customer', runId: 'run-1', runIndex: 0,
  probe: { commandId: 'probe-state', fingerprint: 'fp' }, projectionId: 'customer-domain',
  projectionFingerprint: 'pfp', configurationHash: 'ch', buildHash: 'bh',
  settle: { status: 'SETTLED' }, completeness: 'COMPLETE', projection, evidenceHash: 'eh', ...extra,
});
const claim = (id, path, predicate) => ({ id, required: true, stateClaim: { kind: 'STATE_FIELD', captureId: 'saved-customer', path, predicate } });

test('state claims pass, violate and stay inconclusive across the predicate matrix', async () => {
  const projection = { audit: { count: 1 }, customers: [{ fixtureKey: 'k1', emailHmac: 'HMAC-A' }, { fixtureKey: 'k2', emailHmac: 'HMAC-B' }] };
  // Two different keyed values are decided as a violation: equality claims are decidable evidence.
  const differing = evaluateStateClaims({
    claims: [claim('eq', '/audit/count', { kind: 'EQUALS', value: 1 }),
      claim('absent', '/audit/missing', { kind: 'ABSENT' }),
      claim('keyed', '/customers/0/emailHmac', { kind: 'KEYED_EQUAL', path: '/customers/1/emailHmac' })],
    sourceSnapshots: [snapshot('saved-customer', projection, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', projection)],
  });
  assert.equal(differing.status, 'FAIL', 'KEYED_EQUAL across two different keyed values is a violation');
  assert.ok(differing.outcomes.some(item => item.assertionId === 'keyed' && item.side === 'target'
    && item.status === 'VIOLATED' && item.reason === 'STATE_FIELD_DIFFERS'));
  // Equal keyed values across distinct entries satisfy the claim.
  const sharedKey = { audit: { count: 1 }, customers: [{ fixtureKey: 'k1', emailHmac: 'HMAC-A' }, { fixtureKey: 'k2', emailHmac: 'HMAC-A' }] };
  const satisfied = evaluateStateClaims({
    claims: [claim('eq', '/audit/count', { kind: 'EQUALS', value: 1 }),
      claim('absent', '/audit/missing', { kind: 'ABSENT' }),
      claim('keyed', '/customers/0/emailHmac', { kind: 'KEYED_EQUAL', path: '/customers/1/emailHmac' })],
    sourceSnapshots: [snapshot('saved-customer', sharedKey, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', sharedKey)],
  });
  assert.equal(satisfied.status, 'PASS');
  const violated = evaluateStateClaims({
    claims: [claim('eq', '/audit/count', { kind: 'EQUALS', value: 2 }),
      claim('absent', '/audit/count', { kind: 'ABSENT' }),
      claim('missing', '/audit/nope', { kind: 'EQUALS', value: 1 })],
    sourceSnapshots: [snapshot('saved-customer', projection, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', projection)],
  });
  assert.equal(violated.status, 'FAIL');
  assert.ok(violated.outcomes.some(item => item.assertionId === 'eq' && item.side === 'target' && item.status === 'VIOLATED' && item.reason === 'STATE_FIELD_DIFFERS'));
  assert.ok(violated.outcomes.some(item => item.assertionId === 'absent' && item.status === 'VIOLATED' && item.reason === 'STATE_FIELD_UNEXPECTED'));
  assert.ok(violated.outcomes.some(item => item.assertionId === 'missing' && item.status === 'VIOLATED' && item.reason === 'STATE_FIELD_MISSING'));
  for (const [label, targetSnapshots] of [
    ['no snapshot', []],
    ['incomplete snapshot', [snapshot('saved-customer', projection, { completeness: 'INCOMPLETE', projection: null })]],
    ['unsettled snapshot', [snapshot('saved-customer', projection, { settle: { status: 'TIMED_OUT' } })]],
    ['duplicate snapshots', [snapshot('saved-customer', projection), snapshot('saved-customer', projection)]],
  ]) {
    const result = evaluateStateClaims({
      claims: [claim('eq', '/audit/count', { kind: 'EQUALS', value: 1 })],
      sourceSnapshots: [snapshot('saved-customer', projection, { side: 'source' })], targetSnapshots,
    });
    assert.equal(result.status, 'INCONCLUSIVE', label);
    assert.ok(result.outcomes.some(item => item.side === 'target' && item.status === 'NOT_EVALUABLE'), label);
  }
  const ambiguous = evaluateStateClaims({
    claims: [claim('wild', '/audit/*', { kind: 'EQUALS', value: 1 })],
    sourceSnapshots: [snapshot('saved-customer', projection, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', projection)],
  });
  assert.equal(ambiguous.status, 'INCONCLUSIVE');
  assert.ok(ambiguous.outcomes.every(item => item.status === 'NOT_EVALUABLE' && item.reason === 'STATE_FIELD_AMBIGUOUS'));
});

test('equally wrong state is not success: both sides violating fails the claim', async () => {
  const wrong = { audit: { count: 7 } };
  const result = evaluateStateClaims({
    claims: [claim('eq', '/audit/count', { kind: 'EQUALS', value: 1 })],
    sourceSnapshots: [snapshot('saved-customer', wrong, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', wrong)],
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.outcomes.every(item => item.status === 'VIOLATED'));
});

test('keyed collections are compared by key tuple, never by position', async () => {
  const comparison = { collections: [{ path: '/customers', mode: 'KEYED', keyFields: ['fixtureKey'] }] };
  const source = snapshot('saved-customer', { customers: [{ fixtureKey: 'k1', emailHmac: 'A' }, { fixtureKey: 'k2', emailHmac: 'B' }], audit: { count: 1 } }, { side: 'source' });
  const shuffled = compareStateProjections({
    scenarioId: 'save-customer', captureId: 'saved-customer', source,
    target: snapshot('saved-customer', { audit: { count: 1 }, customers: [{ fixtureKey: 'k2', emailHmac: 'B' }, { fixtureKey: 'k1', emailHmac: 'A' }] }),
    comparison,
  });
  assert.deepEqual(shuffled, { findings: [], status: 'PASS' });
  const missingKey = compareStateProjections({
    scenarioId: 'save-customer', captureId: 'saved-customer', source,
    target: snapshot('saved-customer', { audit: { count: 1 }, customers: [{ fixtureKey: 'k1', emailHmac: 'A' }] }), comparison,
  });
  assert.equal(missingKey.status, 'FAIL');
  assert.deepEqual(missingKey.findings, [{ code: 'STATE_DIVERGENCE', scenarioId: 'save-customer', captureId: 'saved-customer', path: '/customers' }]);
  const nested = compareStateProjections({
    scenarioId: 'save-customer', captureId: 'saved-customer', source,
    target: snapshot('saved-customer', { audit: { count: 2 }, customers: [{ fixtureKey: 'k1', emailHmac: 'A' }, { fixtureKey: 'k2', emailHmac: 'B' }] }), comparison,
  });
  assert.equal(nested.status, 'FAIL');
  assert.deepEqual(nested.findings, [{ code: 'STATE_DIVERGENCE', scenarioId: 'save-customer', captureId: 'saved-customer', path: '/audit/count' }]);
  const incomplete = compareStateProjections({
    scenarioId: 'save-customer', captureId: 'saved-customer', source,
    target: snapshot('saved-customer', null, { completeness: 'INCOMPLETE' }), comparison,
  });
  assert.deepEqual(incomplete, { findings: [], status: 'INCONCLUSIVE' });
});

test('accepted differences resolve exact divergences only with satisfied claims and an owner decision', async () => {
  const source = snapshot('saved-customer', { audit: { count: 3 } }, { side: 'source' });
  const difference = {
    code: 'STATE_DIVERGENCE', scenarioId: 'save-customer', captureId: 'saved-customer', path: '/audit/count',
    resolution: { sourcePredicate: { kind: 'EQUALS', value: 3 }, requiredStateClaimIds: ['req-a'], ownerDecisionReference: 'ADR-7' },
  };
  const satisfied = [{ assertionId: 'req-a', side: 'target', required: true, status: 'SATISFIED' }];
  assert.equal(resolveStateAcceptedDivergence({ difference, source, claimOutcomes: satisfied }), true);
  assert.equal(resolveStateAcceptedDivergence({
    difference, source: snapshot('saved-customer', { audit: { count: 3 } }, { side: 'source', completeness: 'INCOMPLETE', projection: null }),
    claimOutcomes: satisfied,
  }), false, 'incomplete evidence is never resolvable');
  assert.equal(resolveStateAcceptedDivergence({
    difference, source, claimOutcomes: [{ assertionId: 'req-a', side: 'target', required: true, status: 'VIOLATED', reason: 'STATE_FIELD_DIFFERS' }],
  }), false);
  assert.equal(resolveStateAcceptedDivergence({
    difference: { ...difference, resolution: { ...difference.resolution, ownerDecisionReference: '' } }, source, claimOutcomes: satisfied,
  }), false);
  assert.equal(resolveStateAcceptedDivergence({
    difference: { ...difference, resolution: { ...difference.resolution, sourcePredicate: { kind: 'EQUALS', value: 99 } } }, source, claimOutcomes: satisfied,
  }), false);
});

test('state evaluation and divergences never echo observed values', async () => {
  const secret = 'secret-value-42';
  const result = evaluateStateClaims({
    claims: [claim('eq', '/audit/count', { kind: 'EQUALS', value: secret })],
    sourceSnapshots: [snapshot('saved-customer', { audit: { count: secret } }, { side: 'source' })],
    targetSnapshots: [snapshot('saved-customer', { audit: { count: 'other-42' } })],
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(!JSON.stringify(result.outcomes).includes(secret));
  assert.ok(!JSON.stringify(result.outcomes).includes('other-42'));
  const divergences = compareStateProjections({
    scenarioId: 'save-customer', captureId: 'saved-customer',
    source: snapshot('saved-customer', { audit: { count: secret } }, { side: 'source' }),
    target: snapshot('saved-customer', { audit: { count: 'other-42' } }),
  });
  assert.equal(divergences.status, 'FAIL');
  const encoded = JSON.stringify(divergences.findings);
  assert.ok(!encoded.includes(secret) && !encoded.includes('other-42'));
});

test('EQUALS literals on keyed fields are decided under the declared representation', async () => {
  const keyed = [{ path: '/customers/*/email', representation: 'KEYED_EQUALITY', domain: 'customer-email' }];
  const hmac = (value, domain) => `${typeof value}:HMAC(${domain},${String(value)})`;
  const stored = { customers: [{ fixtureKey: 'k1', email: 'string:HMAC(customer-email,a@b.test)' }] };
  const satisfied = evaluateStateClaims({
    claims: [claim('email', '/customers/0/email', { kind: 'EQUALS', value: 'a@b.test' })],
    sourceSnapshots: [snapshot('saved-customer', stored, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', stored)],
    keyed, hmac,
  });
  assert.equal(satisfied.status, 'PASS', 'the declared literal is keyed with the same representation before comparing');
  const violated = evaluateStateClaims({
    claims: [claim('email', '/customers/0/email', { kind: 'EQUALS', value: 'other@b.test' })],
    sourceSnapshots: [snapshot('saved-customer', stored, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', stored)],
    keyed, hmac,
  });
  assert.equal(violated.status, 'FAIL');
  assert.ok(violated.outcomes.some(item => item.side === 'target' && item.reason === 'STATE_FIELD_DIFFERS'));
  const noKey = evaluateStateClaims({
    claims: [claim('email', '/customers/0/email', { kind: 'EQUALS', value: 'a@b.test' })],
    sourceSnapshots: [snapshot('saved-customer', stored, { side: 'source' })], targetSnapshots: [snapshot('saved-customer', stored)],
    keyed,
  });
  assert.equal(noKey.status, 'INCONCLUSIVE', 'without the protected key nothing can be decided');
  assert.ok(noKey.outcomes.every(item => item.status === 'NOT_EVALUABLE' && item.reason === 'STATE_FIELD_AMBIGUOUS'));
});
