import {
  normalizeUrl, parseUnitAssertions, urlPatternMatches, UnitAssertionOutcomeSchema,
  type EquivalenceDivergence, type SanitizedObservedTrace, type TraceEvent, type UnitAssertion,
  type UnitAssertionClaim, type UnitAssertionOutcome, type UnitCheckpoint, type UnitScope,
} from '@migration-harness/core';
import { canonical } from '@migration-harness/core';
import { resolveValuePath, valuePathPresent } from './values.js';

/**
 * Evaluate owner-declared unit assertions against one recorded execution.
 *
 * These are requirements, not preservation: they are checked on each side independently so that two equally
 * wrong implementations cannot pass, and a required violation blocks regardless of how permissive the global
 * ARIA policy is. Only the migrated unit's scope is inspected, so destination shell differences are
 * irrelevant, while a scope that cannot be found is reported as not evaluable instead of satisfied.
 * Diagnostics carry the assertion id, a reason code and the declared role — never observed text or values.
 */
type AriaNode = Record<string, unknown>;
type Side = 'source' | 'target';

const asNode = (value: unknown): AriaNode | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AriaNode : undefined;
const childrenOf = (node: AriaNode): AriaNode[] => (Array.isArray(node.children) ? node.children as unknown[] : [])
  .map(asNode).filter((child): child is AriaNode => child !== undefined);
function nodeText(node: AriaNode): string {
  if (typeof node.text === 'string') return node.text;
  return childrenOf(node).filter(child => typeof child.text === 'string' && child.role === 'text').map(child => child.text as string).join(' ');
}
function matches(value: string | undefined, expected: string | undefined, mode: 'EXACT' | 'CONTAINS' = 'EXACT'): boolean {
  if (expected === undefined) return true;
  if (value === undefined) return false;
  const [actual, wanted] = [value.trim().replace(/\s+/g, ' '), expected.trim().replace(/\s+/g, ' ')];
  return mode === 'CONTAINS' ? actual.includes(wanted) : actual === wanted;
}
function findNodes(root: AriaNode, predicate: (node: AriaNode) => boolean): AriaNode[] {
  const found: AriaNode[] = [];
  const walk = (node: AriaNode, depth: number): void => {
    if (depth > 200) return;
    if (predicate(node)) found.push(node);
    for (const child of childrenOf(node)) walk(child, depth + 1);
  };
  walk(root, 0);
  return found;
}
const roleMatcher = (role: string, name?: string, nameMatch?: 'EXACT' | 'CONTAINS') => (node: AriaNode): boolean =>
  node.role === role && matches(typeof node.name === 'string' ? node.name : undefined, name, nameMatch);
function resolveScope(tree: AriaNode, scope?: UnitScope): AriaNode | undefined {
  if (!scope) return tree;
  return findNodes(tree, roleMatcher(scope.role, scope.name, scope.nameMatch))[0];
}
function stateMatches(node: AriaNode, state: Record<string, boolean | string | undefined>): boolean {
  return Object.entries(state).every(([key, expected]) => {
    if (expected === undefined) return true;
    const actual = node[key];
    return expected === false ? actual === undefined || actual === false : actual === expected;
  });
}
function ariaCapture(trace: SanitizedObservedTrace, checkpoint: UnitCheckpoint): AriaNode | 'MISSING' | 'EMPTY' {
  const captures = trace.events.filter(event => event.type === 'ARIA_STATE_CHANGE');
  const selected = checkpoint.kind === 'SCENARIO_END' ? captures.at(-1) : (() => {
    const steps = new Set(trace.events.flatMap(event => event.type === 'USER_INTERACTION' && event.stepId === checkpoint.stepId ? [event.eventId] : []));
    return captures.filter(capture => steps.has(capture.triggerEventId)).at(-1);
  })();
  if (!selected) return 'MISSING';
  return Object.keys(selected.jsonTree).length ? selected.jsonTree as AriaNode : 'EMPTY';
}
/**
 * Events attributable to the checkpoint: for a step, from that interaction until the next one, so a later
 * legitimate submission does not satisfy or violate an assertion about this interaction. Attribution relies
 * on the recorder draining a step's asynchronous activity before the next step, not on wall-clock timing.
 */
function checkpointWindow(trace: SanitizedObservedTrace, checkpoint: UnitCheckpoint): TraceEvent[] | 'MISSING' {
  if (checkpoint.kind === 'SCENARIO_END') return trace.events;
  const start = trace.events.findIndex(event => event.type === 'USER_INTERACTION' && event.stepId === checkpoint.stepId);
  if (start < 0) return 'MISSING';
  const rest = trace.events.slice(start + 1);
  const next = rest.findIndex(event => event.type === 'USER_INTERACTION');
  return [trace.events[start]!, ...(next < 0 ? rest : rest.slice(0, next))];
}
const requestPath = (url: string): string => new URL(url, 'http://harness.invalid').pathname;

