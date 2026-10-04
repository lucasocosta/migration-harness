import { PRIVATE_STATE_FRAGMENT, fileHash, screenPatchContent } from '@migration-harness/core';

/**
 * Single source of truth for every CLI error code: `docs/reference/errors.md` is generated from
 * `ERROR_CATALOG`, and the `--json` envelope is a verbatim projection of one resolved entry.
 *
 * Categories answer "who must act"; `cause` answers "why it happened"; `action` answers "what to do
 * next"; `retryable` says whether re-running the same invocation can succeed unchanged. Messages
 * never carry stack traces, private-domain paths, pseudonymized trace tokens or trace payloads.
 */
export type ErrorCategory = 'INPUT' | 'CONFIGURATION' | 'AUTHORIZATION' | 'STATE' | 'ENVIRONMENT' | 'EXECUTION' | 'INTERNAL' | 'UNCLASSIFIED';

export interface ErrorDescriptor {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly cause: string;
  readonly action: string;
  readonly retryable: boolean;
}

/** code, category, cause, action, retryable */
type CatalogRow = readonly [string, ErrorCategory, string, string, boolean];

const CATALOG_ROWS: readonly CatalogRow[] = [
  // --- input: the invocation itself (flags, files, encoding) ---
  ['MISSING_FLAG', 'INPUT', 'A flag required by this command was not provided.', 'Re-run with the flag named after "Required flag"; `<command> --help` lists required flags.', false],
  ['INVALID_FLAG', 'INPUT', 'A flag value is not valid for its option.', 'Correct the value named after "Invalid --"; see `<command> --help` for the accepted range.', false],
  ['UNKNOWN_OPTION', 'INPUT', 'The option is not recognized by this command.', 'Remove it or check the spelling against `<command> --help`.', false],
  ['UNKNOWN_COMMAND', 'INPUT', 'The invoked command does not exist.', 'Run `harness help` (or `harness --help`) for the full command list.', false],
  ['INVALID_JSON', 'INPUT', 'An input file is not valid JSON.', 'Fix or regenerate the file; the parser reports the position, never the content.', false],
  ['INVALID_INPUT', 'INPUT', 'An input document failed schema validation.', 'Fix the fields named in the cause; the schema is the contract for that document type.', false],
  ['INPUT_FILE_MISSING', 'INPUT', 'A referenced input file does not exist.', 'Create the file or point the flag at an existing path.', false],
  ['INPUT_FILE_UNREADABLE', 'INPUT', 'The input file cannot be read with the current permissions.', 'Fix the file permissions or run as the owner of that file.', false],
  ['INPUT_FILE_INVALID', 'INPUT', 'The input path is not a regular, usable file.', 'Point the flag at a regular file of the expected kind.', false],
  ['INPUT_FILE_SYMLINK', 'INPUT', 'The input resolves through a symlink, which the boundary refuses.', 'Pass the resolved real path; symlinks are never accepted at the read boundary.', false],
  ['INPUT_FILE_CHANGED', 'INPUT', 'The input file changed while it was being read.', 'Stop concurrent writers and re-run against stable inputs.', true],
  ['INPUT_FILE_NOT_JSON', 'INPUT', 'The input file does not contain JSON.', 'Provide a JSON document at that path.', false],
  ['OUTPUT_EXISTS', 'INPUT', 'The destination already exists; outputs are created exclusively.', 'Remove or rename the destination, or choose another --out path.', false],
  ['PRIVATE_PATH_REFUSED', 'INPUT', 'A path points into the private artifact domain or the private state directory.', 'Use a public path outside `.migration-private` and the private state root; see docs/OS-PORTABILITY.md.', false],
  ['UNSAFE_SYMLINK', 'INPUT', 'A symlink crosses a boundary the harness requires to be a real path.', 'Pass the resolved real path and keep symlinks out of artifact, reference and scope roots.', false],
  ['PRIVACY_SCREENING_REFUSAL', 'INPUT', 'Privacy screening refused the content: a pseudonymized token, a trace-derived value or a private-domain path.', 'Derive behavior from the source unit, never from observed data; drop the token or path.', false],

  // --- configuration: the migration/session setup the caller declares ---
  ['MISSING_PREPARATION_PATH', 'CONFIGURATION', 'The preparation path argument was not provided.', 'Provide `preparationPath`: the artifact written by prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir>.', false],
  ['STANDARD_PROFILE_REQUIRED', 'CONFIGURATION', 'The operation requires profile: standard in the configuration.', 'Set profile: standard in the configuration; prepare/verify/status/reference refuse any other profile.', false],
  ['STANDARD_SESSION_REQUIRED', 'CONFIGURATION', 'The operation requires an existing standard session.', 'Run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> to open the session, then retry the operation.', false],
  ['STANDARD_SESSION_PROFILE_REQUIRED', 'CONFIGURATION', 'A standard session already owns this migration; sessionless inputs are refused.', 'Drop the sessionless `preparationPath`/`artifactPath` inputs and let the session own reference, output and budget.', false],
  ['STANDARD_SESSION_OWNS_REFERENCE_AND_OUTPUT', 'CONFIGURATION', 'The session owns reference and output, so sessionless inputs were refused.', 'Drop the sessionless `preparationPath`/`artifactPath` inputs and run verify --config <migration.json> --workspace-root <dir>.', false],
  ['UNSAFE_WRITE_SCOPE', 'CONFIGURATION', 'target.writePaths contains an opaque path or a non-writable directory.', 'Declare concrete, relative, writable paths in target.writePaths.', false],
  ['UNSAFE_SCOPE_ROOT', 'CONFIGURATION', 'A source/target root is a symlink or does not resolve to itself.', 'Use a real directory as the root; do not link the workspace roots.', false],
  ['UNSAFE_OPERATION_OUTPUT', 'CONFIGURATION', 'The artifact output would overlap source, target, fixtures or the critical contract.', 'Choose an --artifact-path outside every declared project input.', false],
  ['UNSAFE_SUITE_OUTPUT', 'CONFIGURATION', 'The capture suite output would overlap source, target or fixture inputs.', 'Choose an artifact root outside every declared project input.', false],
  ['UNSAFE_INITIAL_WRITE_SCOPE', 'CONFIGURATION', 'The initial target write scope is not exactly the declared one.', 'Reconcile target.writePaths with the filesystem before starting the session.', false],
  ['UNSAFE_REFERENCE_UPDATE_SCOPE', 'CONFIGURATION', 'A reference update would leave the declared write scope.', 'Keep the update inside target.writePaths, or escalate to an owner decision.', false],
  ['EVALUATION_INPUT_IN_WRITE_SCOPE', 'CONFIGURATION', 'target.writePaths covers fixtures or the critical contract.', 'Remove evaluation inputs from target.writePaths so candidates cannot edit them.', false],
  ['PRIVATE_WORKSPACE', 'CONFIGURATION', 'The workspace sits inside the private artifact domain.', 'Move the workspace outside the private domain; the harness never operates there.', false],
  ['INVALID_PSEUDONYMIZATION_KEY', 'CONFIGURATION', 'The pseudonymization key is missing, too short or malformed.', 'Supply a 32-byte hex key, or let the harness create one in the private store.', false],
  ['ENCRYPTION_REQUIRED', 'CONFIGURATION', 'The operation needs an encryption-enabled private store.', 'Use a private store created with encryption enabled; the harness never widens permissions implicitly.', false],
  ['KEY_PRUNING_DISABLED', 'CONFIGURATION', 'Automatic key pruning is disabled because retained copies may still need old key versions.', 'Retire the retained copies that still need an old key version first; pruning stays off until none does.', false],
  ['STATE_DECLARATION_INVALID', 'CONFIGURATION', 'A declared state capture or probe is malformed or unresolved.', 'Fix the declaration named in the cause; declarations are configuration, not observations.', false],

  // --- state: persisted harness/session/artifact state that failed a check ---
  ['ARTIFACT_NOT_FRESH', 'STATE', 'The artifact directory already exists from another run.', 'Choose a fresh --artifact-path; outputs are never reused or overwritten.', false],
  ['OUTSIDE_WRITE_SCOPE', 'STATE', 'The workspace changed outside the declared target write scope, so the session refused the attempt.', 'Move the change inside target.writePaths (or reconcile the scope with the owner), then retry.', false],
  ['PREPARATION_HASH_MISMATCH', 'STATE', 'The preparation artifact does not match its own reference hash.', 'Re-run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> to produce a consistent preparation artifact.', false],
  ['KEY_MISMATCH', 'STATE', 'The stored private key does not match the preparation that used it.', 'Use the same private store as the preparation, or re-prepare with this store.', false],
  ['PRIVATE_KEY_UNAVAILABLE', 'STATE', 'The private pseudonymization key is missing or not private enough.', 'Restore the key from the private store, or re-prepare in an environment that owns it.', false],
  ['ARTIFACT_AUTH_FAILURE', 'STATE', 'A stored artifact failed its seal or integrity check.', 'Treat the artifact as tampered: restore it or re-capture; do not hand-edit sealed files.', false],
  ['AUDIT_CHAIN_CORRUPT', 'STATE', 'The audit hash chain fails verification.', 'Restore the audit file from a trusted copy or rebuild it from a known head; never hand-edit.', false],
  ['SESSION_ALREADY_EXISTS', 'STATE', 'A session already exists for this source/target pair.', 'Inspect it with status --config <migration.json> --workspace-root <dir>; sessions are never reset by starting again.', false],
  ['SESSION_DATA_INVALID', 'STATE', 'A session file is not a valid session record.', 'Repair the session store from a trusted copy, or escalate for human recovery.', false],
  ['SESSION_DATA_CHANGED', 'STATE', 'A session file changed while it was being read.', 'Stop concurrent harness runs against this session and retry once.', true],
  ['SESSION_HISTORY_INVALID', 'STATE', 'The recorded attempt history does not chain consistently.', 'Escalate for human recovery of the session store; never reset history to bypass it.', false],
  ['SESSION_REPORT_INVALID', 'STATE', 'A recorded attempt report does not match its hash or outcome.', 'Escalate for human recovery; the recorded result cannot be trusted as-is.', false],
  ['SESSION_GENERATIONS_INVALID', 'STATE', 'The session generation ledger failed verification.', 'Escalate for human recovery of the session store.', false],
  ['SESSION_INPUT_MISMATCH', 'STATE', 'The submitted configuration does not match the session that owns it.', 'Use the configuration the session was started with, or update the reference explicitly.', false],
  ['SESSION_LIMITS_IMMUTABLE', 'STATE', 'Session attempt/time budgets cannot change after start.', 'Keep limits as declared; a new migration needs a new session, not bigger budgets.', false],
  ['SESSION_PAIR_CHANGED', 'STATE', 'The source/target pair changed after the session started.', 'Keep the pair fixed; a different pair is a different migration.', false],
  ['SESSION_PATH_UNSAFE', 'STATE', 'The session store path is a symlink or otherwise unsafe.', 'Remove the symlink and restore a real directory as the session store.', false],
  ['SESSION_OVERLAPS_PROJECT_INPUTS', 'STATE', 'The session store overlaps source, target, fixtures or contract paths.', 'Move the session store outside every declared project input.', false],
  ['SESSION_ATTEMPT_OPEN', 'STATE', 'A previous attempt never recorded its finish.', 'Inspect the session; an open attempt must be finished or recovered before a new one.', false],
  ['SESSION_REFERENCE_NOT_VERIFIED', 'STATE', 'The session reference no longer verifies against the evidence.', 'Re-prepare to establish a fresh, verifiable reference.', false],
  ['SESSION_REFERENCE_UPDATE_INCONCLUSIVE', 'STATE', 'The proposed reference update could not be verified.', 'Collect the missing evidence and propose the update again.', true],
  ['SCOPE_ROOT_MISMATCH', 'STATE', 'The observed scope roots differ from the recorded baseline.', 'Reconcile the roots with the baseline, or start a new migration for the new layout.', false],
  ['SCOPE_SIZE_LIMIT', 'STATE', 'The workspace scope exceeds the entry/byte budget for a snapshot.', 'Exclude generated content from scope, or raise the declared scope with the owner.', false],
  ['SCOPE_HARD_LINK', 'STATE', 'A scoped file has hard links, so its identity cannot be pinned.', 'Break the hard links before verifying; scope entries must have nlink 1.', false],
  ['SCOPE_CHANGED_DURING_READ', 'STATE', 'Files changed while the scope snapshot was being read.', 'Quiesce writers and re-run once; a moving scope cannot be fingerprinted.', true],
  ['UNSUPPORTED_SCOPE_ENTRY', 'STATE', 'The workspace contains a scope entry kind that is not a file or directory.', 'Remove the special entry (socket/device) from the declared workspace scope.', false],
  ['REFERENCE_COVERAGE_MISMATCH', 'STATE', 'The prepared reference does not cover every scenario/run the config declares.', 'Re-run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> so coverage matches the configuration.', false],
  ['REFERENCE_EVIDENCE_CHANGED', 'STATE', 'A prepared reference trace no longer matches its recorded hash.', 'Re-prepare; prepared evidence is immutable and must not be edited in place.', false],
  ['REFERENCE_STATE_EVIDENCE_CHANGED', 'STATE', 'A prepared reference state snapshot no longer matches its record.', 'Re-prepare; state evidence is immutable once the reference is built.', false],
  ['REFERENCE_STATE_EVIDENCE_INCOMPLETE', 'STATE', 'A prepared reference state pin is incomplete.', 'Re-prepare with complete state evidence, or drop the incomplete pin from the config.', false],
  ['EVIDENCE_CHANGED', 'STATE', 'An evidence file changed while it was being read.', 'Stop concurrent writers and re-run against stable evidence.', true],
  ['EVIDENCE_UNAVAILABLE', 'STATE', 'An evidence file is missing, linked or over the size cap.', 'Provide a regular evidence file within the cap.', false],
  ['STATE_CLAIMS_INVALID', 'STATE', 'Declared state claims are malformed.', 'Fix the claim records; claims are declarations, never observations.', false],
  ['STATE_EVIDENCE_INVALID', 'STATE', 'State snapshot evidence is malformed or incomplete.', 'Re-capture state evidence; incomplete evidence can never become a PASS.', false],
  ['BASELINE_MISMATCH', 'STATE', 'The build identity does not match the recorded baseline.', 'Rebuild from the declared inputs, or re-prepare if the baseline legitimately changed.', false],
  ['SUITE_UNAVAILABLE', 'STATE', 'The capture suite could not run or failed before producing evidence.', 'Fix the failure named in the cause (builds, serve, browser) and re-run.', true],

  // --- authorization: only a human/owner or an explicit flag can unblock these ---
  ['EXECUTION_NOT_AUTHORIZED', 'AUTHORIZATION', 'Project commands were not authorized for this invocation.', 'Add --allow-project-commands in an authorized local environment, or run doctor --config <migration.json> --workspace-root <dir>, which inspects the environment without executing project commands.', false],
  ['REFERENCE_CHANGE_REQUIRES_OWNER_DECISION', 'AUTHORIZATION', 'The reference change weakens evaluation criteria.', 'Ask the owner for a decision and re-run reference --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> with --owner-decision <reference>; never weaken silently.', false],
  ['SESSION_REFERENCE_UPDATE_OUT_OF_SCOPE', 'AUTHORIZATION', 'The requested reference update leaves the authorized scope.', 'Restrict the update to the authorized scope, or escalate to the owner.', false],
  ['SESSION_SCOPE_EXPANSION_NOT_AUTHORIZED', 'AUTHORIZATION', 'The update would expand the target write scope.', 'Get explicit owner authorization before expanding target.writePaths.', false],
  ['SESSION_SCOPE_CHANGED_DURING_UPDATE', 'AUTHORIZATION', 'The observed scope changed while the update was being adopted.', 'Quiesce writers and propose the update again.', true],

  // --- environment: host, ports, servers, browser, filesystem ---
  ['PORT_IN_USE', 'ENVIRONMENT', 'A declared port is already occupied.', 'Free the port or change it in the configuration, then retry.', true],
  ['SERVER_START_FAILED', 'ENVIRONMENT', 'The serve command failed to start.', 'Check the serve command in the configuration and start it manually to see the failure.', true],
  ['SERVER_READY_TIMEOUT', 'ENVIRONMENT', 'The served application did not become ready in time.', 'Raise the readiness window or fix startup cost, then retry.', true],
  ['SERVER_EXITED_EARLY', 'ENVIRONMENT', 'The served process exited before readiness.', 'Inspect the serve command output; the exit code is reported without child logs.', true],
  ['SERVE_CONFIG_INVALID', 'ENVIRONMENT', 'The serve declaration is invalid.', 'Fix the serve command fields in the configuration.', false],
  ['SERVE_COMMAND_INVALID', 'ENVIRONMENT', 'The serve executable or working directory is unusable.', 'Fix the serve argv/cwd; the harness runs commands by argv, never through a shell.', false],
  ['SERVING_CONFIG_MISSING', 'ENVIRONMENT', 'The side being served declares no serve command.', 'Add a serve command for that side in the configuration.', false],
  ['UNSAFE_BUILD_DIRECTORY', 'ENVIRONMENT', 'A build output directory is a symlink, overlapping or unsafe.', 'Point builds at a real, dedicated output directory.', false],
  ['BUILD_CHECK_FAILED', 'ENVIRONMENT', 'A declared build or check command failed.', 'Fix the failing command; its exit status is reported without raw output.', true],
  ['BUILD_OUTPUT_MISSING', 'ENVIRONMENT', 'The build produced no usable output.', 'Verify the build command and the output directory it writes to.', false],
  ['BUILD_OUTPUT_UNSAFE', 'ENVIRONMENT', 'Build output contains unsafe entries (links, oversize or key-like files).', 'Clean the output directory; only regular files of bounded size are accepted.', false],
  ['BUILD_OUTPUT_TOO_LARGE', 'ENVIRONMENT', 'Build output exceeds the size budget.', 'Exclude generated bulk from the output, or split the build.', false],
  ['BUILD_INPUT_CHANGED', 'ENVIRONMENT', 'Build inputs changed while the build was running.', 'Quiesce writers and rebuild; a moving input set cannot be fingerprinted.', true],
  ['BUILD_DISK_CHANGED', 'ENVIRONMENT', 'The build directory changed on disk during the run.', 'Quiesce other tooling touching the build directory and retry.', true],
  ['HEALTHCHECK_FAILED', 'ENVIRONMENT', 'The application failed its readiness health check.', 'Verify the served URL answers on the declared port before re-running.', true],
  ['SYSTEM_ERROR', 'ENVIRONMENT', 'A system call or network operation failed.', 'Check the errno in the cause (dependency reachable, resources available) and retry.', true],
  ['FILESYSTEM_ERROR', 'ENVIRONMENT', 'A filesystem operation failed.', 'Check permissions, free space and the path in the cause, then retry.', false],
  ['BOOT_FAILED', 'ENVIRONMENT', 'The browser could not boot for a capture.', 'Verify Chromium availability for this environment; see docs/OS-PORTABILITY.md.', true],
  ['SUITE_PREFLIGHT_FAILED', 'ENVIRONMENT', 'Project preflight failed before any capture ran.', 'Run doctor --config <migration.json> --workspace-root <dir> to see which declared input is not ready; it executes no project command.', false],

  // --- execution: the run itself was interrupted, incomplete or divergent ---
  ['ABORTED', 'EXECUTION', 'The run was interrupted by a signal.', 'Re-run when the environment is quiet; budgets already spent stay spent.', true],
  ['BUDGET_EXHAUSTED', 'EXECUTION', 'The session attempt or active-time budget is exhausted, so the session stopped.', 'Stop for a human decision; budgets are immutable and are never reset silently.', false],
  ['NO_PROGRESS_STOP', 'EXECUTION', 'Repeated identical failures stopped the session before it consumed the whole budget.', 'Investigate the repeated failure before another attempt; a stopped session never restarts by itself.', false],
  ['SESSION_TIMEOUT', 'EXECUTION', 'The session ran out of its active-time budget.', 'Stop for a human decision; budgets are immutable and never reset silently.', false],
  ['CAPTURE_ABORTED', 'EXECUTION', 'The capture was aborted before completing.', 'Re-run the capture once the interruption cause is gone.', true],
  ['CAPTURE_INCOMPLETE', 'EXECUTION', 'The capture finished without recording every declared step.', 'Re-run the scenario; incomplete evidence can never become a PASS.', true],
  ['CAPTURE_UNAVAILABLE', 'EXECUTION', 'A prepared capture is unavailable for the current identity.', 'Re-run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> so reference captures match the current build identity.', true],
  ['CAPTURE_MISMATCH', 'EXECUTION', 'A capture does not match its recorded identity or step list.', 'Investigate the identity mismatch before trusting any comparison result.', false],
  ['STEP_FAILED', 'EXECUTION', 'A scenario step failed.', 'Fix the application or the scenario; the failing step id is reported.', true],
  ['COMPLETION_FAILED', 'EXECUTION', 'The scenario did not reach its completion state.', 'Fix the application flow or the scenario definition, then re-run.', true],
  ['BUILD_IDENTITY_MISMATCH', 'EXECUTION', 'The served build does not match the expected build identity.', 'Rebuild both sides from the declared inputs and re-run.', false],
  ['SERVED_BUILD_MISMATCH', 'EXECUTION', 'The served build does not match the expected build identity.', 'Rebuild both sides from the declared inputs and re-run.', false],

  // --- internal: anything outside the published catalog ---
  ['UNEXPECTED_ERROR', 'INTERNAL', 'An unexpected failure outside the published catalog.', 'Inspect the cause (already sanitized), re-run once if it looks transient, otherwise report this code.', false],
  ['UNCLASSIFIED', 'UNCLASSIFIED', 'The harness reported a code that is not in the published catalog.', 'Report the invocation and this code; docs/reference/errors.md lists every published code.', false],
];

