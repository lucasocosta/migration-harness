import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { migrationConfigHash, parseMigrationConfig, parseMigrationReport, type MigrationConfig } from '@migration-harness/core';
import {
  ArtifactStore, disposition, inspectMigrationSession, migrationSessionPath, preflightMigration,
  prepareMigration, startMigrationSession, updateMigrationSessionReference, verifyMigrationSession,
} from '@migration-harness/engine';
import { readPublicJson } from '../assistant-files.js';
import { diagnose, diagnosticError, ERROR_CATALOG, type ErrorDescriptor } from '../errors.js';
import { findCommand } from '../help.js';
import { MISSING_DECISIONS, minimalConfig } from './init-config.js';
import {
  buildEnvelope, envelopeDiagnostic, envelopeExitCode, type Envelope, type EnvelopeDiagnostic,
  type EnvelopeInput, type EnvelopeOutcome, type SessionDecision,
} from './envelope.js';
import { buildNextActions, type NextAction, type NextActionInput } from './next-actions.js';
import {
  applyPrivacyPolicy, PRIVACY_ENV, PrivacyPolicyConflictError, resolvePrivacyPolicy,
  type EffectivePrivacyPolicy,
} from './privacy.js';
import { inspectOccupiedArtifact, requestKeyFor, type ArtifactOccupancy, type RequestIdentity } from './request.js';

/**
 * The six CLI v2 commands (PLAN-V2 §3): `init → doctor → prepare → (agent edits) → verify →
 * [reference | status]`. Every command maps onto existing engine operations — nothing here
 * reimplements the engine — and emits exactly one envelope in `--json` mode (§3.1). These six
 * commands are the whole CLI surface: the compatibility commands were retired by the kill switch,
 * so a retired name answers UNKNOWN_COMMAND and `nextActions` can only recommend a v2 operation.
 */
export type V2Command = 'init' | 'doctor' | 'prepare' | 'verify' | 'status' | 'reference';
export const V2_COMMAND_NAMES: readonly string[] = ['init', 'doctor', 'prepare', 'verify', 'status', 'reference'];
export function isV2Command(name: string): name is V2Command {
  return (V2_COMMAND_NAMES as readonly string[]).includes(name);
}

interface FailureOptions {
  /** Defaults to `refused`: a deliberate harness refusal. `failed` marks broken processing. */
  status?: 'refused' | 'failed';
  /** Session the refusal happened against; overrides the context's own session identity. */
  sessionId?: string;
  detail?: string;
  /** Safe flag/field name the refusal is bound to. */
  fieldPath?: string;
  nextActions?: NextActionInput[];
  nextContext?: { decision?: SessionDecision; referenceStatus?: string };
  report?: unknown;
}

/** A refusal/failure raised inside a v2 command: carries everything the envelope needs. */
class OperationFailure extends Error {
  readonly status: 'refused' | 'failed';
  constructor(readonly code: string, readonly failure: FailureOptions = {}) {
    super(failure.detail ? `${code}: ${failure.detail}` : code);
    this.name = 'OperationFailure';
    this.status = failure.status ?? 'refused';
  }
}

interface Context {
  command: V2Command;
  runId: string;
  values: Record<string, string | boolean>;
  signal: AbortSignal;
  workspaceRoot?: string;
  configPath?: string;
  config?: MigrationConfig;
  store?: ArtifactStore;
  sessionId?: string;
  requestKey?: string;
  replayOf?: string;
}

const pathExists = async (path: string): Promise<boolean> =>
  lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });

function flag(ctx: Context, name: string): string {
  const value = ctx.values[name];
  if (typeof value !== 'string' || !value) throw new OperationFailure('MISSING_FLAG', { detail: `Required flag --${name} is missing.`, fieldPath: `--${name}` });
  return value;
}

async function workspaceOf(ctx: Context): Promise<string> {
  ctx.workspaceRoot ??= resolve(flag(ctx, 'workspace-root'));
  return ctx.workspaceRoot;
}

async function storeOf(ctx: Context): Promise<ArtifactStore> {
  const workspace = await workspaceOf(ctx);
  ctx.store ??= new ArtifactStore(resolve(workspace, 'artifacts'));
  return ctx.store;
}

