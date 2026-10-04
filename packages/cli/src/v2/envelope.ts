import { randomUUID } from 'node:crypto';
import { ERROR_CATALOG, type ErrorDescriptor } from '../errors.js';
import type { NextAction } from './next-actions.js';

/**
 * CLI v2 envelope — single source of truth (PLAN-V2 §3.1).
 *
 * Three independent axes, never collapsed:
 * - `operationStatus` describes how the OPERATION was processed: `processed` (it ran and produced a
 *   result), `refused` (the harness/session/policy refused it before or instead of evaluating),
 *   `failed` (processing broke outside the published flow).
 * - `outcome` is the evaluation (`PASS` | `FAIL` | `INCONCLUSIVE`) and is ABSENT when nothing was
 *   evaluated — a status read, a refusal or a crash never invents one.
 * - `decision` is the SESSION disposition (never inferred from `outcome` alone; it comes from the
 *   engine's own disposition over a report, from session state, or it is absent).
 *
 * `COMBINATION_TABLE` is the normative list of the trios that may appear together, each row pinned to
 * its immutable exit code. Anything not in the table is a contract violation and is refused at build
 * time: exit codes can never change incidentally (PLAN-V2 §3.1, §8.1, §9.1).
 */
export const ENVELOPE_SCHEMA_VERSION = '1';

export type OperationStatus = 'processed' | 'refused' | 'failed';
export type EnvelopeOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type SessionDecision =
  | 'READY' | 'COMPLETE' | 'REPAIR_IMPLEMENTATION' | 'FIX_ENVIRONMENT' | 'REVIEW_REFERENCE'
  | 'REFUSED_SCOPE' | 'STOP_LIMIT' | 'STOP_NO_PROGRESS' | 'INTERRUPTED';

/** Session stops and refusals: they outrank every evaluation in the exit code. */
export const STOP_DECISIONS: readonly SessionDecision[] = ['REFUSED_SCOPE', 'STOP_LIMIT', 'STOP_NO_PROGRESS', 'INTERRUPTED'];

/**
 * A stop/refusal always explains itself: exit 3 never ships `diagnostics: []`. Each stop decision is
 * pinned to the catalog entry ({code, category, cause, action, retryable}) that names why the session
 * stopped, so the operator can act on the envelope alone (PLAN-V2 §11.2 A9).
 */
const STOP_DIAGNOSTIC_CODE: Readonly<Partial<Record<SessionDecision, string>>> = {
  REFUSED_SCOPE: 'OUTSIDE_WRITE_SCOPE',
  STOP_LIMIT: 'BUDGET_EXHAUSTED',
  STOP_NO_PROGRESS: 'NO_PROGRESS_STOP',
  INTERRUPTED: 'SESSION_ATTEMPT_OPEN',
};

export type EnvelopeExitCode = 0 | 1 | 3 | 4 | 5;

export interface CombinationRow {
  readonly operationStatus: OperationStatus;
  /** `null` = the key is absent from the envelope. */
  readonly decision: SessionDecision | null;
  /** `null` = no evaluation happened in this operation. */
  readonly outcome: EnvelopeOutcome | null;
  readonly exitCode: EnvelopeExitCode;
  readonly meaning: string;
}

const row = (
  operationStatus: OperationStatus, decision: SessionDecision | null, outcome: EnvelopeOutcome | null,
  exitCode: EnvelopeExitCode, meaning: string,
): CombinationRow => ({ operationStatus, decision, outcome, exitCode, meaning });

/**
 * The valid combinations of {operationStatus, decision, outcome} and the exit code each one maps to.
 *
 * Reading the table:
 * - `processed` carries the operation's own result: an evaluation without a session (doctor/prepare),
 *   a session disposition with or without a fresh evaluation (status/verify), or a plain state report.
 * - `refused` carries a session stop/refusal (exit 3) or an operation-level refusal outside the session
 *   such as missing authorization, an occupied artifact path or an inconsistent privacy declaration
 *   (exit 1). A refusal never carries an outcome: nothing was evaluated.
 * - `failed` is a processing error (exit 1): diagnostics only, never a decision or an outcome.
 * - Stop decisions map to 3 under every outcome — a stop prevails even over PASS (§3.1), while
 *   FAIL/INCONCLUSIVE only reach 4/5 when no stop applies.
 */