/** A declared initial mock: a response it serves is fixture data, not evidence of application persistence. */
export interface DeclaredMock { urlPattern: string; method: string; statusCode?: number }
const servedByMock = (mocks: readonly DeclaredMock[], method: string, url: string): boolean =>
  mocks.some(mock => mock.method.toUpperCase() === method.toUpperCase() && urlPatternMatches(mock.urlPattern, url));

function evaluate(trace: SanitizedObservedTrace, assertion: UnitAssertion, scope?: UnitScope, mocks: readonly DeclaredMock[] = []): Pick<UnitAssertionOutcome, 'status' | 'reason'> {
  const satisfied = { status: 'SATISFIED' as const };
  const failed = (reason: UnitAssertionOutcome['reason']): Pick<UnitAssertionOutcome, 'status' | 'reason'> => ({ status: 'VIOLATED', ...(reason ? { reason } : {}) });
  const inconclusive = (reason: UnitAssertionOutcome['reason']): Pick<UnitAssertionOutcome, 'status' | 'reason'> => ({ status: 'NOT_EVALUABLE', ...(reason ? { reason } : {}) });
  const claim: UnitAssertionClaim = assertion.claim;
  if (claim.kind === 'NODE_PRESENT' || claim.kind === 'NODE_ABSENT') {
    const capture = ariaCapture(trace, assertion.checkpoint);
    if (capture === 'MISSING') return inconclusive('CHECKPOINT_MISSING');
    if (capture === 'EMPTY') return inconclusive('CAPTURE_EMPTY');
    const resolved = resolveScope(capture, scope ?? assertion.scope);
    if (!resolved) return inconclusive('SCOPE_NOT_FOUND');
    const nodes = findNodes(resolved, roleMatcher(claim.role, claim.name, claim.nameMatch));
    if (claim.kind === 'NODE_ABSENT') return nodes.some(node => matches(nodeText(node), claim.text, claim.textMatch)) ? failed('NODE_PRESENT_UNEXPECTED') : satisfied;
    if (!nodes.length) return failed('NODE_MISSING');
    if (claim.state && !nodes.some(node => stateMatches(node, claim.state!))) return failed('NODE_STATE_DIFFERS');
    const stateful = claim.state ? nodes.filter(node => stateMatches(node, claim.state!)) : nodes;
    if (claim.text !== undefined && !stateful.some(node => matches(nodeText(node), claim.text, claim.textMatch))) return failed('NODE_TEXT_DIFFERS');
    return satisfied;
  }  const window = checkpointWindow(trace, assertion.checkpoint);
  if (window === 'MISSING') return inconclusive('CHECKPOINT_MISSING');
  if (claim.kind === 'NO_REQUEST' || claim.kind === 'REQUEST_OBSERVED') {
    const requests = window.flatMap(event => event.type === 'HTTP_REQUEST'
      && (!claim.method || claim.method.toUpperCase() === event.method.toUpperCase())
      && urlPatternMatches(claim.pathPattern, requestPath(event.url)) ? [event] : []);
    if (claim.kind === 'NO_REQUEST') return requests.length ? failed('REQUEST_OBSERVED_UNEXPECTED') : satisfied;
    if (!requests.length) return failed('REQUEST_MISSING');
    if (claim.count !== undefined && requests.length !== claim.count) return failed('REQUEST_COUNT_DIFFERS');
    const fields = claim.requiredPayloadFields ?? [];
    const matching = requests.filter(request => fields.every(field => valuePathPresent(request.payload, field)));
    if (!matching.length) return failed('PAYLOAD_FIELD_MISSING');
    const values = Object.entries(claim.payloadValues ?? {});
    if (values.length && requests.some(request => values.some(([field]) => !valuePathPresent(request.payload, field)))) return inconclusive('PAYLOAD_FIELD_MISSING');
    return requests.every(request => values.every(([field, expected]) => canonical(resolveValuePath(request.payload, field).value) === canonical(expected)))
      ? satisfied : failed('PAYLOAD_VALUE_DIFFERS');
  }
  if (claim.kind === 'STORAGE_MUTATION') {
    const pattern = claim.valuePattern === undefined ? undefined : new RegExp(claim.valuePattern);
    return window.some(event => event.type === 'STORAGE_DELTA' && event.storageType === claim.storageType && event.key === claim.key
      && event.mutationType === claim.mutationType && (!pattern || (event.newValue !== null && pattern.test(event.newValue))))
      ? satisfied : failed('STORAGE_MUTATION_MISSING');
  }
  if (claim.kind === 'READ_BACK') {
    const write = window.flatMap(event => event.type === 'HTTP_REQUEST' && claim.writeMethod.toUpperCase() === event.method.toUpperCase()
      && urlPatternMatches(claim.writePathPattern, requestPath(event.url)) ? [event] : []).at(-1);
    if (!write) return failed('WRITE_MISSING');
    // The read may happen after this checkpoint, for example on the list the destination navigates to.
    const readMethod = (claim.readMethod ?? 'GET').toUpperCase();
    const reads = trace.events.flatMap(event => event.type === 'HTTP_RESPONSE' && event.sequenceIndex > write.sequenceIndex
      && readMethod === event.method.toUpperCase() && urlPatternMatches(claim.readPathPattern, requestPath(event.url)) ? [event] : []);
    if (!reads.length) return failed('READ_BACK_MISSING');
    // A fixed mock answers with fixture data: it cannot establish that the write was persisted.
    if (reads.every(read => servedByMock(mocks, read.method, read.url))) return inconclusive('READ_BACK_MOCKED');
    const persisted = reads.filter(read => !servedByMock(mocks, read.method, read.url)).some(read => claim.fields.every(field => {
      const written = resolveValuePath(write.payload, field.payloadField);
      const returned = resolveValuePath(read.body, field.responseField);
      return written.present && returned.present && canonical(written.value) === canonical(returned.value);
    }));
    return persisted ? satisfied : failed('READ_BACK_VALUE_DIFFERS');
  }
  return window.some(event => event.type === 'NAVIGATION' && urlPatternMatches(claim.pathPattern, normalizeUrl(event.toUrl)))
    ? satisfied : failed('NAVIGATION_MISSING');
}