/** Read the configuration through the public-only reader; a schema failure names the offending field. */
async function loadConfig(ctx: Context): Promise<MigrationConfig> {
  if (ctx.config) return ctx.config;
  const store = await storeOf(ctx);
  ctx.configPath = resolve(flag(ctx, 'config'));
  const raw = await readPublicJson(ctx.configPath, store);
  try {
    ctx.config = parseMigrationConfig(raw);
  } catch (error) {
    const issues = (error as { issues?: { path?: unknown }[] }).issues;
    const first = Array.isArray(issues) ? issues[0] : undefined;
    const fieldPath = first && Array.isArray(first.path) && first.path.length ? first.path.join('.') : '--config';
    throw new OperationFailure('INVALID_INPUT', { status: 'refused', detail: 'schema issues: ' + (Array.isArray(issues) ? issues.slice(0, 4).map(issue => {
      const path = Array.isArray(issue.path) && issue.path.length ? `${issue.path.join('.')}: ` : '';
      return `${path}invalid value`;
    }).join('; ') : 'invalid document'), fieldPath });
  }
  return ctx.config;
}

/**
 * One privacy decision per operation (§3.1): resolve flag+env once, refuse a conflict without
 * widening permissions, then propagate so preflight, store and report cannot disagree (§9.1).
 */
function privacyOf(ctx: Context): EffectivePrivacyPolicy {
  let policy: EffectivePrivacyPolicy;
  try {
    policy = resolvePrivacyPolicy({
      allowInsecurePrivateStore: ctx.values['allow-insecure-private-store'] === true,
      env: process.env[PRIVACY_ENV],
    });
  } catch (error) {
    if (error instanceof PrivacyPolicyConflictError) {
      throw new OperationFailure('INVALID_FLAG', { detail: error.message, fieldPath: PRIVACY_ENV });
    }
    throw error;
  }
  applyPrivacyPolicy(policy);
  return policy;
}

/**
 * Outside profile standard the session flow refuses with no handover: the compatibility commands
 * it used to point at are gone, and a recommendation may only name a command that exists.
 */
function assertStandard(ctx: Context, config: MigrationConfig): void {
  if (config.profile === 'standard') return;
  throw new OperationFailure('STANDARD_PROFILE_REQUIRED', {
    detail: 'The CLI v2 prepare/verify/status/reference commands drive the standard session flow; this configuration does not declare profile standard.',
  });
}

/** Arguments of a recommended action, echoing this invocation's own flag values. */
function argsOf(ctx: Context, extra: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  return {
    ...(typeof ctx.values.config === 'string' ? { '--config': ctx.values.config } : {}),
    ...(typeof ctx.values['workspace-root'] === 'string' ? { '--workspace-root': ctx.values['workspace-root'] } : {}),
    ...extra,
  };
}

const statusAction = (ctx: Context): NextActionInput =>
  ({ operation: 'status', args: argsOf(ctx), preconditions: ['SESSION_EXISTS'], requiresApproval: 'automatic' });
const doctorAction = (ctx: Context, preconditions: string[], requiresApproval: string): NextActionInput =>
  ({ operation: 'doctor', args: argsOf(ctx), preconditions, requiresApproval });
const verifyAction = (ctx: Context, preconditions: string[], requiresApproval: string): NextActionInput =>
  ({ operation: 'verify', args: argsOf(ctx, { '--allow-project-commands': true }), preconditions, requiresApproval });
const prepareAction = (ctx: Context, artifactPath: string, preconditions: string[], requiresApproval: string): NextActionInput =>
  ({ operation: 'prepare', args: argsOf(ctx, { '--artifact-path': artifactPath, '--allow-project-commands': true }), preconditions, requiresApproval });
const referenceAction = (ctx: Context, artifactPath: string, preconditions: string[]): NextActionInput =>
  ({ operation: 'reference', args: argsOf(ctx, { '--artifact-path': artifactPath, '--allow-project-commands': true }), preconditions, requiresApproval: 'requires_authorization' });

/**
 * Engine/preflight diagnostics projected onto the single CLI catalog: `code` stays a published
 * code, the engine's own detailCode rides along as the screened cause (§3.1 "catálogo único").
 */
function engineDiagnostic(code: string, detailCode?: string, fieldPath?: string): EnvelopeDiagnostic {
  const specific = detailCode ?? code;
  const resolved = ERROR_CATALOG[specific] ? specific
    : specific === 'BROWSER_UNAVAILABLE' ? 'BOOT_FAILED'
      : ERROR_CATALOG[code] ? code
        : 'SUITE_PREFLIGHT_FAILED';
  // The engine's own code never disappears: it rides along as the screened cause of the published code.
  const detail = resolved !== specific ? specific : undefined;
  return envelopeDiagnostic(diagnosticError(resolved, detail).diagnostic, { ...(fieldPath ? { fieldPath } : {}) });
}