export const ERROR_CATALOG: Readonly<Record<string, ErrorDescriptor>> = Object.freeze(Object.fromEntries(
  CATALOG_ROWS.map(([code, category, cause, action, retryable]): readonly [string, ErrorDescriptor] => [code, Object.freeze({ code, category, cause, action, retryable })]),
));

/** Every catalogued code, alphabetically — the order used by docs/reference/errors.md. */
export function catalogCodes(): string[] { return Object.keys(ERROR_CATALOG).sort(); }

/** A resolved error: `cause` is the catalog entry, extended with the sanitized detail when it adds information. */
export class DiagnosticError extends Error {
  constructor(readonly diagnostic: ErrorDescriptor) {
    super(`${diagnostic.code}: ${diagnostic.cause}`);
    this.name = 'DiagnosticError';
  }
}

const SCREAMING = /^[A-Z][A-Z0-9_]+$/;
const PSEUDONYM = /p_[0-9a-f]{24}/g;
const PRIVATE_MARKERS = ['.migration-private', 'migration-harness-private', PRIVATE_STATE_FRAGMENT];
const escapeForRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PRIVATE_PATH = new RegExp(`(?:[A-Za-z]:)?[^\\s'"\\x60()\\[\\]]*?(?:${PRIVATE_MARKERS.map(escapeForRegex).join('|')})(?:[\\\\/][^\\s'"\\x60()\\[\\]]*)*`, 'g');

