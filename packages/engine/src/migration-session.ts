import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  canonical, migrationConfigHash, migrationReferenceHash, parseMigrationConfig, parseMigrationPreparation, parseMigrationReport,
  parseSessionGenerations, MigrationSessionSchema, SessionAttemptStartSchema, SessionAttemptFinishSchema, isSuggestionOnlyDiagnostic,
  type MigrationConfig, type MigrationPreparation, type MigrationScopeSnapshot, type MigrationSession, type SessionAttemptStart,
  type SessionAttemptFinish, type SessionGeneration, type MigrationReport,
} from '@migration-harness/core';
import { ArtifactStore, safeArtifactPath } from './artifacts.js';
import { withFileLock } from './sealing.js';
import { verifyMigrationReference } from './migration-reference.js';
import { prepareMigration, verifyMigration } from './migration-operations.js';
import { snapshotMigrationScope, compareMigrationScope, validateStandardScope } from './migration-scope.js';
import { assertNotPrivateWorkspace, coversPosix, privateBaseDir } from './platform-paths.js';

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
type Input = { config: unknown; workspaceRoot: string };
export type SessionDecision = 'READY' | 'COMPLETE' | 'REPAIR_IMPLEMENTATION' | 'FIX_ENVIRONMENT' | 'REVIEW_REFERENCE'
  | 'REFUSED_SCOPE' | 'STOP_LIMIT' | 'STOP_NO_PROGRESS' | 'INTERRUPTED';

