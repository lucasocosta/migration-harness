import { readFile } from 'node:fs/promises';
import { approveContract, reviewContract } from '../packages/core/dist/contract-review/index.js';
import './helpers/privacy.mjs';

export function trace(method = 'PUT', payload = { email: 'person@example.test' }) {
  return { scenarioId: 'update-customer', runIndex: 1, startedAt: '2026-09-05T00:00:00.000Z', environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' }, sanitization: { version: 'test', appliedAt: '2026-09-05T00:00:01.000Z', redactionsCount: 0 }, events: [
    { type: 'HTTP_REQUEST', eventId: 'request', sequenceIndex: 1, timestampMs: 1, correlationId: 'c1', method, url: 'https://app.test/api/customers/123', headers: {}, payload },
    { type: 'HTTP_RESPONSE', eventId: 'response', sequenceIndex: 2, timestampMs: 2, correlationId: 'c1', method, url: 'https://app.test/api/customers/123', headers: {}, statusCode: 204, body: null, requestToResponseEndMs: 1 },
  ] };
}
export function endpoint(overrides = {}) {
  return { id: 'save', enforcement: 'BLOCKING', evidenceTrail: [{ source: 'HUMAN_SPECIFICATION', evidenceConfidenceHeuristic: 1, sourceReference: 'test fixture specification' }], value: {
    pathTemplate: '/api/customers/:id', pathParams: { id: { type: 'number' } }, method: 'PUT', queryParams: { required: [], optional: [], ignored: [] },
    payloadRequirements: { observedAlwaysFields: [], observedSometimesFields: [], requiredFields: ['email'], optionalFields: [], ignoredVolatileFields: [] },
    responseExpectations: { allowedStatusCodes: [204] }, causalDependencies: { afterOperationIds: [] }, ...overrides,
  } };
}
export function contract(network = [endpoint()]) {
  return approveContract(reviewContract({ unitId: 'CustomerProfileComponent', contractId: 'pilot-contract', version: '1.0.0', status: 'DRAFT', integrity: { algorithm: 'sha256', contentHash: '' }, scenarios: [{ scenarioId: 'update-customer', invariants: { network, storageDeltas: [] } }] }), 'test-fixture-reviewer');
}
export function event(trace, type, values) {
  const index = trace.events.length + 1;
  trace.events.push({ type, eventId: `event-${index}`, timestampMs: index, sequenceIndex: index, ...values });
  return trace;
}