/** Attempt-level engine error codes projected onto the single catalog (detail keeps the engine code). */
const ATTEMPT_ERROR_CODES: Readonly<Record<string, string>> = {
  SESSION_TIME_LIMIT: 'SESSION_TIMEOUT',
  SESSION_VERIFICATION_FAILED: 'UNCLASSIFIED',
  CANDIDATE_CHANGED_DURING_VERIFICATION: 'UNCLASSIFIED',
};

const outcomeOf = (value: string | undefined): EnvelopeOutcome | undefined =>
  value === 'PASS' || value === 'FAIL' || value === 'INCONCLUSIVE' ? value : undefined;

/* ------------------------------------------------------------------ init */

async function commandInit(ctx: Context): Promise<EnvelopeInput> {
  const out = typeof ctx.values.out === 'string' && ctx.values.out ? ctx.values.out : 'migration.json';
  const migrationId = typeof ctx.values['migration-id'] === 'string' && ctx.values['migration-id'] ? ctx.values['migration-id'] : 'migration';
  const target = resolve(out);
  const config = minimalConfig(migrationId);
  try {
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, 'wx');
    try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new OperationFailure('OUTPUT_EXISTS', {
        detail: `A file already exists at ${out}; init never overwrites an existing configuration.`,
        fieldPath: '--out',
        nextActions: [{ operation: 'doctor', args: { '--config': out, '--workspace-root': '.' }, preconditions: ['CONFIG_WRITTEN'], requiresApproval: 'automatic' }],
      });
    }
    throw error;
  }
  return {
    operation: 'init',
    operationStatus: 'processed',
    report: { kind: 'MIGRATION_CONFIG_INIT', configPath: target, migrationId, missingDecisions: MISSING_DECISIONS },
    nextActions: buildNextActions([{
      operation: 'doctor',
      args: { '--config': out, '--workspace-root': '.' },
      preconditions: ['MISSING_DECISIONS_RESOLVED'],
      requiresApproval: 'after_correction',
    }]),
  };
}

/* ---------------------------------------------------------------- doctor */

async function commandDoctor(ctx: Context): Promise<EnvelopeInput> {
  const config = await loadConfig(ctx);
  const workspace = await workspaceOf(ctx);
  privacyOf(ctx);
  const preflight = await preflightMigration({ config, workspaceRoot: workspace, signal: ctx.signal });
  const diagnostics = preflight.diagnostics.map(item =>
    engineDiagnostic(item.code, item.detailCode, item.checkId ? `checks.${item.checkId}` : undefined));
  // PLAN-V2 §11.2 A1: a configuration without profile standard is schema-valid and the environment
  // is still inspectable, so this stays a FINDING (operation processed, outcome untouched, same exit
  // code) — but the next session command will refuse it, and doctor is where that must be said.
  if (config.profile !== 'standard') {
    diagnostics.push(envelopeDiagnostic(
      diagnosticError('STANDARD_PROFILE_REQUIRED',
        'the document is schema-valid, but prepare/verify/status/reference refuse it until it declares profile standard').diagnostic,
      { fieldPath: 'profile' }));
  }
  const nextActions: NextActionInput[] = preflight.status === 'PASS'
    ? [prepareAction(ctx, 'artifacts/prepared', ['ENVIRONMENT_READY', 'FRESH_ARTIFACT_PATH'], 'requires_authorization')]
    : [doctorAction(ctx, ['ENVIRONMENT_ISSUES_RESOLVED'], 'after_correction')];
  return {
    operation: 'doctor',
    operationStatus: 'processed',
    outcome: preflight.status,
    report: preflight,
    diagnostics,
    nextActions: buildNextActions(nextActions),
  };
}

/* --------------------------------------------------------------- prepare */