/** One persistent budget per project pair, independent of caller-provided migration IDs and output paths. */
export function migrationSessionPath(config: MigrationConfig): string {
  return `artifacts/sessions/${digest([config.source.root, config.target.root]).slice(0, 32)}`;
}
async function storeFor(input: Input) {
  const config = parseMigrationConfig(input.config); validateStandardScope(config);
  const workspace = await realpath(resolve(input.workspaceRoot));
  assertNotPrivateWorkspace(workspace, privateBaseDir());
  const path = migrationSessionPath(config);
  if ([config.source.root, config.target.root, ...config.scenarios.map(item => item.fixtureRoot),
    ...(config.criticalContract ? [config.criticalContract.path] : [])].some(root => coversPosix(root, path) || coversPosix(path, root))) {
    throw new Error('SESSION_OVERLAPS_PROJECT_INPUTS');
  }
  await safeArtifactPath(workspace, path);
  return { config, workspace, path, store: new ArtifactStore(resolve(workspace, path)) };
}
async function readJson(store: ArtifactStore, path: string): Promise<unknown> {
  if ((await lstat(store.root)).isSymbolicLink()) throw new Error('SESSION_PATH_UNSAFE');
  const file = await open(await safeArtifactPath(store.root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error('SESSION_DATA_INVALID');
    const buffer = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < buffer.length) { const read = await file.read(buffer, used, buffer.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
    if (used !== stat.size || (await file.stat()).mtimeMs !== stat.mtimeMs) throw new Error('SESSION_DATA_CHANGED');
    return JSON.parse(buffer.subarray(0, used).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

export async function startMigrationSession(input: Input & { preparation: unknown }) {
  const { config, workspace, path, store } = await storeFor(input);
  const preparation = parseMigrationPreparation(input.preparation);
  if (preparation.referenceHash !== migrationReferenceHash(preparation.reference)
    || !preparation.baseline || !preparation.sourceBuild || preparation.baseline.phase !== 'baseline'
    || preparation.baseline.configurationHash !== migrationConfigHash(config)
    || (await verifyMigrationReference({ config, workspaceRoot: workspace, reference: preparation.reference })).status !== 'VERIFIED') {
    throw new Error('SESSION_REFERENCE_NOT_VERIFIED');
  }
  const scope = await snapshotMigrationScope({ config, workspaceRoot: workspace });
  if (compareMigrationScope(config, scope, scope).length) throw new Error('UNSAFE_INITIAL_WRITE_SCOPE');
  const session = MigrationSessionSchema.parse({ kind: 'MIGRATION_SESSION', version: '1', profile: 'standard',
    createdAt: new Date().toISOString(), configurationHash: migrationConfigHash(config), workspaceHash: digest(workspace), config, preparation, scope,
    maxAttempts: config.limits.maxRepairAttempts + 1, maxActiveMs: config.limits.maxDurationMs });
  await mkdir(dirname(store.root), { recursive: true });
  await mkdir(store.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new Error('SESSION_ALREADY_EXISTS'); throw error; });
  await store.write('session.json', { session, hash: digest(session) });
  return { kind: 'MIGRATION_SESSION_STARTED', sessionPath: path, maxAttempts: session.maxAttempts, maxActiveMs: session.maxActiveMs };
}

interface HistoryItem { start: SessionAttemptStart; finish?: SessionAttemptFinish; hash: string }
interface CurrentGeneration { index: number; config: MigrationConfig; preparation: MigrationPreparation; scope: MigrationScopeSnapshot; configurationHash: string }

/** Reference generations are a separate append-only chain rooted at the session; session.json is never rewritten. */
async function readGenerations(store: ArtifactStore, session: MigrationSession): Promise<SessionGeneration[]> {
  let value: unknown;
  try { value = await readJson(store, 'generations.json'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const parsed = parseSessionGenerations(value);
  const invalid = (): never => { throw new Error('SESSION_GENERATIONS_INVALID'); };
  if (parsed.sessionHash !== digest(session)) invalid();
  let previousHash = digest(session);
  for (const [position, entry] of parsed.entries.entries()) {
    if (entry.index !== position + 1 || entry.previousHash !== previousHash
      || entry.configurationHash !== migrationConfigHash(entry.config)
      || entry.referenceHash !== migrationReferenceHash(entry.preparation.reference) || entry.scopeHash !== digest(entry.scope)) invalid();
    previousHash = digest(entry);
  }
  return parsed.entries;
}

function currentGeneration(session: MigrationSession, generations: SessionGeneration[]): CurrentGeneration {
  return generations.at(-1) ?? { index: 0, config: session.config, preparation: session.preparation, scope: session.scope,
    configurationHash: session.configurationHash };
}

async function history(store: ArtifactStore, session: MigrationSession, generations: SessionGeneration[]): Promise<HistoryItem[]> {
  const files = await readdir(resolve(store.root, 'attempts')).catch((error: NodeJS.ErrnoException): string[] => { if (error.code === 'ENOENT') return []; throw error; });
  if (files.some(file => !/^\d{4}\.(?:started|finished)\.json$/.test(file))) throw new Error('SESSION_HISTORY_INVALID');
  const count = files.filter(file => file.endsWith('.started.json')).length;
  if (count > session.maxAttempts) throw new Error('SESSION_HISTORY_INVALID');
  const entries: HistoryItem[] = []; let previousHash = digest(session);
  for (let index = 0; index < count; index++) {
    const prefix = `attempts/${String(index).padStart(4, '0')}`;
    const start = SessionAttemptStartSchema.parse(await readJson(store, `${prefix}.started.json`));
    if (start.index !== index || start.previousHash !== previousHash) throw new Error('SESSION_HISTORY_INVALID');
    const finishFile = `${String(index).padStart(4, '0')}.finished.json`;
    if (!files.includes(finishFile)) {
      if (index !== count - 1) throw new Error('SESSION_HISTORY_INVALID');
      entries.push({ start, hash: digest(start) }); continue;
    }
    const finish = SessionAttemptFinishSchema.parse(await readJson(store, `${prefix}.finished.json`));
    if (finish.index !== index || finish.startHash !== digest(start)) throw new Error('SESSION_HISTORY_INVALID');
    if (finish.reportPath) {
      const expected = `${migrationSessionPath(session.config)}/runs/${String(index).padStart(4, '0')}/migration-report.json`;
      if (finish.reportPath !== expected) throw new Error('SESSION_REPORT_INVALID');
      const generation = start.generation ?? 0;
      const configurationHash = generation === 0 ? session.configurationHash : generations.find(item => item.index === generation)?.configurationHash;
      if (configurationHash === undefined) throw new Error('SESSION_HISTORY_INVALID');
      const report = parseMigrationReport(await readJson(store, `runs/${String(index).padStart(4, '0')}/migration-report.json`));
      if (digest(report) !== finish.reportHash || report.identity.configurationHash !== configurationHash
        || finish.outcome === 'PASS' && report.status !== 'PASS') throw new Error('SESSION_REPORT_INVALID');
    }
    previousHash = digest(finish); entries.push({ start, finish, hash: previousHash });
  }
  if (files.length !== entries.reduce((sum, entry) => sum + (entry.finish ? 2 : 1), 0)) throw new Error('SESSION_HISTORY_INVALID');
  return entries;
}

async function load(input: Input, options: { allowConfigDrift?: boolean } = {}) {
  const context = await storeFor(input);
  const value = await readJson(context.store, 'session.json') as { session?: unknown; hash?: unknown };
  const session = MigrationSessionSchema.parse(value.session);
  if (value.hash !== digest(session) || session.workspaceHash !== digest(context.workspace)
    || session.configurationHash !== migrationConfigHash(session.config)
    || session.maxAttempts !== session.config.limits.maxRepairAttempts + 1 || session.maxActiveMs !== session.config.limits.maxDurationMs) throw new Error('SESSION_INPUT_MISMATCH');
  const generations = await readGenerations(context.store, session);
  const current = currentGeneration(session, generations);
  // A reference update submits the new config on purpose; every other caller must match the current generation.
  if (!options.allowConfigDrift && migrationConfigHash(current.config) !== migrationConfigHash(context.config)) throw new Error('SESSION_INPUT_MISMATCH');
  return { ...context, session, generations, current, entries: await history(context.store, session, generations) };
}

export function disposition(report: MigrationReport): SessionDecision {
  if (report.status === 'PASS') return 'COMPLETE';
  // Suggestion/advisory diagnostics are non-authoritative and must never force FIX_ENVIRONMENT.
  const actionable = report.diagnostics.filter(item => !isSuggestionOnlyDiagnostic(item));
  if (report.referenceStatus !== 'VERIFIED' || actionable.some(item => ['REFERENCE_MISMATCH', 'CONFIGURATION_MISMATCH'].includes(item.code)
    || ['REFERENCE_EVIDENCE_UNAVAILABLE', 'SOURCE_REFERENCE_CHANGED', 'SOURCE_UNSTABLE', 'BASELINE_MISMATCH'].includes(item.detailCode ?? ''))) return 'REVIEW_REFERENCE';
  if (report.status === 'FAIL' || actionable.some(item => item.side === 'target'
    && (item.detailCode === 'STEP_FAILED' || item.code === 'NATIVE_CHECK_FAILED'))) return 'REPAIR_IMPLEMENTATION';
  // Missing source observations/builds can be a consequence of execution failure, not reference drift.
  if (actionable.some(item => item.code === 'OPERATION_FAILED')) return 'FIX_ENVIRONMENT';
  if (actionable.some(item => ['STALE_EVIDENCE', 'REFERENCE_UNVERIFIED'].includes(item.code))) return 'REVIEW_REFERENCE';
  // Only suggestion-level noise left and no FAIL evidence: the owner reviews what to declare next.
  if (!actionable.length && report.diagnostics.length) return 'REVIEW_REFERENCE';
  return 'FIX_ENVIRONMENT';
}
function allowance(session: MigrationSession, entries: HistoryItem[]) {
  const usedMs = entries.reduce((sum, item) => sum + (item.finish?.durationMs ?? item.start.remainingMs), 0);
  const remainingMs = Math.max(0, session.maxActiveMs - usedMs);
  let stop: SessionDecision | undefined;
  if (entries.at(-1) && !entries.at(-1)!.finish) stop = 'INTERRUPTED';
  else if (entries.length >= session.maxAttempts || !remainingMs) stop = 'STOP_LIMIT';
  else if (entries.length >= 2 && entries.at(-1)!.finish!.outcome !== 'PASS'
    && entries.slice(0, -1).some(item => item.start.candidateHash === entries.at(-1)!.start.candidateHash
      && item.finish?.fingerprint === entries.at(-1)!.finish!.fingerprint)) stop = 'STOP_NO_PROGRESS';
  return { attemptsUsed: entries.length, attemptsRemaining: Math.max(0, session.maxAttempts - entries.length), usedMs, remainingMs, ...(stop ? { stop } : {}) };
}

export async function inspectMigrationSession(input: Input) {
  const context = await load(input);
  const snapshot = await snapshotMigrationScope(input);
  const findings = compareMigrationScope(context.current.config, context.current.scope, snapshot);
  const reference = await verifyMigrationReference({ config: context.current.config, workspaceRoot: context.workspace, reference: context.current.preparation.reference });
  const last = context.entries.at(-1);
  return { kind: 'MIGRATION_SESSION_STATUS', sessionPath: context.path, generation: context.current.index,
    ...allowance(context.session, context.entries),
    scope: findings.length ? 'REFUSED' : 'PASS', findings, candidateHash: snapshot.target.hash,
    referenceStatus: reference.status,
    // A report from a superseded reference generation never matches the current workspace, even byte-identical.
    lastReportMatchesWorkspace: !findings.length && reference.status === 'VERIFIED' && last?.finish?.outcome === 'PASS'
      && last?.finish?.candidateHash === snapshot.target.hash && (last?.start.generation ?? 0) === context.current.index,
    attempts: context.entries.map(item => ({ index: item.start.index, generation: item.start.generation ?? 0,
      outcome: item.finish?.outcome ?? 'INTERRUPTED', reportPath: item.finish?.reportPath })) };
}

/**
 * Controlled reference update for coverage extension or binding adaptation: appends a hash-linked generation
 * with a fresh preparation while session identity, attempt history and budgets stay frozen. Weakening still
 * requires an explicit owner decision (raised by the reference collector); session resets stay impossible.
 */
export async function updateMigrationSessionReference(input: Input & { artifactPath: string; ownerDecisionReference?: string; allowProjectCommands?: boolean }) {
  if (input.allowProjectCommands !== true) throw new Error('EXECUTION_NOT_AUTHORIZED');
  const initial = await storeFor(input);
  return withFileLock(resolve(initial.store.root, '.session.lock'), async () => {
    const { session, generations, current, entries, store, workspace, config } = await load(input, { allowConfigDrift: true });
    if (entries.at(-1) && !entries.at(-1)!.finish) throw new Error('SESSION_ATTEMPT_OPEN');
    if (config.source.root !== session.config.source.root || config.target.root !== session.config.target.root) throw new Error('SESSION_PAIR_CHANGED');
    if (canonical(config.limits) !== canonical(session.config.limits)) throw new Error('SESSION_LIMITS_IMMUTABLE');
    const prepared = await prepareMigration({ config, workspaceRoot: workspace, artifactPath: input.artifactPath, allowProjectCommands: true,
      previous: current.preparation, ...(input.ownerDecisionReference ? { ownerDecisionReference: input.ownerDecisionReference } : {}) });
    if (prepared.kind !== 'MIGRATION_PREPARATION' || prepared.status !== 'PASS'
      || (await verifyMigrationReference({ config, workspaceRoot: workspace, reference: prepared.reference })).status !== 'VERIFIED') {
      throw new Error('SESSION_REFERENCE_UPDATE_INCONCLUSIVE');
    }
    const scope = await snapshotMigrationScope({ config, workspaceRoot: workspace });
    if (compareMigrationScope(config, scope, scope).length) throw new Error('UNSAFE_REFERENCE_UPDATE_SCOPE');
    const generation: SessionGeneration = { index: generations.length + 1, createdAt: new Date().toISOString(),
      configurationHash: migrationConfigHash(config), referenceHash: migrationReferenceHash(prepared.reference),
      scopeHash: digest(scope), previousHash: digest(generations.at(-1) ?? session), config, preparation: prepared, scope };
    // The chain is rewritten in place under .session.lock: exclusive temp write plus atomic rename, so a crash
    // never truncates or interleaves history; the reload revalidates session binding, indexes and every hash.
    const payload = { kind: 'MIGRATION_SESSION_GENERATIONS' as const, version: '1' as const, sessionHash: digest(session), entries: [...generations, generation] };
    const temporary = `generations.${randomUUID()}.tmp`;
    try {
      await store.write(temporary, payload);
      await rename(await safeArtifactPath(store.root, temporary), await safeArtifactPath(store.root, 'generations.json'));
    } finally { await unlink(await safeArtifactPath(store.root, temporary)).catch(() => undefined); }
    if (digest(await readGenerations(store, session)) !== digest(payload.entries)) throw new Error('SESSION_GENERATIONS_INVALID');
    return { kind: 'MIGRATION_SESSION_REFERENCE_UPDATED', sessionPath: initial.path, generation: generation.index,
      referenceVersion: prepared.reference.referenceVersion, classification: prepared.reference.change.classification, ...allowance(session, entries) };
  });
}

/** Consume a persistent attempt before invoking the complete verifier; no callback can substitute a fabricated verdict. */
export async function verifyMigrationSession(input: Input & { allowProjectCommands?: boolean; signal?: AbortSignal }) {
  if (input.allowProjectCommands !== true) throw new Error('EXECUTION_NOT_AUTHORIZED');
  const initial = await load(input);
  return withFileLock(resolve(initial.store.root, '.session.lock'), async () => {
    const context = await load(input), { workspace, store, session, entries, current } = context;
    const limits = allowance(session, entries);
    if (limits.stop) return { kind: 'MIGRATION_SESSION_RESULT', decision: limits.stop, ...limits };
    const before = await snapshotMigrationScope(input), findings = compareMigrationScope(current.config, current.scope, before);
    if (findings.length) return { kind: 'MIGRATION_SESSION_RESULT', decision: 'REFUSED_SCOPE' as SessionDecision, findings, ...limits };
    const index = entries.length, id = String(index).padStart(4, '0');
    const started = Date.now();
    const start = SessionAttemptStartSchema.parse({ index, startedAt: new Date(started).toISOString(), previousHash: entries.at(-1)?.hash ?? digest(session),
      candidateHash: before.target.hash, remainingMs: limits.remainingMs, generation: current.index });
    await store.write(`attempts/${id}.started.json`, start);
    const controller = new AbortController(), abort = (): void => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, limits.remainingMs);
    let report: MigrationReport | undefined, errorCode: string | undefined;
    let decision: SessionDecision = 'FIX_ENVIRONMENT';
    let after = before;
    try {
      report = await verifyMigration({ config: current.config, workspaceRoot: workspace, artifactPath: `${context.path}/runs/${id}`,
        preparation: current.preparation, allowProjectCommands: true, signal: controller.signal });
      after = await snapshotMigrationScope(input);
      findings.push(...compareMigrationScope(current.config, current.scope, after));
      if (before.target.hash !== after.target.hash || before.source.hash !== after.source.hash) errorCode = 'CANDIDATE_CHANGED_DURING_VERIFICATION';
      decision = findings.length || errorCode ? 'REFUSED_SCOPE' : disposition(report);
    } catch {
      errorCode = 'SESSION_VERIFICATION_FAILED';
    } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
    const durationMs = Date.now() - started;
    if (durationMs >= limits.remainingMs) { errorCode = 'SESSION_TIME_LIMIT'; decision = 'STOP_LIMIT'; }
    const finish = SessionAttemptFinishSchema.parse({ index, startHash: digest(start), finishedAt: new Date().toISOString(), durationMs,
      outcome: decision === 'REFUSED_SCOPE' ? 'REFUSED_SCOPE' : errorCode ? 'INCONCLUSIVE' : report?.status ?? 'INCONCLUSIVE',
      fingerprint: digest({ status: report?.status ?? 'INCONCLUSIVE', diagnostics: report?.diagnostics.map(item => canonical(item)).sort() ?? [], errorCode: errorCode ?? null, findings }),
      candidateHash: after.target.hash, findings, generation: current.index, ...(errorCode ? { errorCode } : {}),
      ...(report ? { reportPath: `${context.path}/runs/${id}/migration-report.json`, reportHash: digest(report) } : {}) });
    await store.write(`attempts/${id}.finished.json`, finish);
    const next = allowance(session, [...entries, { start, finish, hash: digest(finish) }]);
    return { kind: 'MIGRATION_SESSION_RESULT', decision: decision === 'COMPLETE' ? decision : next.stop ?? decision, index, outcome: finish.outcome, ...(report ? { report } : {}),
      findings, ...(errorCode ? { errorCode } : {}), ...next };
  });
}