/** Strip stack frames, clip, redact private-domain paths and pseudonyms, then re-screen the result. */
function sanitizeDetail(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const clipped = firstLine.length > 600 ? `${firstLine.slice(0, 597)}...` : firstLine;
  const redacted = clipped.replace(PSEUDONYM, '<pseudonym>').replace(PRIVATE_PATH, '<private-path>');
  const refusals = screenPatchContent([{ path: '<diagnostic>', beforeHash: fileHash(''), content: redacted }]);
  if (!refusals.length) return redacted;
  const codes = [...new Set(refusals.map(refusal => refusal.code))].sort().join(', ');
  return `<detail withheld by privacy screening: ${codes}>`;
}

/** Zod failures are multi-line JSON: surface only path+message pairs (never raw values), screened and clipped. */
function schemaDetail(error: Error): string {
  const issues = (error as unknown as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return '';
  const summary = issues.slice(0, 4).map(issue => {
    const record = issue as { path?: unknown; message?: unknown };
    const path = Array.isArray(record.path) && record.path.length ? `${record.path.join('.')}: ` : '';
    return `${path}${typeof record.message === 'string' ? record.message : 'invalid value'}`;
  }).join('; ');
  return summary ? sanitizeDetail(`schema issues: ${summary}`) : '';
}

const ERRNO_CODES: Record<string, string> = {
  ENOENT: 'INPUT_FILE_MISSING',
  EACCES: 'INPUT_FILE_UNREADABLE',
  EPERM: 'INPUT_FILE_UNREADABLE',
  ELOOP: 'INPUT_FILE_SYMLINK',
  EEXIST: 'OUTPUT_EXISTS',
  ENOTDIR: 'INPUT_FILE_INVALID',
  EISDIR: 'INPUT_FILE_INVALID',
  ENAMETOOLONG: 'INPUT_FILE_INVALID',
};

/** Message shapes shared by every package: prose is preserved as the cause instead of being swallowed. */
const MESSAGE_RULES: readonly (readonly [RegExp, string])[] = [
  [/^Required flag --\S+ is missing\./, 'MISSING_FLAG'],
  [/^Invalid --\S+\.$/, 'INVALID_FLAG'],
  [/private root|private artifact domain|private artifact filesystem|private state/i, 'PRIVATE_PATH_REFUSED'],
  [/symlink/i, 'UNSAFE_SYMLINK'],
  [/audit chain is corrupt|chain (?:is |fails to )?(?:verify|corrupt)/i, 'AUDIT_CHAIN_CORRUPT'],
  [/^Key rotation requires an encryption-enabled store/, 'ENCRYPTION_REQUIRED'],
  [/^Automatic key pruning is disabled/, 'KEY_PRUNING_DISABLED'],
  [/^Patch content (embeds|references)/, 'PRIVACY_SCREENING_REFUSAL'],
];

function resolve(code: string, detail?: string): ErrorDescriptor {
  // Sanitization happens here, once, on every path: a detail can come from a thrown message, a
  // schema issue or an argv value, and none of them may reach stderr or the envelope unscreened.
  const safe = detail ? sanitizeDetail(detail) : undefined;
  const entry = ERROR_CATALOG[code];
  if (!entry) {
    const fallback = ERROR_CATALOG['UNCLASSIFIED']!;
    const suffix = safe && safe !== code ? ` | ${safe}` : '';
    return { ...fallback, code, cause: `${fallback.cause}${suffix}` };
  }
  if (!safe || safe === code || safe === entry.cause) return entry;
  return { ...entry, cause: `${entry.cause} | ${safe}` };
}

/**
 * Turn any thrown value into a catalogued, privacy-screened descriptor. Coded failures keep their
 * code; prose failures keep their message as the cause; anything else becomes UNEXPECTED_ERROR.
 */
export function diagnose(error: unknown): ErrorDescriptor {
  if (error instanceof DiagnosticError) return error.diagnostic;
  if (!(error instanceof Error)) return resolve('UNEXPECTED_ERROR', sanitizeDetail(String(error)));
  if (error.name === 'ReferenceWeakeningError') return resolve('REFERENCE_CHANGE_REQUIRES_OWNER_DECISION');
  if (error.name === 'StateDeclarationError') return resolve('STATE_DECLARATION_INVALID', sanitizeDetail(error.message));
  if (error.name === 'ZodError') return resolve('INVALID_INPUT', schemaDetail(error));
  if (error instanceof SyntaxError) return resolve('INVALID_JSON');

  const raw = (error as NodeJS.ErrnoException).code;
  if (raw === 'ABORT_ERR') return resolve('ABORTED');
  if (raw && raw in ERRNO_CODES) return resolve(ERRNO_CODES[raw]!, sanitizeDetail(error.message));
  if (raw?.startsWith('ERR_PARSE_ARGS_UNKNOWN_OPTION')) return resolve('UNKNOWN_OPTION', sanitizeDetail(error.message));
  if (raw?.startsWith('ERR_PARSE_ARGS_')) return resolve('INVALID_FLAG', sanitizeDetail(error.message));
  if (raw && /^E[A-Z]+$/.test(raw) && raw.length <= 16) return resolve('SYSTEM_ERROR', sanitizeDetail(error.message));

  const message = error.message;
  const code = raw && SCREAMING.test(raw) ? raw
    : SCREAMING.test(message) ? message
      : /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
  const known = code !== undefined && code !== 'UNEXPECTED_ERROR' && (ERROR_CATALOG[code] !== undefined || raw === code);
  if (code !== undefined && known) {
    const detail = message === code ? undefined
      : message.startsWith(`${code}:`) ? sanitizeDetail(message.slice(code.length + 1))
        : sanitizeDetail(message);
    return resolve(code, detail);
  }
  for (const [pattern, mapped] of MESSAGE_RULES) {
    if (pattern.test(message)) return resolve(mapped, sanitizeDetail(message));
  }
  return resolve('UNEXPECTED_ERROR', sanitizeDetail(message));
}

/** Wrap any thrown value so the failure crosses module boundaries with its catalogued shape intact. */
export function toDiagnosticError(error: unknown): DiagnosticError {
  return new DiagnosticError(diagnose(error));
}

/** Build a failure from a catalog code plus an optional sanitized detail (used for CLI-raised codes). */
export function diagnosticError(code: string, detail?: string): DiagnosticError {
  return new DiagnosticError(resolve(code, detail));
}

/** Text rendering: code, cause, category/retryable and the recommended action — never a stack. */
export function formatDiagnostic(diagnostic: ErrorDescriptor): string {
  return `ERROR ${diagnostic.code}: ${diagnostic.cause}\n  category: ${diagnostic.category} | retryable: ${diagnostic.retryable ? 'yes' : 'no'}\n  action: ${diagnostic.action}`;
}

/** The `--json` envelope: exactly { ok: false, error: { code, category, cause, action, retryable } }. */
export function errorEnvelope(diagnostic: ErrorDescriptor): { ok: false; error: { code: string; category: ErrorCategory; cause: string; action: string; retryable: boolean } } {
  return { ok: false, error: { code: diagnostic.code, category: diagnostic.category, cause: diagnostic.cause, action: diagnostic.action, retryable: diagnostic.retryable } };
}