/** The structured refusal for an occupied --artifact-path: replay of THIS request, an interrupted run, or a foreign record. */
function occupiedArtifactRefusal(
  ctx: Context, operation: 'prepare' | 'reference', identity: RequestIdentity, occupancy: ArtifactOccupancy,
): OperationFailure {
  if (occupancy.replayOf) ctx.replayOf = occupancy.replayOf;
  const fresh = operation === 'prepare'
    ? prepareAction(ctx, `${identity.artifactPath}-retry`, ['FRESH_ARTIFACT_PATH', 'PROJECT_COMMANDS_AUTHORIZED'], 'requires_authorization')
    : referenceAction(ctx, `${identity.artifactPath}-retry`, ['SESSION_EXISTS', 'FRESH_ARTIFACT_PATH']);
  // A session owns this migration: it is inspected and updated, never prepared again, so after a
  // recorded replay the retry direction is a reference update on a fresh path.
  const retry = ctx.sessionId
    ? referenceAction(ctx, `${identity.artifactPath}-retry`, ['SESSION_EXISTS', 'FRESH_ARTIFACT_PATH'])
    : fresh;
  const nextActions: NextActionInput[] = !occupancy.replayOf
    // Same path, different configuration: a conflict, never a replay.
    ? [fresh]
    : occupancy.interrupted
      // Interrupted run: never conclude silently — start over on a fresh path.
      ? [fresh]
      : ctx.sessionId ? [statusAction(ctx), retry] : [fresh];
  const detail = !occupancy.recorded
    ? `The artifact path ${identity.artifactPath} is already occupied.`
    : !occupancy.replayOf
      ? `The artifact path ${identity.artifactPath} holds a recorded operation of a different configuration (structured conflict, not a replay).`
      : occupancy.interrupted
        ? `A previous run of this request was interrupted at ${identity.artifactPath}; nothing was concluded and no attempt was consumed.`
        : `This request already produced a recorded result at ${identity.artifactPath}; results are never reused heuristically.`;
  return new OperationFailure('ARTIFACT_NOT_FRESH', {
    detail,
    fieldPath: '--artifact-path',
    nextActions,
  });
}

async function occupiedArtifactFailure(
  ctx: Context, operation: 'prepare' | 'reference', error: unknown, identity: RequestIdentity,
): Promise<OperationFailure | undefined> {
  if (diagnose(error).code !== 'ARTIFACT_NOT_FRESH') return undefined;
  const store = await storeOf(ctx);
  const occupancy = await inspectOccupiedArtifact(store, resolve(identity.workspaceRoot, identity.artifactPath), identity);
  return occupiedArtifactRefusal(ctx, operation, identity, occupancy);
}

async function commandPrepare(ctx: Context): Promise<EnvelopeInput> {
  const config = await loadConfig(ctx);
  const workspace = await workspaceOf(ctx);
  const policy = privacyOf(ctx);
  const artifactPath = flag(ctx, 'artifact-path');
  assertStandard(ctx, config);
  const sessionId = migrationSessionPath(config);
  const identity: RequestIdentity = {
    operation: 'prepare',
    configurationHash: migrationConfigHash(config),
    workspaceRoot: workspace,
    artifactPath,
  };
  ctx.requestKey = requestKeyFor(identity);
  if (await pathExists(resolve(workspace, sessionId))) {
    // An existing session splits the refusal (PLAN-V2 §11.2 A4): when THIS exact request already
    // recorded a result at --artifact-path it is a replay (ARTIFACT_NOT_FRESH + replayOf == requestKey,
    // the same pattern `reference` already follows); any other owner of the path is a conflict.
    ctx.sessionId = sessionId;
    const occupancy = await inspectOccupiedArtifact(await storeOf(ctx), resolve(workspace, artifactPath), identity);
    if (occupancy.replayOf) throw occupiedArtifactRefusal(ctx, 'prepare', identity, occupancy);
    throw new OperationFailure('SESSION_ALREADY_EXISTS', {
      detail: 'A session already owns this source/target pair; sessions are never reset. Use reference to update it, or status to inspect it.',
      sessionId,
      nextActions: [
        statusAction(ctx),
        referenceAction(ctx, `${artifactPath}-retry`, ['SESSION_EXISTS', 'FRESH_ARTIFACT_PATH']),
      ],
    });
  }
  if (ctx.values['allow-project-commands'] !== true) {
    // Only reached when no session exists (the branch above always refuses), so §4 keeps sessionId absent.
    throw new OperationFailure('EXECUTION_NOT_AUTHORIZED', {
      detail: 'Establishing a reference executes the declared project commands; authorize them explicitly.',
      nextActions: [prepareAction(ctx, artifactPath, ['PROJECT_COMMANDS_AUTHORIZED'], 'requires_authorization')],
    });
  }
  let preparation;
  try {
    preparation = await prepareMigration({
      config, workspaceRoot: workspace, artifactPath, allowProjectCommands: true, signal: ctx.signal,
      allowInsecurePrivateStore: policy.allowInsecurePrivateStore,
    });
  } catch (error) {
    const failure = await occupiedArtifactFailure(ctx, 'prepare', error, identity);
    if (failure) throw failure;
    throw error;
  }
  if (preparation.status !== 'PASS' || preparation.kind !== 'MIGRATION_PREPARATION') {
    return {
      operation: 'prepare',
      operationStatus: 'processed',
      outcome: preparation.status as EnvelopeOutcome,
      report: preparation,
      nextActions: buildNextActions([doctorAction(ctx, ['ENVIRONMENT_ISSUES_RESOLVED'], 'after_correction')]),
    };
  }
  const started = await startMigrationSession({ config, workspaceRoot: workspace, preparation });
  ctx.sessionId = started.sessionPath;
  return {
    operation: 'prepare',
    operationStatus: 'processed',
    sessionId: started.sessionPath,
    decision: 'READY',
    outcome: 'PASS',
    report: preparation,
    nextActions: buildNextActions([
      statusAction(ctx),
      verifyAction(ctx, ['SESSION_EXISTS', 'BUDGET_AVAILABLE'], 'requires_authorization'),
    ]),
  };
}

