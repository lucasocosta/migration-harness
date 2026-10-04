import {
  canonical, parseStateFieldClaim, UnitAssertionOutcomeSchema,
  type StateDivergence, type StateFieldClaim, type StatePredicate, type StateProjection,
  type UnitAssertionOutcome, type VerificationStatus,
} from '@migration-harness/core';

/**
 * State-capture evaluation over STATE_SNAPSHOT evidence.
 *
 * The differential comparison answers whether the destination preserved domain state; the STATE_FIELD
 * claims answer whether required invariants hold in the captured projection of each side. Snapshots are
 * read structurally (the engine owns their envelope) and fail closed: missing, incomplete, unsettled or
 * ambiguous evidence is NOT_EVALUABLE — never a pass. Diagnostics carry structural paths and reason
 * codes only, never observed values. Equally wrong is not success: both sides violating a claim fails
 * the requirement; per-side outcomes ride along so source defects can be disclosed separately from
 * target compliance (an explicit `appliesTo` may refine applicability later).
 */

const MAX_SNAPSHOTS = 1000;

export interface StateSnapshotView {
  captureId: string;
  checkpoint: string;
  side: 'source' | 'target';
  scenarioId: string;
  completeness: 'COMPLETE' | 'INCOMPLETE';
  settleStatus?: string;
  projection: unknown;
}

/** Structural envelope reader: the engine writes the envelope, this seam only trusts its declared shape. */
function asSnapshot(value: unknown): StateSnapshotView {
  if (value === null || typeof value !== 'object') throw new Error('STATE_EVIDENCE_INVALID');
  const record = value as Record<string, unknown>;
  if (typeof record.captureId !== 'string' || typeof record.checkpoint !== 'string'
    || (record.side !== 'source' && record.side !== 'target') || typeof record.scenarioId !== 'string'
    || (record.completeness !== 'COMPLETE' && record.completeness !== 'INCOMPLETE')) throw new Error('STATE_EVIDENCE_INVALID');
  const settle = record.settle as { status?: unknown } | undefined | null;
  return {
    captureId: record.captureId, checkpoint: record.checkpoint, side: record.side, scenarioId: record.scenarioId,
    completeness: record.completeness,
    ...(settle && typeof settle === 'object' && typeof settle.status === 'string' ? { settleStatus: settle.status } : {}),
    projection: record.projection ?? null,
  };
}

/** Only complete, settled evidence decides anything; everything else is inconclusive by construction. */
function usable(snapshot: StateSnapshotView | null): boolean {
  return snapshot !== null && snapshot.completeness === 'COMPLETE' && snapshot.projection !== null
    && snapshot.settleStatus !== 'TIMED_OUT';
}

function indexSnapshots(values: unknown): Map<string, StateSnapshotView | null> {
  if (!Array.isArray(values)) throw new Error('STATE_EVIDENCE_INVALID');
  const indexed = new Map<string, StateSnapshotView | null>();
  for (const value of values.slice(0, MAX_SNAPSHOTS)) {
    const snapshot = asSnapshot(value);
    // Duplicate evidence for one capture cannot decide which snapshot a claim refers to.
    indexed.set(snapshot.captureId, indexed.has(snapshot.captureId) ? null : snapshot);
  }
  return indexed;
}

const escapeSegment = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');

/** JSON Pointer lookup (`~0`/`~1` escapes, array indexes). A wildcard segment is not evaluable, not absent. */
function resolvePointer(root: unknown, pointer: string): { found: boolean; ambiguous: boolean; value: unknown } {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { found: false, ambiguous: true, value: undefined };
  if (pointer.split('/').slice(1).some(segment => segment.includes('*'))) return { found: false, ambiguous: true, value: undefined };
  let current: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return { found: false, ambiguous: false, value: undefined };
      const index = Number(key);
      if (index >= current.length) return { found: false, ambiguous: false, value: undefined };
      current = current[index];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else return { found: false, ambiguous: false, value: undefined };
  }
  return { found: true, ambiguous: false, value: current };
}

function predicateHolds(at: { found: boolean; ambiguous: boolean; value: unknown }, root: unknown,
  predicate: StatePredicate): { holds: boolean; ambiguous: boolean } {
  if (at.ambiguous) return { holds: false, ambiguous: true };
  if (predicate.kind === 'ABSENT') return { holds: !at.found, ambiguous: false };
  if (predicate.kind === 'KEYED_EQUAL') {
    const other = resolvePointer(root, predicate.path);
    if (!at.found || !other.found) return { holds: false, ambiguous: other.ambiguous || at.ambiguous };
    // Equality under the sanitized representation: HMAC fields compare as equal HMACs, never decrypted.
    return { holds: canonical(at.value) === canonical(other.value), ambiguous: false };
  }
  if (!at.found) return { holds: false, ambiguous: false };
  return { holds: canonical(at.value) === canonical(predicate.value), ambiguous: false };
}

type ClaimInput = { id: string; required: boolean; stateClaim: StateFieldClaim };

export interface KeyedField {
  path: string;
  representation: 'KEYED_EQUALITY' | 'STRUCTURAL';
  domain?: string | undefined;
}

