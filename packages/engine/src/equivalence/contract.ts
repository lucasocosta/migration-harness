import { canonical, matchPath, normalizeUrl, verifyContractIntegrity, type BehaviorContract, type EquivalenceDivergence, type Invariant, type SanitizedObservedTrace } from '@migration-harness/core';
import { buildExchanges } from './network/index.js';
import { normalizeAria } from './dimensions.js';

export function verifyCriticalContract(contract: BehaviorContract, trace: SanitizedObservedTrace): EquivalenceDivergence[] {
  const result: EquivalenceDivergence[] = [];
  const fail = (id: string, code: string, message: string, severity: 'BLOCKING' | 'WARNING' | 'INFORMATIONAL' = 'BLOCKING'): void => {
    result.push({ divergenceId: `${code}:${id}`, scenarioId: trace.scenarioId, dimension: 'CONTRACT', code, severity, message });
  };
  if (contract.status !== 'APPROVED' || !verifyContractIntegrity(contract)) {
    fail(contract.contractId, 'CONTRACT_INTEGRITY_FAILURE', 'Contract must be approved and its protected content intact.');
    return result;
  }
  const scenario = contract.scenarios.find(s => s.scenarioId === trace.scenarioId);
  if (!scenario) { fail(contract.contractId, 'CONTRACT_SCENARIO_MISSING', 'Scenario is absent from the approved contract.'); return result; }
  const exchanges = buildExchanges(trace);
  for (const invariant of scenario.invariants.network) {
    const value = invariant.value;
    const matches = exchanges.filter(e => matchPath(value.pathTemplate, new URL(e.request.url).pathname) !== undefined && (!value.causalDependencies.triggerStepId || value.causalDependencies.triggerStepId === e.trigger));
    const check = (ok: boolean, code: string, message: string): void => { if (!ok) fail(invariant.id, code, message, invariant.enforcement); };
    check(matches.length > 0, 'CONTRACT_NETWORK_MISSING', `Required operation ${invariant.id} was not observed.`);
    for (const exchange of matches) {
      check(exchange.request.method === value.method, 'CONTRACT_NETWORK_METHOD', `Required HTTP method is ${value.method}.`);
      check(Boolean(exchange.response) && value.responseExpectations.allowedStatusCodes.includes(exchange.response!.statusCode), 'CONTRACT_NETWORK_STATUS', 'Response is missing or status is not allowed.');
      const payload = exchange.request.payload;
      check(value.payloadRequirements.requiredFields.every(key => payload !== null && typeof payload === 'object' && Object.hasOwn(payload, key)), 'CONTRACT_PAYLOAD_REQUIRED', 'A required payload field is absent.');
      check(value.queryParams.required.every(key => Object.hasOwn(exchange.query, key)), 'CONTRACT_QUERY_REQUIRED', 'A required query parameter is absent.');
      const params = matchPath(value.pathTemplate, new URL(exchange.request.url).pathname)!;
      for (const [name, spec] of Object.entries(value.pathParams)) {
        const actual = params[name];
        check(actual !== undefined && (spec.type !== 'number' || /^-?\d+(\.\d+)?$/.test(actual)) && (spec.type !== 'uuid' || /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(actual)) && (!spec.pattern || new RegExp(spec.pattern).test(actual)), 'CONTRACT_PATH_PARAM', `Path parameter ${name} violates its schema.`);
      }
      const body = exchange.response?.body;
      check((value.responseExpectations.bodyShapeRequiredKeys ?? []).every(key => body !== null && typeof body === 'object' && Object.hasOwn(body, key)), 'CONTRACT_RESPONSE_REQUIRED', 'A required response field is absent.');
      for (const operationId of value.causalDependencies.afterOperationIds) {
        const predecessor = scenario.invariants.network.find(item => item.id === operationId);
        check(Boolean(predecessor && exchanges.some(e => e.request.method === predecessor.value.method && matchPath(predecessor.value.pathTemplate, new URL(e.request.url).pathname) !== undefined && e.response && e.response.sequenceIndex < exchange.request.sequenceIndex)), 'CONTRACT_CAUSAL_DEPENDENCY', `Operation must follow ${operationId}.`);
      }
    }
  }
  for (const invariant of scenario.invariants.navigation ?? []) {
    const last = trace.events.filter(e => e.type === 'NAVIGATION').at(-1);
    if (!last || normalizeUrl(last.toUrl) !== invariant.value.destination) fail(invariant.id, 'CONTRACT_NAVIGATION', 'Required final destination was not observed.', invariant.enforcement);
  }
  for (const invariant of scenario.invariants.storageDeltas) for (const expected of invariant.value) {
    if (!trace.events.some(e => e.type === 'STORAGE_DELTA' && e.storageType === expected.storageType && e.mutationType === expected.mutationType && e.key === expected.key && (!expected.expectedPattern || e.newValue !== null && new RegExp(expected.expectedPattern).test(e.newValue)))) fail(invariant.id, 'CONTRACT_STORAGE', 'Required storage mutation was not observed.', invariant.enforcement);
  }
  const aria = trace.events.filter(e => e.type === 'ARIA_STATE_CHANGE').at(-1);
  const verifyAria = (invariant: Invariant<unknown> | undefined, actual: unknown): void => {
    if (invariant && canonical(typeof invariant.value === 'object' ? normalizeAria(invariant.value) : invariant.value) !== canonical(actual)) fail(invariant.id, 'CONTRACT_ARIA', 'Approved ARIA semantics differ.', invariant.enforcement);
  };
  verifyAria(scenario.invariants.accessibilityAriaYaml, aria?.rawYamlTree);
  verifyAria(scenario.invariants.accessibilityAriaJson, aria ? normalizeAria(aria.jsonTree) : undefined);
  return result;
}