/* ---------------------------------------------------------------- verify */

function verifyNextActions(ctx: Context, decision: SessionDecision): NextAction[] {
  const inputs: NextActionInput[] = decision === 'COMPLETE' ? []
    : decision === 'REPAIR_IMPLEMENTATION' ? [verifyAction(ctx, ['CANDIDATE_CORRECTED'], 'after_correction')]
      // An environment-classified failure is an ambiguous cause: diagnose first, never edit the candidate.
      : decision === 'FIX_ENVIRONMENT' ? [doctorAction(ctx, ['ENVIRONMENT_ISSUES_RESOLVED'], 'automatic')]
        // REVIEW_REFERENCE may propose a reference update; it never authorizes an adoption.
        : decision === 'REVIEW_REFERENCE' ? [referenceAction(ctx, 'artifacts/reference-update', ['SESSION_EXISTS', 'FRESH_ARTIFACT_PATH', 'REFERENCE_REVIEWED'])]
          : decision === 'REFUSED_SCOPE' ? [verifyAction(ctx, ['SCOPE_RECONCILED'], 'requires_authorization')]
            // Stops need a human decision: budgets and history are immutable, nothing is auto-reset.
            : [];
  return buildNextActions(inputs, { decision });
}

async function commandVerify(ctx: Context): Promise<EnvelopeInput> {
  const config = await loadConfig(ctx);
  const workspace = await workspaceOf(ctx);
  privacyOf(ctx);
  assertStandard(ctx, config);
  const sessionId = migrationSessionPath(config);
  if (!await pathExists(resolve(workspace, sessionId))) {
    // §4 "sessionId: present only when they exist": a session that does not exist is never named.
    throw new OperationFailure('STANDARD_SESSION_REQUIRED', {
      detail: 'No session owns this migration yet; open one with prepare before verifying.',
      nextActions: [prepareAction(ctx, 'artifacts/prepared', ['FRESH_ARTIFACT_PATH', 'PROJECT_COMMANDS_AUTHORIZED'], 'requires_authorization')],
    });
  }
  ctx.sessionId = sessionId;
  if (ctx.values['allow-project-commands'] !== true) {
    throw new OperationFailure('EXECUTION_NOT_AUTHORIZED', {
      detail: 'Verification executes the declared project commands; authorize them explicitly.',
      sessionId,
      nextActions: [verifyAction(ctx, ['PROJECT_COMMANDS_AUTHORIZED'], 'requires_authorization')],
    });
  }
  const result = await verifyMigrationSession({ config, workspaceRoot: workspace, allowProjectCommands: true, signal: ctx.signal });
  const ran = 'index' in result;
  const outcome = outcomeOf('outcome' in result ? result.outcome : undefined);
  const diagnostics: EnvelopeDiagnostic[] = 'errorCode' in result && result.errorCode
    ? [engineDiagnostic(ATTEMPT_ERROR_CODES[result.errorCode] ?? 'UNCLASSIFIED', result.errorCode)]
    : [];
  return {
    operation: 'verify',
    operationStatus: ran ? 'processed' : 'refused',
    sessionId,
    decision: result.decision,
    ...(outcome ? { outcome } : {}),
    report: result,
    diagnostics,
    nextActions: verifyNextActions(ctx, result.decision),
  };
}