export interface UnitAssertionEvaluation { outcomes: UnitAssertionOutcome[]; divergences: EquivalenceDivergence[] }

/**
 * Disclose how much of an execution was answered by declared fixtures. Mocked coverage is not a defect and
 * never blocks, but a report that hides it would overstate what the comparison established.
 */
export function discloseMockedCoverage(trace: SanitizedObservedTrace, mocks: readonly DeclaredMock[] = []): EquivalenceDivergence[] {
  if (!mocks.length) return [];
  const mocked = trace.events.filter(event => event.type === 'HTTP_RESPONSE' && servedByMock(mocks, event.method, event.url)).length;
  if (!mocked) return [];
  return [{ divergenceId: 'MOCKED_COVERAGE', scenarioId: trace.scenarioId, dimension: 'CONTRACT', code: 'MOCKED_COVERAGE',
    severity: 'INFORMATIONAL', message: 'Part of this execution was answered by declared fixtures.',
    target: { mockedResponses: mocked, declaredMocks: mocks.length } }];
}

export function evaluateUnitAssertions(input: {
  source: SanitizedObservedTrace; target: SanitizedObservedTrace; assertions: unknown;
  /** Per-application unit scope from the scenario bindings; it overrides the declared semantic scope. */
  unitScopes?: { source?: UnitScope; target?: UnitScope };
  /** Declared initial mocks of the scenario, used to separate mocked coverage from real persistence. */
  mocks?: readonly DeclaredMock[];
}): UnitAssertionEvaluation {
  const assertions = parseUnitAssertions(input.assertions);
  if (new Set(assertions.map(item => item.id)).size !== assertions.length) throw new Error('Duplicate unit assertion id');
  const mocks = input.mocks ?? [];
  const outcomes: UnitAssertionOutcome[] = [];
  const divergences: EquivalenceDivergence[] = [];
  const record = (assertion: UnitAssertion, side: Side, trace: SanitizedObservedTrace): UnitAssertionOutcome => {
    const outcome = UnitAssertionOutcomeSchema.parse({
      assertionId: assertion.id, side, required: assertion.required, ...evaluate(trace, assertion, input.unitScopes?.[side], mocks),
      ...('role' in assertion.claim ? { role: assertion.claim.role } : {}),
    });
    outcomes.push(outcome);
    return outcome;
  };
  for (const assertion of assertions) {
    const source = record(assertion, 'source', input.source);
    const target = record(assertion, 'target', input.target);
    const detail = (outcome: UnitAssertionOutcome): unknown => ({ assertionId: outcome.assertionId, reason: outcome.reason, ...(outcome.role ? { role: outcome.role } : {}) });
    // A required unit assertion blocks on its own authority: it is never softened by the global ARIA policy.
    if (target.status !== 'SATISFIED') {
      const code = target.status === 'VIOLATED' ? 'UNIT_ASSERTION_VIOLATED' : 'UNIT_ASSERTION_NOT_EVALUABLE';
      divergences.push({ divergenceId: `${code}:${assertion.id}`, scenarioId: input.target.scenarioId, dimension: 'CONTRACT', code,
        severity: assertion.required ? 'BLOCKING' : 'WARNING', message: `${code} for requirement ${assertion.id}`, target: detail(target) });
    } else if (source.status !== 'SATISFIED') {
      // The destination meets a requirement the source does not: disclose it instead of failing the unit.
      divergences.push({ divergenceId: `UNIT_ASSERTION_SOURCE_UNSATISFIED:${assertion.id}`, scenarioId: input.source.scenarioId,
        dimension: 'CONTRACT', code: 'UNIT_ASSERTION_SOURCE_UNSATISFIED', severity: 'INFORMATIONAL',
        message: `The source execution does not satisfy requirement ${assertion.id}`, source: detail(source) });
    }
  }
  return { outcomes, divergences };
}