export const COMBINATION_TABLE: readonly CombinationRow[] = [
  // processed: operation completed; evaluation without a session decision (init, doctor, prepare).
  row('processed', null, null, 0, 'operation completed; nothing was evaluated'),
  row('processed', null, 'PASS', 0, 'evaluation PASS without a session decision (doctor/prepare)'),
  row('processed', null, 'FAIL', 4, 'evaluation FAIL without a session decision (prepare)'),
  row('processed', null, 'INCONCLUSIVE', 5, 'evaluation INCONCLUSIVE without a session decision (doctor/prepare)'),
  // processed: session dispositions reported without a fresh evaluation (status, reference, prepare).
  row('processed', 'READY', null, 0, 'session open and awaiting its first verification'),
  row('processed', 'READY', 'PASS', 0, 'preparation PASS and the resumable session opened'),
  row('processed', 'COMPLETE', null, 0, 'status: the recorded disposition is COMPLETE; no new evaluation'),
  row('processed', 'COMPLETE', 'PASS', 0, 'verification completed with a PASS report'),
  row('processed', 'REPAIR_IMPLEMENTATION', null, 0, 'status: recorded disposition needs a candidate repair'),
  row('processed', 'REPAIR_IMPLEMENTATION', 'FAIL', 4, 'verification FAIL asks for a candidate repair'),
  row('processed', 'REPAIR_IMPLEMENTATION', 'INCONCLUSIVE', 5, 'exit follows the outcome, not the decision'),
  row('processed', 'FIX_ENVIRONMENT', null, 0, 'status: recorded disposition points at the environment'),
  row('processed', 'FIX_ENVIRONMENT', 'INCONCLUSIVE', 5, 'verification could not decide because of the environment'),
  row('processed', 'REVIEW_REFERENCE', null, 0, 'status: reference not verified / recorded disposition needs owner review'),
  row('processed', 'REVIEW_REFERENCE', 'FAIL', 4, 'evaluation FAIL while the reference also needs review'),
  row('processed', 'REVIEW_REFERENCE', 'INCONCLUSIVE', 5, 'inconclusive evaluation that needs reference review'),
  // processed: a stop observed by status, or reached by an attempt that did run.
  row('processed', 'REFUSED_SCOPE', null, 3, 'scope refusal (status report, or an attempt refused mid-run)'),
  row('processed', 'STOP_LIMIT', null, 3, 'attempt/time budget exhausted'),
  row('processed', 'STOP_LIMIT', 'PASS', 3, 'stop prevails over a PASS report'),
  row('processed', 'STOP_LIMIT', 'FAIL', 3, 'stop prevails over a FAIL report'),
  row('processed', 'STOP_LIMIT', 'INCONCLUSIVE', 3, 'stop prevails over an inconclusive report'),
  row('processed', 'STOP_NO_PROGRESS', null, 3, 'repeated identical failures stopped the session'),
  row('processed', 'STOP_NO_PROGRESS', 'PASS', 3, 'stop prevails over a PASS report'),
  row('processed', 'STOP_NO_PROGRESS', 'FAIL', 3, 'stop prevails over a FAIL report'),
  row('processed', 'STOP_NO_PROGRESS', 'INCONCLUSIVE', 3, 'stop prevails over an inconclusive report'),
  row('processed', 'INTERRUPTED', null, 3, 'an attempt never recorded its finish'),
  // refused: session stops/refusals seen before any attempt ran (no outcome exists).
  row('refused', null, null, 1, 'operation refused outside the session (authorization, input, occupied artifact, privacy conflict)'),
  row('refused', 'REFUSED_SCOPE', null, 3, 'verification refused before executing: the workspace left the authorized scope'),
  row('refused', 'STOP_LIMIT', null, 3, 'verification refused: the session budget is exhausted'),
  row('refused', 'STOP_NO_PROGRESS', null, 3, 'verification refused: the session stopped for no progress'),
  row('refused', 'INTERRUPTED', null, 3, 'verification refused: a previous attempt is still open'),
  // failed: processing error; diagnostics only.
  row('failed', null, null, 1, 'processing failed outside the published flow'),
];

const COMBINATION_KEY = (operationStatus: string, decision: string | null | undefined, outcome: string | null | undefined): string =>
  `${operationStatus}|${decision ?? null}|${outcome ?? null}`;

const BY_KEY = new Map(COMBINATION_TABLE.map(entry => [COMBINATION_KEY(entry.operationStatus, entry.decision, entry.outcome), entry]));