/* ---------------------------------------------------------------- status */

/** Disposition of the last recorded report — engine logic, never re-derived from the outcome alone. */
async function recordedDisposition(ctx: Context, workspace: string, reportPath: string | undefined): Promise<{ decision?: SessionDecision; invalid?: true }> {
  if (!reportPath) return {};
  try {
    const store = await storeOf(ctx);
    const report = parseMigrationReport(await readPublicJson(resolve(workspace, reportPath), store, 32_000_000));
    return { decision: disposition(report) };
  } catch {
    return { invalid: true };
  }
}

function statusNextActions(ctx: Context, decision: SessionDecision, lastReportMatchesWorkspace: boolean): NextAction[] {
  const inputs: NextActionInput[] =
    decision === 'COMPLETE' ? (lastReportMatchesWorkspace ? [] : [verifyAction(ctx, ['BUDGET_AVAILABLE'], 'requires_authorization')])
      : decision === 'READY' ? [verifyAction(ctx, ['BUDGET_AVAILABLE'], 'requires_authorization')]
        : decision === 'REPAIR_IMPLEMENTATION' ? [verifyAction(ctx, ['CANDIDATE_CORRECTED'], 'after_correction')]
          : decision === 'FIX_ENVIRONMENT' ? [doctorAction(ctx, ['ENVIRONMENT_ISSUES_RESOLVED'], 'automatic')]
            : decision === 'REVIEW_REFERENCE' ? [referenceAction(ctx, 'artifacts/reference-update', ['SESSION_EXISTS', 'FRESH_ARTIFACT_PATH', 'REFERENCE_REVIEWED'])]
              : decision === 'REFUSED_SCOPE' ? [verifyAction(ctx, ['SCOPE_RECONCILED'], 'requires_authorization')]
                : [];
  return buildNextActions(inputs, { decision });
}

async function commandStatus(ctx: Context): Promise<EnvelopeInput> {
  const config = await loadConfig(ctx);
  const workspace = await workspaceOf(ctx);
  assertStandard(ctx, config);
  const sessionId = migrationSessionPath(config);
  if (!await pathExists(resolve(workspace, sessionId))) {
    // §4 "sessionId: present only when they exist": a session that does not exist is never named.
    throw new OperationFailure('STANDARD_SESSION_REQUIRED', {
      detail: 'No session owns this migration yet; run prepare to open one.',
      nextActions: [prepareAction(ctx, 'artifacts/prepared', ['FRESH_ARTIFACT_PATH', 'PROJECT_COMMANDS_AUTHORIZED'], 'requires_authorization')],
    });
  }
  ctx.sessionId = sessionId;
  const state = await inspectMigrationSession({ config, workspaceRoot: workspace });
  const diagnostics: EnvelopeDiagnostic[] = [];
  let decision: SessionDecision;
  if (state.stop) decision = state.stop;
  else if (state.scope === 'REFUSED') decision = 'REFUSED_SCOPE';
  else if (state.referenceStatus !== 'VERIFIED') {
    decision = 'REVIEW_REFERENCE';
    diagnostics.push(envelopeDiagnostic(diagnosticError('SESSION_REFERENCE_NOT_VERIFIED').diagnostic));
  } else {
    const last = state.attempts.at(-1);
    const recorded = await recordedDisposition(ctx, workspace, last?.reportPath);
    if (recorded.invalid) diagnostics.push(envelopeDiagnostic(diagnosticError('SESSION_REPORT_INVALID').diagnostic));
    decision = recorded.decision ?? 'READY';
  }
  return {
    operation: 'status',
    operationStatus: 'processed',
    sessionId,
    decision,
    report: state,
    diagnostics,
    nextActions: statusNextActions(ctx, decision, state.lastReportMatchesWorkspace),
  };
}

/* ------------------------------------------------------------- reference */

