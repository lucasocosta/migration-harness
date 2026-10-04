import { findCommand } from '../help.js';
import type { SessionDecision } from './envelope.js';

/**
 * `nextActions` (PLAN-V2 §3.1): one structured recommendation per entry — operation, arguments,
 * preconditions and the explicit kind of authorization the action needs. Hard rules enforced here,
 * not by documentation:
 * - operations come from a fixed migration-flow allowlist (the six v2 commands), so a
 *   recommendation can never become arbitrary shell derived from runtime, and a retired
 *   compatibility command can never be recommended;
 * - argument names must be flags that operation actually registers, and values are plain scalars
 *   free of shell metacharacters or newlines;
 * - `requiresApproval` is one of exactly three values: `automatic` (safe to run now),
 *   `after_correction` (run once the stated precondition is fixed) or `requires_authorization`
 *   (an explicit human/owner authorization flag must be supplied);
 * - `REVIEW_REFERENCE` or any reference that is not `VERIFIED` never authorizes a reference
 *   adoption (`--owner-decision`), and adoption always requires `requires_authorization`;
 * - no operation edits the candidate: repair is agent work between verifications (§3), and an
 *   ambiguous cause is answered with a diagnostic operation, never with an edit.
 */
export const REQUIRES_APPROVAL = ['automatic', 'after_correction', 'requires_authorization'] as const;
export type RequiresApproval = (typeof REQUIRES_APPROVAL)[number];

/** The migration flow only: the six v2 operations. Retired compatibility commands are not members. */
export const NEXT_OPERATIONS: ReadonlySet<string> = new Set([
  'init', 'doctor', 'prepare', 'verify', 'status', 'reference',
]);

/** Structured precondition codes: uppercase tokens, never prose or shell fragments. */
const PRECONDITION = /^[A-Z][A-Z0-9_]*$/;
/** Shell metacharacters and line breaks are refused in argument values: args are data, not commands. */
const SHELL_METACHARACTERS = /[;&|`$<>\n\r]/;

export interface NextAction {
  readonly operation: string;
  readonly args: Readonly<Record<string, string | boolean>>;
  readonly preconditions: readonly string[];
  readonly requiresApproval: RequiresApproval;
}

export interface NextActionInput {
  operation: string;
  args?: Record<string, string | boolean>;
  preconditions: string[];
  requiresApproval: string;
}

const invalid = (message: string): Error => new Error(`INVALID_NEXT_ACTION: ${message}`);

function registeredFlags(operation: string): ReadonlySet<string> {
  const entry = findCommand(operation);
  if (!entry) throw invalid(`unknown operation "${operation}"`);
  return new Set(entry.flags.map(flag => flag.name));
}

export function buildNextAction(input: NextActionInput): NextAction {
  if (!NEXT_OPERATIONS.has(input.operation)) throw invalid(`operation "${input.operation}" is not part of the migration flow`);
  if (!REQUIRES_APPROVAL.includes(input.requiresApproval as RequiresApproval)) {
    throw invalid(`requiresApproval must be one of ${REQUIRES_APPROVAL.join('|')}`);
  }
  if (!input.preconditions.length || input.preconditions.some(item => !PRECONDITION.test(item))) {
    throw invalid('preconditions must be non-empty structured codes');
  }
  const flags = registeredFlags(input.operation);
  const args: Record<string, string | boolean> = {};
  for (const [name, value] of Object.entries(input.args ?? {})) {
    if (!flags.has(name)) throw invalid(`${input.operation} does not register ${name}`);
    if (typeof value === 'boolean') {
      if (value !== true) throw invalid(`boolean flag ${name} is only ever recommended as enabled`);
    } else if (typeof value !== 'string' || !value.length || SHELL_METACHARACTERS.test(value)) {
      throw invalid(`${name} must be a plain scalar without shell metacharacters`);
    }
    args[name] = value;
  }
  const adoption = input.operation === 'reference' && args['--owner-decision'] !== undefined;
  if (adoption && input.requiresApproval !== 'requires_authorization') {
    throw invalid('reference adoption always requires explicit owner authorization');
  }
  return { operation: input.operation, args, preconditions: [...input.preconditions], requiresApproval: input.requiresApproval as RequiresApproval };
}

export interface NextActionContext {
  decision?: SessionDecision | undefined;
  /** Session reference status; anything other than VERIFIED blocks adoption recommendations. */
  referenceStatus?: string | undefined;
}

/** Validate a recommendation list against the session context; violations throw instead of shipping. */
export function buildNextActions(inputs: readonly NextActionInput[], context: NextActionContext = {}): NextAction[] {
  const reviewPending = context.decision === 'REVIEW_REFERENCE'
    || (context.referenceStatus !== undefined && context.referenceStatus !== 'VERIFIED');
  return inputs.map(input => {
    const action = buildNextAction(input);
    if (reviewPending && action.operation === 'reference' && action.args['--owner-decision'] !== undefined) {
      throw invalid('REVIEW_REFERENCE or an unverified reference never authorizes reference adoption');
    }
    return action;
  });
}