export function findCombination(
  operationStatus: string, decision: SessionDecision | null | undefined, outcome: EnvelopeOutcome | null | undefined,
): CombinationRow | undefined {
  return BY_KEY.get(COMBINATION_KEY(operationStatus, decision, outcome));
}

/** Refuse any trio the table does not list: an unmapped combination is a contract violation. */
export function assertCombination(
  operationStatus: string, decision: SessionDecision | null | undefined, outcome: EnvelopeOutcome | null | undefined,
): CombinationRow {
  const found = findCombination(operationStatus, decision, outcome);
  if (!found) throw new Error(`INVALID_ENVELOPE_COMBINATION: ${operationStatus}/${decision ?? 'none'}/${outcome ?? 'none'}`);
  return found;
}

export function exitCodeFor(
  operationStatus: string, decision: SessionDecision | null | undefined, outcome: EnvelopeOutcome | null | undefined,
): EnvelopeExitCode {
  return assertCombination(operationStatus, decision, outcome).exitCode;
}

/** Operation-level diagnostic: a projection of the single error catalog (code → cause → action). */
export interface EnvelopeDiagnostic {
  readonly code: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly action: string;
  readonly cause: string;
  /** Safe field/flag name the failure is bound to; never a payload or a private path. */
  readonly fieldPath?: string;
}

export function envelopeDiagnostic(descriptor: ErrorDescriptor, options: { fieldPath?: string } = {}): EnvelopeDiagnostic {
  return {
    code: descriptor.code,
    category: descriptor.category,
    retryable: descriptor.retryable,
    action: descriptor.action,
    cause: descriptor.cause,
    ...(options.fieldPath ? { fieldPath: options.fieldPath } : {}),
  };
}

export interface Envelope {
  readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  readonly operation: string;
  readonly operationStatus: OperationStatus;
  /** Session identity (workspace-relative session path) when a session is involved. */
  readonly sessionId?: string;
  /** Unique id of this envelope's run; requestKey is the idempotency identity, not this one. */
  readonly runId: string;
  readonly decision?: SessionDecision;
  readonly outcome?: EnvelopeOutcome;
  /** The operation's result document; absent when the operation produced none. */
  readonly report?: unknown;
  readonly diagnostics: EnvelopeDiagnostic[];
  readonly nextActions: NextAction[];
  /** Deterministic identity of this normalized request (artifact-consuming operations). */
  readonly requestKey?: string;
  /** Set when a recorded request with the same identity already occupies this artifact path. */
  readonly replayOf?: string;
}

export interface EnvelopeInput {
  operation: string;
  operationStatus: OperationStatus;
  sessionId?: string;
  runId?: string;
  decision?: SessionDecision;
  outcome?: EnvelopeOutcome;
  report?: unknown;
  diagnostics?: EnvelopeDiagnostic[];
  nextActions?: NextAction[];
  requestKey?: string;
  replayOf?: string;
}

/** Build one envelope; an invalid {operationStatus, decision, outcome} trio throws instead of shipping. */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  assertCombination(input.operationStatus, input.decision ?? null, input.outcome ?? null);
  const reported = input.diagnostics ?? [];
  // A stop is never silent: an exit-3 envelope without a diagnostic would leave the operator with a
  // code and no cause/action, so the catalog entry of the decision fills the gap (PLAN-V2 §11.2 A9).
  const stopCode = input.decision ? STOP_DIAGNOSTIC_CODE[input.decision] : undefined;
  const stopDescriptor = stopCode && !reported.length ? ERROR_CATALOG[stopCode] : undefined;
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    operation: input.operation,
    operationStatus: input.operationStatus,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    runId: input.runId ?? randomUUID(),
    ...(input.decision ? { decision: input.decision } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.report !== undefined ? { report: input.report } : {}),
    diagnostics: stopDescriptor ? [envelopeDiagnostic(stopDescriptor)] : reported,
    nextActions: input.nextActions ?? [],
    ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    ...(input.replayOf ? { replayOf: input.replayOf } : {}),
  };
}

export function envelopeExitCode(envelope: Pick<Envelope, 'operationStatus' | 'decision' | 'outcome'>): EnvelopeExitCode {
  return exitCodeFor(envelope.operationStatus, envelope.decision ?? null, envelope.outcome ?? null);
}