async function commandReference(ctx: Context): Promise<EnvelopeInput> {
  const config = await loadConfig(ctx);
  const workspace = await workspaceOf(ctx);
  privacyOf(ctx);
  const artifactPath = flag(ctx, 'artifact-path');
  assertStandard(ctx, config);
  const sessionId = migrationSessionPath(config);
  if (!await pathExists(resolve(workspace, sessionId))) {
    // §4 "sessionId: present only when they exist": a session that does not exist is never named.
    throw new OperationFailure('STANDARD_SESSION_REQUIRED', {
      detail: 'A reference update needs an open session; run prepare first.',
      nextActions: [prepareAction(ctx, 'artifacts/prepared', ['FRESH_ARTIFACT_PATH', 'PROJECT_COMMANDS_AUTHORIZED'], 'requires_authorization')],
    });
  }
  ctx.sessionId = sessionId;
  if (ctx.values['allow-project-commands'] !== true) {
    throw new OperationFailure('EXECUTION_NOT_AUTHORIZED', {
      detail: 'A reference update executes the declared project commands; authorize them explicitly.',
      sessionId,
      nextActions: [referenceAction(ctx, artifactPath, ['SESSION_EXISTS', 'FRESH_ARTIFACT_PATH', 'PROJECT_COMMANDS_AUTHORIZED'])],
    });
  }
  const identity: RequestIdentity = {
    operation: 'reference',
    configurationHash: migrationConfigHash(config),
    workspaceRoot: workspace,
    artifactPath,
  };
  ctx.requestKey = requestKeyFor(identity);
  const ownerDecision = typeof ctx.values['owner-decision'] === 'string' ? ctx.values['owner-decision'] : undefined;
  let result;
  try {
    // The effective privacy policy was already propagated to the environment, so the engine's own
    // stores and reports resolve the same single policy this operation decided on (§3.1).
    result = await updateMigrationSessionReference({
      config, workspaceRoot: workspace, artifactPath, allowProjectCommands: true,
      ...(ownerDecision ? { ownerDecisionReference: ownerDecision } : {}),
    });
  } catch (error) {
    const failure = await occupiedArtifactFailure(ctx, 'reference', error, identity);
    if (failure) throw failure;
    const code = diagnose(error).code;
    if (code === 'REFERENCE_CHANGE_REQUIRES_OWNER_DECISION') {
      // The adoption flag is deliberately NOT pre-filled: a recommendation never fabricates an approval.
      throw new OperationFailure('REFERENCE_CHANGE_REQUIRES_OWNER_DECISION', {
        detail: 'The proposed reference weakens evaluation criteria; ask the owner for a decision and add --owner-decision with the owner\'s reference.',
        sessionId,
        nextActions: [referenceAction(ctx, artifactPath, ['SESSION_EXISTS', 'FRESH_ARTIFACT_PATH', 'OWNER_DECISION_OBTAINED'])],
      });
    }
    if (['SESSION_REFERENCE_UPDATE_OUT_OF_SCOPE', 'SESSION_SCOPE_EXPANSION_NOT_AUTHORIZED', 'SESSION_SCOPE_CHANGED_DURING_UPDATE'].includes(code)) {
      throw new OperationFailure(code, { detail: (error as Error).message, sessionId, nextActions: [statusAction(ctx)] });
    }
    throw error;
  }
  return {
    operation: 'reference',
    operationStatus: 'processed',
    sessionId,
    decision: 'READY',
    report: result,
    nextActions: buildNextActions([
      statusAction(ctx),
      verifyAction(ctx, ['SESSION_EXISTS', 'BUDGET_AVAILABLE'], 'requires_authorization'),
    ], { referenceStatus: 'VERIFIED' }),
  };
}

/* --------------------------------------------------------------- runner */