/** Wildcard-segment matching of a claim's concrete pointer against a declared field pattern. */
function matchField(fields: readonly KeyedField[], path: string): KeyedField | undefined {
  const segments = path.split('/');
  return fields.find(field => {
    const pattern = field.path.split('/');
    return pattern.length === segments.length && pattern.every((part, index) => part === '*' || part === segments[index]);
  });
}

function evaluateClaim(snapshot: StateSnapshotView | null, claim: ClaimInput,
  keyed: readonly KeyedField[], hmac: ((value: unknown, domain: string) => string) | undefined): Pick<UnitAssertionOutcome, 'status' | 'reason'> {
  if (snapshot === null) return { status: 'NOT_EVALUABLE', reason: 'STATE_NO_SNAPSHOT' };
  if (!usable(snapshot)) return { status: 'NOT_EVALUABLE', reason: 'STATE_INCOMPLETE' };
  const predicate = claim.stateClaim.predicate;
  const at = resolvePointer(snapshot.projection, claim.stateClaim.path);
  if (predicate.kind === 'EQUALS') {
    const field = matchField(keyed, claim.stateClaim.path);
    if (field?.representation === 'KEYED_EQUALITY') {
      // Stored values are keyed representations: a declared literal must be keyed the same way inside
      // protected processing. Without the key nothing can be decided — never a plaintext comparison.
      if (!hmac) return { status: 'NOT_EVALUABLE', reason: 'STATE_FIELD_AMBIGUOUS' };
      if (at.ambiguous) return { status: 'NOT_EVALUABLE', reason: 'STATE_FIELD_AMBIGUOUS' };
      if (!at.found) return { status: 'VIOLATED', reason: 'STATE_FIELD_MISSING' };
      return canonical(at.value) === canonical(hmac(predicate.value, field.domain ?? field.path))
        ? { status: 'SATISFIED' } : { status: 'VIOLATED', reason: 'STATE_FIELD_DIFFERS' };
    }
    // A STRUCTURAL field keeps only its shape; a literal value cannot be decided against it.
    if (field?.representation === 'STRUCTURAL') return { status: 'NOT_EVALUABLE', reason: 'STATE_FIELD_AMBIGUOUS' };
  }
  const verdict = predicateHolds(at, snapshot.projection, predicate);
  if (verdict.ambiguous) return { status: 'NOT_EVALUABLE', reason: 'STATE_FIELD_AMBIGUOUS' };
  if (verdict.holds) return { status: 'SATISFIED' };
  if (predicate.kind === 'ABSENT') return { status: 'VIOLATED', reason: 'STATE_FIELD_UNEXPECTED' };
  return { status: 'VIOLATED', reason: at.found ? 'STATE_FIELD_DIFFERS' : 'STATE_FIELD_MISSING' };
}

const verificationStatus = (outcome: UnitAssertionOutcome): VerificationStatus =>
  outcome.status === 'SATISFIED' ? 'PASS' : outcome.status === 'VIOLATED' ? 'FAIL' : 'INCONCLUSIVE';

