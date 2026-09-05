import { InvariantMiner } from '../packages/contract-synthesizer/dist/invariant-miner.js';
import { MigrationEngineStateMachine } from '../packages/engine/dist/state-machine.js';

const run = (runIndex) => ({
  scenarioId: 'smoke', runIndex, startedAt: new Date(Date.UTC(2026, 8, 5) + runIndex * 1000).toISOString(),
  environment: { browser: 'chromium', viewport: { width: 1, height: 1 }, locale: 'pt-BR' },
  events: [
    { type: 'HTTP_REQUEST', eventId: `r${runIndex}`, timestampMs: 1, sequenceIndex: 1, correlationId: `c${runIndex}`, method: 'PUT', url: 'http://local/api/profile', headers: {}, payload: { name: 'A', requestId: `${runIndex}` } },
    { type: 'HTTP_RESPONSE', eventId: `p${runIndex}`, timestampMs: 2, sequenceIndex: 2, correlationId: `c${runIndex}`, method: 'PUT', url: 'http://local/api/profile', statusCode: 204, headers: {}, body: null, requestToResponseEndMs: 10 },
  ],
});

const candidate = InvariantMiner.mineHttpRuntimeEvidence([run(1), run(2), run(3)]).candidateInvariants[0];
if (!candidate) throw new Error('No runtime candidate produced');
if (candidate.value.payloadRequirements.requiredFields.length !== 0) throw new Error('Runtime evidence illegally promoted requiredFields');
if (!candidate.value.responseExpectations.allowedStatusCodes.includes(204)) throw new Error('Observed response status lost');

const fsm = new MigrationEngineStateMachine({ repairAttempts: 0, maxRepairAttempts: 3 });
fsm.start(); fsm.discoveryCompleted(); fsm.scenariosPrepared(); fsm.sourceTraceCompleted(3); fsm.synthesisCompleted(); fsm.contractApproved();
fsm.contractIntegrityVerified(); fsm.transformationPlanned(); fsm.transformCompleted(); fsm.targetTraceCompleted();
fsm.equivalenceEvaluated(false); fsm.failureClassified('AUTO_REPAIRABLE'); fsm.repairPatched();
if (fsm.getState() !== 'EQUIVALENCE_VERIFY') throw new Error('Repair did not return to verification');
console.log('Migration Harness smoke tests: OK');
