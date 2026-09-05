import assert from 'node:assert/strict';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';
import { MigrationEngineStateMachine } from '../packages/engine/dist/state-machine.js';

function trace(method) {
  return {
    scenarioId: 'update-customer',
    runIndex: 1,
    startedAt: '2026-08-29T00:00:00.000Z',
    environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' },
    sanitization: { version: '1', appliedAt: '2026-08-29T00:00:01.000Z', redactionsCount: 0 },
    events: [
      { type: 'HTTP_REQUEST', eventId: 'req', timestampMs: 1, sequenceIndex: 1, correlationId: 'c1', method, url: 'https://app.test/api/customers/123', headers: {}, payload: { email: 'person@example.test' } },
      { type: 'HTTP_RESPONSE', eventId: 'res', timestampMs: 2, sequenceIndex: 2, correlationId: 'c1', method, url: 'https://app.test/api/customers/123', statusCode: 204, headers: {}, body: null, requestToResponseEndMs: 10 },
    ],
  };
}

const validator = new EquivalenceValidator();
const pass = validator.validate({ source: trace('PUT'), target: trace('PUT') });
assert.equal(pass.status, 'EQUIVALENT');

const fail = validator.validate({ source: trace('PUT'), target: trace('POST') });
assert.equal(fail.status, 'NOT_EQUIVALENT');
assert.equal(fail.divergences[0]?.code, 'NETWORK_METHOD_MISMATCH');

const fsm = new MigrationEngineStateMachine({ repairAttempts: 0, maxRepairAttempts: 2 });
fsm.start();
fsm.discoveryCompleted();
fsm.scenariosPrepared();
fsm.sourceTraceCompleted(3);
fsm.synthesisCompleted();
fsm.contractApproved();
fsm.contractIntegrityVerified();
fsm.transformationPlanned();
fsm.transformCompleted();
fsm.targetTraceCompleted();
fsm.equivalenceEvaluated(false);
fsm.failureClassified('AUTO_REPAIRABLE');
assert.equal(fsm.getState(), 'REPAIR_PATCH');
fsm.repairPatched();
assert.equal(fsm.getState(), 'EQUIVALENCE_VERIFY');
fsm.equivalenceEvaluated(true);
assert.equal(fsm.getState(), 'PR_READY');

console.log('v0.2 smoke: PASS');