function combined(statuses: VerificationStatus[]): VerificationStatus {
  if (!statuses.length || statuses.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return statuses.includes('FAIL') ? 'FAIL' : 'PASS';
}

function parseClaims(value: unknown): ClaimInput[] {
  if (!Array.isArray(value)) throw new Error('STATE_CLAIMS_INVALID');
  const claims = value.slice(0, MAX_SNAPSHOTS).map(entry => {
    const record = entry as { id?: unknown; required?: unknown; stateClaim?: unknown };
    if (typeof record.id !== 'string' || typeof record.required !== 'boolean') throw new Error('STATE_CLAIMS_INVALID');
    return { id: record.id, required: record.required, stateClaim: parseStateFieldClaim(record.stateClaim) };
  });
  if (new Set(claims.map(item => item.id)).size !== claims.length) throw new Error('Duplicate state claim id');
  return claims;
}

export interface StateClaimEvaluation {
  /** Per-side outcomes in the shared assertion-outcome vocabulary (feedable to requirement aggregation). */
  outcomes: UnitAssertionOutcome[];
  /** Both sides must satisfy every claim; unevaluable evidence maps to INCONCLUSIVE, never PASS. */
  status: VerificationStatus;
}

export function evaluateStateClaims(input: {
  claims: unknown; sourceSnapshots: unknown; targetSnapshots: unknown;
  /** Declared field representations, so EQUALS literals on keyed fields are decided inside protected processing. */
  keyed?: readonly KeyedField[] | undefined;
  hmac?: ((value: unknown, domain: string) => string) | undefined;
}): StateClaimEvaluation {
  const claims = parseClaims(input.claims);
  const source = indexSnapshots(input.sourceSnapshots);
  const target = indexSnapshots(input.targetSnapshots);
  const outcomes: UnitAssertionOutcome[] = [];
  for (const claim of claims) {
    for (const [side, indexed] of [['source', source], ['target', target]] as const) {
      outcomes.push(UnitAssertionOutcomeSchema.parse({
        assertionId: claim.id, side, required: claim.required,
        ...evaluateClaim(indexed.get(claim.stateClaim.captureId) ?? null, claim, input.keyed ?? [], input.hmac),
      }));
    }
  }
  return { outcomes, status: combined(outcomes.map(verificationStatus)) };
}

export interface StateDivergenceFinding {
  code: 'STATE_DIVERGENCE';
  scenarioId: string;
  captureId: string;
  /** Structural path only — observed values are never echoed. */
  path: string;
}

interface CompareContext {
  captureId: string;
  scenarioId: string;
  keyed: Map<string, string[]>;
  findings: StateDivergenceFinding[];
}

function diverge(context: CompareContext, path: string): void {
  context.findings.push({ code: 'STATE_DIVERGENCE', scenarioId: context.scenarioId, captureId: context.captureId, path });
}

function compareValues(source: unknown, target: unknown, path: string, context: CompareContext, depth: number): void {
  if (depth > 64) { diverge(context, path); return; }
  if (canonical(source) === canonical(target)) return;
  const bothObjects = source !== null && target !== null && typeof source === 'object' && typeof target === 'object'
    && Array.isArray(source) === Array.isArray(target);
  if (!bothObjects) { diverge(context, path); return; }
  if (Array.isArray(source) && Array.isArray(target)) {
    const keyFields = context.keyed.get(path);
    if (!keyFields) {
      if (source.length !== target.length) { diverge(context, path); return; }
      for (let index = 0; index < source.length; index += 1) {
        compareValues(source[index], target[index], `${path}/${index}`, context, depth + 1);
      }
      return;
    }
    // KEYED collections: elements are matched by their declared key tuple, never by position.
    const keyed = (items: unknown[]): Map<string, unknown> => {
      const mapped = new Map<string, unknown>();
      for (const item of items) {
        const tuple = keyFields.map(field => (item as Record<string, unknown>)[field]);
        const identity = canonical(tuple);
        if (mapped.has(identity)) { diverge(context, path); return new Map(); }
        mapped.set(identity, item);
      }
      return mapped;
    };
    const bySource = keyed(source), byTarget = keyed(target);
    if (!bySource.size && source.length) return;
    for (const [identity, item] of bySource) {
      const other = byTarget.get(identity);
      if (other === undefined) { diverge(context, path); continue; }
      compareValues(item, other, `${path}/${escapeSegment(String(identity))}`, context, depth + 1);
    }
    for (const identity of byTarget.keys()) if (!bySource.has(identity)) diverge(context, path);
    return;
  }
  const sourceKeys = new Set(Object.keys(source as object)), targetKeys = new Set(Object.keys(target as object));
  for (const key of new Set([...sourceKeys, ...targetKeys])) {
    const child = `${path}/${escapeSegment(key)}`;
    if (!sourceKeys.has(key) || !targetKeys.has(key)) { diverge(context, child); continue; }
    compareValues((source as Record<string, unknown>)[key], (target as Record<string, unknown>)[key], child, context, depth + 1);
  }
}

export function compareStateProjections(input: {
  scenarioId: string; captureId: string; source: unknown; target: unknown;
  comparison?: StateProjection['comparison'] | undefined;
}): { findings: StateDivergenceFinding[]; status: VerificationStatus } {
  const source = asSnapshot(input.source), target = asSnapshot(input.target);
  if (!usable(source) || !usable(target)) return { findings: [], status: 'INCONCLUSIVE' };
  const keyed = new Map<string, string[]>();
  for (const collection of input.comparison?.collections ?? []) if (collection.mode === 'KEYED') keyed.set(collection.path, collection.keyFields);
  const context: CompareContext = { captureId: input.captureId, scenarioId: input.scenarioId, keyed, findings: [] };
  compareValues(source.projection, target.projection, '', context, 0);
  return { findings: context.findings, status: context.findings.length ? 'FAIL' : 'PASS' };
}

/**
 * Accepted-difference gate: a declared STATE_DIVERGENCE resolves only when the SOURCE predicate holds at
 * the exact path, every required state claim is satisfied, and an owner decision reference is present.
 * Missing, incomplete or privacy-omitted evidence is never resolvable — acceptance cannot stand in for
 * evidence.
 */
export function resolveStateAcceptedDivergence(input: {
  difference: StateDivergence; source: unknown;
  claimOutcomes: readonly { assertionId: string; status: 'SATISFIED' | 'VIOLATED' | 'NOT_EVALUABLE' }[];
}): boolean {
  const snapshot = asSnapshot(input.source);
  if (!usable(snapshot)) return false;
  const resolution = input.difference.resolution;
  if (typeof resolution.ownerDecisionReference !== 'string' || resolution.ownerDecisionReference.trim() === '') return false;
  const at = resolvePointer(snapshot.projection, input.difference.path);
  const verdict = predicateHolds(at, snapshot.projection, resolution.sourcePredicate);
  if (!verdict.holds) return false;
  return resolution.requiredStateClaimIds.length > 0 && resolution.requiredStateClaimIds.every(id => {
    const outcomes = input.claimOutcomes.filter(outcome => outcome.assertionId === id);
    return outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'SATISFIED');
  });
}
