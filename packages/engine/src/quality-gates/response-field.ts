import {
  parseResponseFieldRequirements, parseSanitizedTrace, UnitAssertionOutcomeSchema,
  type ResponseFieldRequirement, type SanitizedObservedTrace, type UnitAssertionOutcome, type VerificationStatus,
} from '@migration-harness/core';

/**
 * Evaluate owner-declared RESPONSE_FIELD requirements against the recorded HTTP exchanges of one scenario.
 *
 * The structural path is looked up in the response body of every complete request/response exchange of the
 * execution. Every exchange that carries the path must expose the declared type; none carrying it proves
 * `absent` but violates a concrete type; exchanges that disagree about whether the claim holds cannot decide
 * it and are inconclusive, as is an execution with no recorded exchange — never a pass. A mismatched type is
 * a violation. Both sides must satisfy the claim, so a requirement passes only when source and target do.
 * Diagnostics carry the requirement id, side and reason code — never an observed value.
 */
type ObservedKind = 'absent' | 'null' | 'string' | 'number' | 'boolean' | 'object' | 'array';

function observedKind(value: unknown): ObservedKind {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' ? type : 'object';
}

/** Dot-separated lookup inside one recorded response body; a missing segment is an absent value. */
function resolvePath(root: unknown, path: string): ObservedKind {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return 'absent';
    current = (current as Record<string, unknown>)[key];
  }
  return observedKind(current);
}

/** Complete exchanges of one execution — a request with its response. Failed or pending exchanges prove nothing. */
function responseBodies(trace: SanitizedObservedTrace): unknown[] {
  const terminals = new Map<string, unknown>();
  for (const event of trace.events) if (event.type === 'HTTP_RESPONSE') terminals.set(event.correlationId ?? '', event.body);
  return trace.events.flatMap(event => {
    if (event.type !== 'HTTP_REQUEST' || event.correlationId === undefined) return [];
    return terminals.has(event.correlationId) ? [terminals.get(event.correlationId) as unknown] : [];
  });
}

function evaluate(trace: SanitizedObservedTrace, requirement: ResponseFieldRequirement): Pick<UnitAssertionOutcome, 'status' | 'reason'> {
  const bodies = responseBodies(trace);
  if (!bodies.length) return { status: 'NOT_EVALUABLE', reason: 'RESPONSE_FIELD_NO_EXCHANGE' };
  const declared = requirement.claim.valueType;
  const present = bodies.map(body => resolvePath(body, requirement.claim.path)).filter(kind => kind !== 'absent');
  if (!present.length) {
    // Nothing in the recorded responses carries the path: proving its absence is possible, proving a value is not.
    return declared === 'absent' ? { status: 'SATISFIED' } : { status: 'VIOLATED', reason: 'RESPONSE_FIELD_MISSING' };
  }
  // The exchanges that carry the path must agree with the declared type; when they disagree with each other
  // the evidence cannot decide which response the requirement refers to — that is ambiguity, never a pass.
  if (present.every(kind => kind === declared)) return { status: 'SATISFIED' };
  if (present.some(kind => kind === declared)) return { status: 'NOT_EVALUABLE', reason: 'RESPONSE_FIELD_AMBIGUOUS' };
  return { status: 'VIOLATED', reason: 'RESPONSE_FIELD_TYPE_DIFFERS' };
}

const verificationStatus = (outcome: UnitAssertionOutcome): VerificationStatus =>
  outcome.status === 'SATISFIED' ? 'PASS' : outcome.status === 'VIOLATED' ? 'FAIL' : 'INCONCLUSIVE';

/** Same precedence the migration report aggregator uses: missing evidence dominates, nothing is a silent pass. */
function combined(statuses: VerificationStatus[]): VerificationStatus {
  if (!statuses.length || statuses.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return statuses.includes('FAIL') ? 'FAIL' : 'PASS';
}

export interface ResponseFieldEvaluation {
  /** Per side outcomes in the shared assertion-outcome vocabulary, feedable to `assertionRequirementStatuses`. */
  outcomes: UnitAssertionOutcome[];
  /** Both sides must satisfy every claim; unevaluable evidence maps to INCONCLUSIVE, never PASS. */
  status: VerificationStatus;
}

export function evaluateResponseFieldClaims(input: { claims: unknown; source: unknown; target: unknown }): ResponseFieldEvaluation {
  const claims = parseResponseFieldRequirements(input.claims);
  if (new Set(claims.map(item => item.id)).size !== claims.length) throw new Error('Duplicate response field claim id');
  const source = parseSanitizedTrace(input.source);
  const target = parseSanitizedTrace(input.target);
  if (source.scenarioId !== target.scenarioId) throw new Error(`Scenario mismatch: source=${source.scenarioId}, target=${target.scenarioId}`);
  const outcomes: UnitAssertionOutcome[] = [];
  for (const claim of claims) {
    for (const [side, trace] of [['source', source], ['target', target]] as const) {
      outcomes.push(UnitAssertionOutcomeSchema.parse({
        assertionId: claim.id, side, required: claim.required, ...evaluate(trace, claim),
      }));
    }
  }
  return { outcomes, status: combined(outcomes.map(verificationStatus)) };
}