function parseCommandArgs(ctx: Context, argv: string[]): void {
  const entry = findCommand(ctx.command);
  if (!entry) throw new OperationFailure('UNKNOWN_COMMAND', { status: 'failed', detail: `Unknown command "${ctx.command}".` });
  const options = Object.fromEntries(entry.flags.map(item => [item.name.replace(/^--/, ''), { type: (item.value === undefined ? 'boolean' : 'string') as 'boolean' | 'string' }]));
  const { values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  ctx.values = values as Record<string, string | boolean>;
  for (const item of entry.flags) {
    const key = item.name.replace(/^--/, '');
    if (item.required && ctx.values[key] === undefined) {
      throw new OperationFailure('MISSING_FLAG', { detail: `Required flag ${item.name} is missing.`, fieldPath: item.name });
    }
  }
}

/** Ambiguous cause (nothing published explains it): recommend diagnosis, never an edit. */
function ambiguousCauseNextActions(ctx: Context): NextAction[] {
  if (!ctx.config || !ctx.values['workspace-root']) return [];
  return buildNextActions([doctorAction(ctx, ['CONFIG_VALID'], 'automatic')]);
}

function failureEnvelope(ctx: Context, error: unknown): EnvelopeInput {
  let descriptor: ErrorDescriptor;
  let fieldPath: string | undefined;
  let operationStatus: 'refused' | 'failed';
  let nextActions: NextAction[] = [];
  let report: unknown;
  if (error instanceof OperationFailure) {
    descriptor = diagnosticError(error.code, error.failure.detail).diagnostic;
    fieldPath = error.failure.fieldPath;
    operationStatus = error.failure.status ?? 'refused';
    const failureSession = error.failure.sessionId ?? ctx.sessionId;
    if (failureSession) ctx.sessionId = failureSession;
    nextActions = buildNextActions(error.failure.nextActions ?? [], error.failure.nextContext ?? {});
    report = error.failure.report;
  } else {
    descriptor = diagnose(error);
    operationStatus = ['INPUT', 'CONFIGURATION', 'AUTHORIZATION', 'STATE'].includes(descriptor.category) ? 'refused' : 'failed';
    if (descriptor.category === 'UNCLASSIFIED' || descriptor.category === 'INTERNAL') nextActions = ambiguousCauseNextActions(ctx);
  }
  return {
    operation: ctx.command,
    operationStatus,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(report !== undefined ? { report } : {}),
    diagnostics: [envelopeDiagnostic(descriptor, { ...(fieldPath ? { fieldPath } : {}) })],
    nextActions,
    ...(ctx.requestKey ? { requestKey: ctx.requestKey } : {}),
    ...(ctx.replayOf ? { replayOf: ctx.replayOf } : {}),
  };
}

async function dispatch(ctx: Context): Promise<EnvelopeInput> {
  switch (ctx.command) {
    case 'init': return commandInit(ctx);
    case 'doctor': return commandDoctor(ctx);
    case 'prepare': return commandPrepare(ctx);
    case 'verify': return commandVerify(ctx);
    case 'status': return commandStatus(ctx);
    case 'reference': return commandReference(ctx);
  }
}

/** Human projection of one envelope; diagnostics go to stderr so stdout stays the result channel. */
export function renderV2Text(envelope: Envelope): void {
  const summary = [`${envelope.operation}: ${envelope.operationStatus}`];
  if (envelope.decision) summary.push(`decision ${envelope.decision}`);
  if (envelope.outcome) summary.push(`outcome ${envelope.outcome}`);
  summary.push(`exit ${envelopeExitCode(envelope)}`);
  console.log(summary.join(' | '));
  if (envelope.sessionId) console.log(`session: ${envelope.sessionId}`);
  if (envelope.replayOf) console.log(`replayOf: ${envelope.replayOf}`);
  const report = envelope.report as { kind?: unknown } | undefined;
  if (report && typeof report === 'object' && typeof report.kind === 'string') console.log(`report: ${report.kind}`);
  for (const action of envelope.nextActions) {
    const args = Object.entries(action.args).map(([name, value]) => value === true ? name : `${name} ${value}`).join(' ');
    console.log(`next: ${action.operation}${args ? ` ${args}` : ''} [${action.requiresApproval}; preconditions: ${action.preconditions.join(', ')}]`);
  }
  for (const item of envelope.diagnostics) {
    console.error(`ERROR ${item.code}: ${item.cause}\n  category: ${item.category} | retryable: ${item.retryable ? 'yes' : 'no'}${item.fieldPath ? ` | field: ${item.fieldPath}` : ''}\n  action: ${item.action}`);
  }
}

/**
 * Run one v2 command: parse, dispatch, emit exactly one envelope (JSON mode) or its text
 * projection, and derive the process exit code from the same combination table (§3.1).
 */
export async function runV2(command: V2Command, argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const ctx: Context = { command, runId: randomUUID(), values: {}, signal: controller.signal };
  let envelope: Envelope;
  try {
    try {
      parseCommandArgs(ctx, argv);
      const input = await dispatch(ctx);
      envelope = buildEnvelope({
        ...input,
        runId: ctx.runId,
        ...(input.sessionId === undefined && ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(input.requestKey === undefined && ctx.requestKey ? { requestKey: ctx.requestKey } : {}),
        ...(input.replayOf === undefined && ctx.replayOf ? { replayOf: ctx.replayOf } : {}),
      });
    } catch (error) {
      envelope = buildEnvelope({ ...failureEnvelope(ctx, error), runId: ctx.runId });
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  if (jsonMode) process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  else renderV2Text(envelope);
  process.exitCode = envelopeExitCode(envelope);
}
