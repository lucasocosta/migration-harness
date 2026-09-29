import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  canonical, MigrationPathSchema, migrationConfigHash, migrationReferenceHash, parseMigrationConfig,
  parseMigrationPreparation, parseSanitizedTrace, parseContract, SourceObservationsSchema,
  normalizeUrl, responseFieldClaimsForScenario, unitAssertionsForScenario, scenarioBindingProjection, classifyReferenceChange,
  UnitAssertionOutcomeSchema,
  type MigrationConfig, type MigrationDiagnostic, type MigrationPreparation, type MigrationReport,
  type MigrationReference, type ScenarioVerification, type VerificationIdentity, type VerificationStatus,
} from '@migration-harness/core';
import { EquivalenceValidator, evaluateUnitAssertions, resolveExpectedDifferences, migrationComparisonPolicy, verifyCriticalContract, verifySourceStability } from '@migration-harness/equivalence-validator';
import { assertionRequirementStatuses, buildMigrationReport, compareStateProjections, evaluateResponseFieldClaims, evaluateStateClaims, resolveStateAcceptedDivergence, type KeyedField } from '@migration-harness/quality-gates';
import { ArtifactStore, safeArtifactPath } from './artifacts.js';
import { captureProjectSuite, type CaptureSuiteResult, type SuiteCapture } from './capture-suite.js';
import { collectMigrationReference, verifyMigrationReference } from './migration-reference.js';
import { preflightProjectChecks } from './project-checks.js';
import { preflightBuildServers, ProjectBuildError } from './build-servers.js';
import { compareSourceStateEvidence, keyedStateValue, readStateSnapshot, stateEvidencePins, type StateSnapshotEnvelope } from './state-capture.js';
import { assertNotPrivateWorkspace, coversPosix, isWithin, privateBaseDir } from './platform-paths.js';

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const unavailable = digest(null);
const combine = (values: VerificationStatus[]): VerificationStatus => values.includes('INCONCLUSIVE') || !values.length
  ? 'INCONCLUSIVE' : values.includes('FAIL') ? 'FAIL' : 'PASS';
interface OperationInput { config: unknown; workspaceRoot: string; artifactPath: string; allowProjectCommands?: boolean; signal?: AbortSignal; allowInsecurePrivateStore?: boolean }

async function reserve(input: OperationInput): Promise<{ config: MigrationConfig; workspace: string; store: ArtifactStore }> {
  const config = parseMigrationConfig(input.config), workspace = await realpath(resolve(input.workspaceRoot));
  assertNotPrivateWorkspace(workspace, privateBaseDir());
  const path = MigrationPathSchema.parse(input.artifactPath), output = resolve(workspace, path);
  const overlap = (other: string): boolean => other === output || isWithin(output, other) || isWithin(other, output);
  if ([config.source.root, config.target.root, ...config.scenarios.map(item => item.fixtureRoot),
    ...(config.criticalContract ? [config.criticalContract.path] : [])].some(item => overlap(resolve(workspace, item)))) throw new Error('UNSAFE_OPERATION_OUTPUT');
  await safeArtifactPath(workspace, path); await mkdir(dirname(output), { recursive: true });
  try { await mkdir(output); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('ARTIFACT_NOT_FRESH');
  }
  const store = new ArtifactStore(output, undefined, input.allowInsecurePrivateStore || process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE === '1'
    ? { allowInsecurePrivateStore: true } : {});
  await store.write('started.json', { kind: 'MIGRATION_OPERATION_STARTED', configurationHash: migrationConfigHash(config), completed: false });
  return { config, workspace, store };
}

/** Bounded public evidence reads; no trace values are returned in operation summaries. */
async function readEvidence(root: string, path: string): Promise<unknown> {
  const target = await safeArtifactPath(root, MigrationPathSchema.parse(path));
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(), cap = 32 * 1024 * 1024;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > cap) throw new Error('EVIDENCE_UNAVAILABLE');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, cap + 1));
    let used = 0;
    while (used < buffer.length) { const read = await file.read(buffer, used, buffer.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
    if (used !== stat.size || (await file.stat()).mtimeMs !== stat.mtimeMs) throw new Error('EVIDENCE_CHANGED');
    return JSON.parse(buffer.subarray(0, used).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

async function referenceKey(store: ArtifactStore, create?: string): Promise<string> {
  const path = await store.privatePath('pseudonymization.key');
  let file;
  try {
    file = await open(path, create === undefined ? constants.O_RDONLY | constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    // A previous operation over the same artifact identity already owns the key: reuse it (stable
    // pseudonyms across re-prepares) instead of failing, preserving the read-side validation below.
    if (create === undefined || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return referenceKey(store);
  }
  try {
    const stat = await file.stat();
    const weakMode = Boolean(stat.mode & 0o077);
    if (!stat.isFile() || stat.nlink !== 1 || (weakMode && !store.privacyMode.includes('DEGRADED')) || stat.size > 128) throw new Error('PRIVATE_KEY_UNAVAILABLE');
    if (create !== undefined) { await file.writeFile(create); return create; }
    const buffer = Buffer.alloc(129); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const key = buffer.subarray(0, bytesRead).toString('utf8');
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('PRIVATE_KEY_UNAVAILABLE');
    return key;
  } finally { await file.close(); }
}

function observations(config: MigrationConfig, suite?: CaptureSuiteResult): ReturnType<typeof SourceObservationsSchema.parse> {
  const results = config.scenarios.map(item => suite?.stability.find(result => result.scenarioId === item.definition.scenarioId)?.result);
  if (results.some(result => !result || result.observations.status === 'NOT_COLLECTED' || result.observedRuns !== config.limits.sourceRuns)) {
    return { status: 'NOT_COLLECTED', runs: 0 };
  }
  return SourceObservationsSchema.parse({ status: results.some(result => result!.observations.status === 'UNSTABLE') ? 'UNSTABLE' : 'STABLE',
    runs: config.limits.sourceRuns, executionHashes: Array.from({ length: config.limits.sourceRuns }, (_, index) =>
      digest(results.map((result, scenarioIndex) => [config.scenarios[scenarioIndex]!.definition.scenarioId,
        result!.observations.status === 'NOT_COLLECTED' ? null : result!.observations.executionHashes[index]]))) });
}

export async function preflightMigration(input: { config: unknown; workspaceRoot: string; signal?: AbortSignal }) {
  const checks = await preflightProjectChecks(input);
  const diagnostics: MigrationDiagnostic[] = checks.findings.map(item => ({ code: 'OPERATION_FAILED', category: 'OPERATIONAL', detailCode: item.code,
    ...(item.checkId ? { checkId: item.checkId } : {}) }));
  if (checks.status === 'PASS') {
    try { await preflightBuildServers(input); }
    catch (error) { diagnostics.push({ code: 'OPERATION_FAILED', category: 'OPERATIONAL', detailCode: error instanceof ProjectBuildError ? error.code : 'PREFLIGHT_FAILED' }); }
    if (!diagnostics.length && !input.signal?.aborted) {
      try {
        const { preflightBrowser } = await import('@migration-harness/scenario-runner');
        await preflightBrowser();
      } catch { diagnostics.push({ code: 'OPERATION_FAILED', category: 'OPERATIONAL', detailCode: 'BROWSER_UNAVAILABLE' }); }
    }
  }
  if (input.signal?.aborted) diagnostics.push({ code: 'OPERATION_FAILED', category: 'OPERATIONAL', detailCode: 'ABORTED' });
  return { kind: 'MIGRATION_PREFLIGHT' as const, status: diagnostics.length ? 'INCONCLUSIVE' as const : 'PASS' as const, checks, diagnostics };
}

function budget(config: MigrationConfig, signal?: AbortSignal) {
  const controller = new AbortController(), deadline = Date.now() + config.limits.maxDurationMs;
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, config.limits.maxDurationMs);
  return { signal: controller.signal, expired: () => controller.signal.aborted || Date.now() >= deadline,
    close: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

/** Establish a source reference before edits and record native destination regression/build baseline checks. */
export async function prepareMigration(input: OperationInput & { previous?: unknown; ownerDecisionReference?: string; preflightOnly?: boolean }) {
  if (!input.preflightOnly && input.allowProjectCommands !== true) throw new Error('EXECUTION_NOT_AUTHORIZED');
  const { config, workspace, store } = await reserve(input), session = budget(config, input.signal);
  try {
    const preflight = await preflightMigration({ config, workspaceRoot: workspace, signal: session.signal });
    await store.write('preflight.json', preflight);
    if (input.preflightOnly || preflight.status !== 'PASS') return preflight;
    const previous = input.previous === undefined ? undefined : parseMigrationPreparation(input.previous);
    // Classify requested reference changes before executing any project command.
    const referenceInput = { config, workspaceRoot: workspace,
      ...(previous ? { previous: previous.reference } : {}),
      ...(input.ownerDecisionReference ? { ownerDecisionReference: input.ownerDecisionReference } : {}) };
    if (previous) await collectMigrationReference(referenceInput);
    const key = await referenceKey(store, previous ? await referenceKey(new ArtifactStore(resolve(workspace, previous.artifactPath))) : randomBytes(32).toString('hex'));
    let suite: CaptureSuiteResult | undefined;
    if (preflight.status === 'PASS' && !session.expired()) {
      suite = await captureProjectSuite({ config, workspaceRoot: workspace, artifactPath: `${input.artifactPath}/capture`,
        allowProjectCommands: true, phase: 'baseline', sourceOnly: true, signal: session.signal, pseudonymizationKey: key });
    }
    const fresh = await collectMigrationReference({ config, workspaceRoot: workspace, sourceObservations: observations(config, suite) });
    const reference = previous && classifyReferenceChange(previous.reference, fresh).classification === 'INITIAL' ? previous.reference
      : previous ? await collectMigrationReference({ ...referenceInput, sourceObservations: fresh.sourceObservations }) : fresh;
    const verified = await verifyMigrationReference({ config, workspaceRoot: workspace, reference });
    // Source STATE_SNAPSHOTs are pinned alongside their traces. An INCOMPLETE snapshot is not evidence:
    // it never becomes a pin and it keeps the prepared reference unverifiable (fail closed).
    const sourceEvidence = (suite?.captures ?? []).flatMap(item => {
      if (item.side !== 'source' || item.status !== 'COMPLETED' || !item.evidencePath) return [];
      const state = stateEvidencePins(item.state);
      return [{ scenarioId: item.scenarioId, runIndex: item.runIndex, runId: item.traceRunId!, traceHash: item.traceHash!,
        path: `capture/${item.evidencePath}`, ...(state.pins.length ? { state: state.pins } : {}) }];
    });
    const sourceStateComplete = (suite?.captures ?? [])
      .every(item => item.side !== 'source' || !stateEvidencePins(item.state).incomplete);
    const preparation = parseMigrationPreparation({ kind: 'MIGRATION_PREPARATION', version: '1',
      status: !session.expired() && suite?.status === 'COMPLETED' && verified.status === 'VERIFIED' && sourceStateComplete
        ? suite.checks?.status ?? 'INCONCLUSIVE' : 'INCONCLUSIVE',
      reference, referenceHash: migrationReferenceHash(reference),
      artifactPath: input.artifactPath, keyId: digest(key),
      sourceEvidence,
      ...(suite?.checks ? { baseline: suite.checks } : {}), ...(suite?.builds?.source ? { sourceBuild: suite.builds.source } : {}) });
    await store.write('reference.json', reference); await store.write('reference-verification.json', verified);
    if (preparation.baseline) await store.write('baseline.json', preparation.baseline);
    await store.write('preparation.json', preparation);
    return preparation;
  } finally { session.close(); }
}

async function traceFor(config: MigrationConfig, suite: CaptureSuiteResult, captureRoot: string, scenarioId: string, side: 'source' | 'target', runIndex: number) {
  const record = suite.captures.find(item => item.scenarioId === scenarioId && item.side === side && item.runIndex === runIndex);
  const scenario = config.scenarios.find(item => item.definition.scenarioId === scenarioId)!;
  if (!record || record.status !== 'COMPLETED' || !record.evidencePath || !suite.builds
    || record.buildHash !== suite.builds[side].buildHash || record.buildRunId !== suite.builds[side].runId
    || record.bindingHash !== digest(scenarioBindingProjection(scenario, side))) throw new Error('CAPTURE_UNAVAILABLE');
  const trace = parseSanitizedTrace(await readEvidence(captureRoot, record.evidencePath));
  if (digest(trace) !== record.traceHash || trace.runId !== record.traceRunId || trace.scenarioId !== scenarioId
    || trace.runIndex !== runIndex || trace.completion?.status !== 'COMPLETED'
    || canonical(trace.completion.completedStepIds) !== canonical(scenario.definition.steps.map(step => step.stepId))) throw new Error('CAPTURE_MISMATCH');
  return { trace, path: `capture/${record.evidencePath}` };
}

const incompleteCodes = new Set(['INSUFFICIENT_EVIDENCE', 'NETWORK_INCOMPLETE_EXCHANGE', 'NON_DETERMINISTIC_EXECUTION',
  'CAUSAL_ALIGNMENT_BUDGET_EXCEEDED', 'VALUE_EVIDENCE_OMITTED', 'UNIT_ASSERTION_NOT_EVALUABLE', 'SCENARIO_FAILED']);

export interface ScenarioRequirementStatus {
  requirementId: string;
  status: VerificationStatus;
  /** Declared reason code of the failing target-side outcome (assertion or response field), never an observed value. */
  reason?: string;
}

/**
 * Map one scenario's machine-checkable requirements onto report statuses.
 *
 * A requirement declaring an `assertion` is answered by the differential assertion outcomes already
 * evaluated on the target; a requirement declaring a `responseClaim` is evaluated here against the
 * recorded HTTP exchanges of both sides, so an API-first requirement reaches PASS on evidence instead of
 * falling through to INCONCLUSIVE. When a requirement declares both, every declared source must hold.
 * A requirement with no machine-checkable evidence, or evidence that cannot decide, stays INCONCLUSIVE —
 * unevaluable evidence is never a pass.
 */
export function scenarioRequirementStatuses(config: MigrationConfig, scenarioId: string, input: {
  /** Target outcomes of the scenario's differential assertion pass, as produced by `evaluateUnitAssertions`. */
  assertionOutcomes: unknown;
  /** Sanitized source execution of the scenario: the evidence for response-field claims. */
  source: unknown;
  /** Sanitized target execution of the scenario: the evidence for response-field claims. */
  target: unknown;
  /** STATE_SNAPSHOT evidence of both sides plus the keyed-literal context for HMAC'd claim values. */
  state?: {
    sourceSnapshots: unknown[];
    targetSnapshots: unknown[];
    keyed?: readonly KeyedField[] | undefined;
    hmac?: ((value: unknown, domain: string) => string) | undefined;
  } | undefined;
}): ScenarioRequirementStatus[] {
  const statuses = assertionRequirementStatuses(input.assertionOutcomes);
  const reasons = new Map<string, string>();
  for (const outcome of UnitAssertionOutcomeSchema.array().max(10000).parse(input.assertionOutcomes)) {
    if (outcome.side === 'target' && outcome.reason) reasons.set(outcome.assertionId, outcome.reason);
  }
  const claims = responseFieldClaimsForScenario(config, scenarioId);
  if (claims.length) {
    // Satisfaction per side, then the shared mapping: VIOLATED -> FAIL, unevaluable -> INCONCLUSIVE.
    const evaluation = evaluateResponseFieldClaims({ claims, source: input.source, target: input.target });
    statuses.push(...assertionRequirementStatuses(evaluation.outcomes));
    for (const outcome of evaluation.outcomes) if (outcome.side === 'target' && outcome.reason) reasons.set(outcome.assertionId, outcome.reason);
  }
  // STATE_FIELD requirements are answered against the captured domain-state projections of both sides;
  // keyed fields decide declared literals under their representation, and absent or incomplete state
  // evidence stays INCONCLUSIVE exactly like the other claim vocabularies.
  const stateClaims = config.requirements.flatMap(item => item.scenarioId === scenarioId && item.stateClaim
    ? [{ id: item.id, required: item.required, stateClaim: item.stateClaim }] : []);
  if (stateClaims.length && input.state) {
    const evaluation = evaluateStateClaims({ claims: stateClaims, sourceSnapshots: input.state.sourceSnapshots,
      targetSnapshots: input.state.targetSnapshots,
      ...(input.state.keyed ? { keyed: input.state.keyed } : {}),
      ...(input.state.hmac ? { hmac: input.state.hmac } : {}) });
    statuses.push(...assertionRequirementStatuses(evaluation.outcomes));
    for (const outcome of evaluation.outcomes) if (outcome.side === 'target' && outcome.reason) reasons.set(outcome.assertionId, outcome.reason);
  }
  return config.requirements.filter(item => item.scenarioId === scenarioId).map(item => {
    const declared = statuses.filter(entry => entry.requirementId === item.id).map(entry => entry.status);
    const reason = reasons.get(item.id);
    return { requirementId: item.id, status: declared.length ? combine(declared) : 'INCONCLUSIVE', ...(reason ? { reason } : {}) };
  });
}

/** Verify all declared behavior and native regression checks against an explicit, unchanged prepared reference. */
export async function verifyMigration(input: OperationInput & { preparation: unknown }): Promise<MigrationReport> {
  if (input.allowProjectCommands !== true) throw new Error('EXECUTION_NOT_AUTHORIZED');
  const preparation = parseMigrationPreparation(input.preparation);
  if (preparation.referenceHash !== migrationReferenceHash(preparation.reference)) throw new Error('PREPARATION_HASH_MISMATCH');
  const { config, workspace, store } = await reserve(input), session = budget(config, input.signal);
  const diagnostics: MigrationDiagnostic[] = [];
  let suite: CaptureSuiteResult | undefined;
  let current: MigrationReference | undefined;
  try {
    let reference = await verifyMigrationReference({ config, workspaceRoot: workspace, reference: preparation.reference });
    const preflight = await preflightMigration({ config, workspaceRoot: workspace, signal: session.signal });
    await store.write('preflight.json', preflight); diagnostics.push(...preflight.diagnostics);
    const baseline = preparation.baseline;
    const validPreparation = baseline?.phase === 'baseline' && baseline.configurationHash === preparation.reference.configurationHash
      && baseline.preflight.inputHash === baseline.inputHashAfter && !baseline.findings.length
      && preparation.sourceBuild?.side === 'source' && preparation.sourceBuild.inputHash === baseline.inputHashAfter
      && preparation.sourceBuild.configurationHash === baseline.configurationHash;
    if (!validPreparation) diagnostics.push({ code: 'OPERATION_FAILED', category: 'EVIDENCE', detailCode: 'BASELINE_MISMATCH' });
    let key: string | undefined;
    const originalSources = new Map<string, ReturnType<typeof parseSanitizedTrace>>();
    const originalStates = new Map<string, Array<{ runIndex: number; envelope: StateSnapshotEnvelope }>>();
    try {
      key = await referenceKey(new ArtifactStore(resolve(workspace, preparation.artifactPath)));
      if (digest(key) !== preparation.keyId) throw new Error('KEY_MISMATCH');
      if (preparation.sourceEvidence.length !== config.scenarios.length * config.limits.sourceRuns) throw new Error('REFERENCE_COVERAGE_MISMATCH');
      const preparedRoot = resolve(workspace, preparation.artifactPath);
      const runIds = new Set<string>();
      for (const item of config.scenarios) for (let index = 0; index < config.limits.sourceRuns; index++) {
        const entries = preparation.sourceEvidence.filter(entry => entry.scenarioId === item.definition.scenarioId && entry.runIndex === index);
        if (entries.length !== 1) throw new Error('REFERENCE_COVERAGE_MISMATCH');
        const entry = entries[0]!, trace = parseSanitizedTrace(await readEvidence(preparedRoot, entry.path));
        if (digest(trace) !== entry.traceHash || trace.runId !== entry.runId || runIds.has(entry.runId)
          || trace.scenarioId !== entry.scenarioId || trace.runIndex !== index || trace.completion?.status !== 'COMPLETED') throw new Error('REFERENCE_EVIDENCE_CHANGED');
        runIds.add(entry.runId);
        if (index === 0) originalSources.set(entry.scenarioId, trace);
        // Pinned STATE_SNAPSHOTs of this run: re-read, integrity-checked and identity-matched exactly
        // like the trace above. An incomplete or drifted pin makes the prepared reference unverifiable.
        for (const pin of entry.state ?? []) {
          if (pin.completeness !== 'COMPLETE') throw new Error('REFERENCE_STATE_EVIDENCE_INCOMPLETE');
          const snapshot = await readStateSnapshot(preparedRoot, pin.path);
          if (snapshot.completeness !== 'COMPLETE' || snapshot.side !== 'source' || snapshot.evidenceHash !== pin.evidenceHash
            || snapshot.projectionFingerprint !== pin.projectionFingerprint || snapshot.captureId !== pin.captureId
            || snapshot.checkpoint !== pin.checkpoint || snapshot.scenarioId !== entry.scenarioId
            || snapshot.runIndex !== index) throw new Error('REFERENCE_STATE_EVIDENCE_CHANGED');
          originalStates.set(entry.scenarioId, [...(originalStates.get(entry.scenarioId) ?? []),
            { runIndex: index, envelope: snapshot }]);
        }
      }
    } catch {
      key = undefined;
      diagnostics.push({ code: 'STALE_EVIDENCE', category: 'EVIDENCE', detailCode: 'REFERENCE_EVIDENCE_UNAVAILABLE' });
    }
    if (reference.status === 'VERIFIED' && preflight.status === 'PASS' && validPreparation && key && !session.expired()) {
      suite = await captureProjectSuite({ config, workspaceRoot: workspace, artifactPath: `${input.artifactPath}/capture`,
        allowProjectCommands: true, phase: 'candidate', baseline, signal: session.signal, pseudonymizationKey: key });
    }
    if (suite?.failureCode) diagnostics.push({ code: 'OPERATION_FAILED', category: 'OPERATIONAL', detailCode: suite.failureCode });
    reference = await verifyMigrationReference({ config, workspaceRoot: workspace, reference: preparation.reference });
    current = await collectMigrationReference({ config, workspaceRoot: workspace }).catch(() => undefined);
    const sourceObservations = observations(config, suite);
    if (sourceObservations.status !== 'STABLE') diagnostics.push({ code: 'SOURCE_UNSTABLE', category: 'EVIDENCE',
      detailCode: sourceObservations.status === 'UNSTABLE' ? 'SOURCE_UNSTABLE' : 'SOURCE_OBSERVATIONS_MISSING' });
    // Noise proposals are advisory only (HINT_ONLY); never auto-apply to policy (RFC §7).
    for (const item of suite?.stability ?? []) {
      if (item.result.suggestions?.suggestions.length) diagnostics.push({ code: 'STANDARD_WARNING', category: 'EVIDENCE',
        scenarioId: item.scenarioId, detailCode: 'NOISE_PROPOSAL' });
    }
    const buildMatches = suite?.builds?.source.buildHash === preparation.sourceBuild?.buildHash && !!suite?.builds;
    if (!buildMatches) diagnostics.push({ code: 'STALE_EVIDENCE', category: 'EVIDENCE', detailCode: 'SOURCE_BUILD_MISMATCH' });
    const identity: VerificationIdentity = { migrationId: config.migrationId, configurationHash: migrationConfigHash(config),
      referenceHash: preparation.referenceHash, candidateHash: current ? digest(current.target) : unavailable,
      buildHash: suite?.builds?.target.buildHash ?? unavailable };
    const scenarios: ScenarioVerification[] = [];
    const criticalStates: VerificationStatus[] = [];
    let sourceUnchanged = !!key;
    const contract = config.criticalContract && reference.criticalContract === 'VERIFIED'
      ? parseContract(await readEvidence(workspace, config.criticalContract.path)) : undefined;
    for (const item of config.scenarios) {
      const scenarioId = item.definition.scenarioId;
      const requirements = config.requirements.filter(item => item.scenarioId === scenarioId).map(item => ({ requirementId: item.id, status: 'INCONCLUSIVE' as VerificationStatus }));
      const result: ScenarioVerification = { identity, scenarioId, status: 'INCONCLUSIVE', requirements, diagnostics: [], evidencePaths: [] };
      try {
        if (!suite || suite.failureCode) throw new Error('SUITE_UNAVAILABLE');
        const source = await traceFor(config, suite, resolve(store.root, 'capture'), scenarioId, 'source', 0);
        const target = await traceFor(config, suite, resolve(store.root, 'capture'), scenarioId, 'target', 0);
        const policy = migrationComparisonPolicy(config.policy);
        const original = originalSources.get(scenarioId);
        if (!original || verifySourceStability({ runs: [original, source.trace], requiredRuns: 2, reset: config.reset, policy }).observations.status !== 'STABLE') {
          sourceUnchanged = false;
          diagnostics.push({ code: 'STALE_EVIDENCE', scenarioId, category: 'EVIDENCE', detailCode: 'SOURCE_REFERENCE_CHANGED' });
        }
        // Fresh source STATE_SNAPSHOTs must reproduce the pinned prepared state. Drift is stale
        // evidence (same codebook as the trace comparison); missing or INCOMPLETE fresh state is
        // reported once here and can never leave the scenario in PASS.
        const stateOutcome = await compareSourceStateEvidence({ config, scenarioId,
          pinned: originalStates.get(scenarioId) ?? [], captureRoot: resolve(store.root, 'capture'),
          freshRecords: suite.captures.filter(record => record.side === 'source' && record.scenarioId === scenarioId) });
        if (stateOutcome.stale) {
          sourceUnchanged = false;
          if (!diagnostics.some(item => item.scenarioId === scenarioId && item.detailCode === 'SOURCE_REFERENCE_CHANGED')) {
            diagnostics.push({ code: 'STALE_EVIDENCE', scenarioId, category: 'EVIDENCE', detailCode: 'SOURCE_REFERENCE_CHANGED' });
          }
        }
        if (stateOutcome.incomplete) diagnostics.push({ code: 'EXECUTION_INCOMPLETE', scenarioId, category: 'EVIDENCE',
          detailCode: 'STATE_EVIDENCE_UNAVAILABLE' });
        const entry = normalizeUrl(item.definition.entryUrl);
        policy.observables = { ...policy.observables, navigationAliases: {
          [normalizeUrl(item.bindings.source.entryUrl)]: entry, [normalizeUrl(item.bindings.target.entryUrl)]: entry,
          ...policy.observables?.navigationAliases,
        } };
        const mocks = item.definition.preconditions.mockInitialApiResponses ?? [];
        const comparison = new EquivalenceValidator().validate({ source: source.trace, target: target.trace, policy, mocks });
        const assertions = evaluateUnitAssertions({ source: source.trace, target: target.trace, assertions: unitAssertionsForScenario(config, scenarioId), mocks,
          unitScopes: { ...(item.bindings.source.unitScope ? { source: item.bindings.source.unitScope } : {}),
            ...(item.bindings.target.unitScope ? { target: item.bindings.target.unitScope } : {}) } });
        const expected = resolveExpectedDifferences({ differences: config.acceptedDifferences, scenarioId, source: source.trace,
          target: target.trace, divergences: comparison.divergences, targetOutcomes: assertions.outcomes, mocks });
        const accepted = new Set(expected.acceptedDivergenceIds);
        const blocking = comparison.divergences.filter(item => item.severity === 'BLOCKING' && !accepted.has(item.divergenceId));
        result.status = blocking.some(item => incompleteCodes.has(item.code) || item.dimension === 'SECURITY') ? 'INCONCLUSIVE' : blocking.length ? 'FAIL' : 'PASS';
        result.diagnostics = comparison.divergences.map(item => ({ scenarioId, code: accepted.has(item.divergenceId) ? 'EXPECTED_DIFFERENCE' : item.code === 'MOCKED_COVERAGE' ? 'MOCKED_COVERAGE'
          : item.severity !== 'BLOCKING' ? 'STANDARD_WARNING' : result.status === 'FAIL' ? 'BEHAVIOR_DIVERGENCE' : 'EXECUTION_INCOMPLETE',
          detailCode: item.code, category: item.severity === 'BLOCKING' ? 'IMPLEMENTATION' : 'EVIDENCE' }));
        // STATE_SNAPSHOT evidence of run 0 per side feeds the state-claim evaluation; unreadable or
        // incomplete entries are simply absent evidence and stay INCONCLUSIVE.
        const stateSnapshots = async (side: 'source' | 'target'): Promise<unknown[]> => {
          const record = suite?.captures.find(entry => entry.side === side && entry.scenarioId === scenarioId);
          const snapshots: unknown[] = [];
          for (const entry of record?.state ?? []) {
            if (entry.evidencePath && entry.completeness === 'COMPLETE') {
              try { snapshots.push(await readStateSnapshot(resolve(store.root, 'capture'), entry.evidencePath)); } catch { /* absent evidence */ }
            }
          }
          return snapshots;
        };
        const sourceState = await stateSnapshots('source'), targetState = await stateSnapshots('target');
        const stateKeyed: KeyedField[] = (config.stateProjections ?? []).flatMap(projection =>
          (projection.privacy.fields ?? []).filter(field => field.representation === 'KEYED_EQUALITY'));
        const statuses = scenarioRequirementStatuses(config, scenarioId, {
          assertionOutcomes: assertions.outcomes, source: source.trace, target: target.trace,
          state: { sourceSnapshots: sourceState, targetSnapshots: targetState,
            keyed: stateKeyed, ...(key ? { hmac: (value, domain) => keyedStateValue(value, domain, key) } : {}) },
        });
        for (const requirement of requirements) {
          const mapped = statuses.find(item => item.requirementId === requirement.requirementId);
          const reason = mapped?.reason;
          requirement.status = mapped?.status ?? 'INCONCLUSIVE';
          if (requirement.status !== 'PASS') diagnostics.push({ code: requirement.status === 'FAIL' ? 'REQUIREMENT_VIOLATED' : 'REQUIREMENT_NOT_EVALUABLE',
            scenarioId, requirementId: requirement.requirementId, category: requirement.status === 'FAIL' ? 'IMPLEMENTATION' : 'EVIDENCE',
            ...(reason ? { detailCode: reason } : {}) });
        }
        if (contract?.unitId === item.definition.unitId) {
          const failed = verifyCriticalContract(contract, target.trace).some(item => item.severity === 'BLOCKING');
          criticalStates.push(failed ? 'FAIL' : 'PASS');
          if (failed) diagnostics.push({ code: 'CRITICAL_CONTRACT_VIOLATED', scenarioId, category: 'IMPLEMENTATION' });
        }
        // Domain-state preservation is evaluated independently of the declared claims: paired projections
        // must match structurally, so an uncovered state divergence still fails the scenario. Only an
        // exact, evidenced STATE_DIVERGENCE accepted difference (source predicate + satisfied required
        // claims + owner decision) may resolve one — acceptance never stands in for evidence.
        for (const capture of item.stateCaptures ?? []) {
          const left = sourceState.find(value => (value as { captureId?: string }).captureId === capture.id);
          const right = targetState.find(value => (value as { captureId?: string }).captureId === capture.id);
          if (left === undefined || right === undefined) continue;
          const projectionConfig = (config.stateProjections ?? []).find(entry => entry.id === capture.projectionId);
          const compared = compareStateProjections({ scenarioId, captureId: capture.id, source: left, target: right,
            ...(projectionConfig ? { comparison: projectionConfig.comparison } : {}) });
          for (const finding of compared.findings) {
            const acceptedEntry = config.acceptedDifferences.find((entry): entry is Extract<MigrationConfig['acceptedDifferences'][number], { code: 'STATE_DIVERGENCE' }> =>
              'code' in entry && entry.code === 'STATE_DIVERGENCE'
              && entry.scenarioId === finding.scenarioId && entry.captureId === finding.captureId && entry.path === finding.path);
            const resolved = acceptedEntry !== undefined && resolveStateAcceptedDivergence({ difference: acceptedEntry, source: left,
              claimOutcomes: requirements.map(item => ({ assertionId: item.requirementId,
                status: item.status === 'PASS' ? 'SATISFIED' : item.status === 'FAIL' ? 'VIOLATED' : 'NOT_EVALUABLE' })) });
            diagnostics.push({ code: resolved ? 'EXPECTED_DIFFERENCE' : 'BEHAVIOR_DIVERGENCE', scenarioId,
              category: resolved ? 'EVIDENCE' : 'IMPLEMENTATION', detailCode: 'STATE_DIVERGENCE' });
            if (!resolved) result.status = 'FAIL';
          }
        }
        // Missing or INCOMPLETE fresh state evidence can never end a scenario in PASS.
        if (stateOutcome.incomplete && result.status === 'PASS') result.status = 'INCONCLUSIVE';
        const evidencePath = `comparisons/${scenarioId}.json`;
        await store.write(evidencePath, { scenarioId, preservation: result.status, diagnostics: result.diagnostics, assertions: assertions.outcomes,
          observedPreservation: comparison.status, expectedDifferences: expected.evidence });
        result.evidencePaths = [source.path, target.path, evidencePath];
      } catch {
        const failed = suite?.captures.find(record => record.scenarioId === scenarioId && record.status !== 'COMPLETED');
        result.status = 'INCONCLUSIVE'; result.diagnostics = [{ code: 'EXECUTION_INCOMPLETE', scenarioId, category: 'OPERATIONAL',
          detailCode: failed?.executionCode ?? failed?.reason ?? 'EVIDENCE_UNAVAILABLE',
          ...(failed ? { side: failed.side } : {}), ...(failed?.stepId ? { stepId: failed.stepId } : {}) }];
        if (contract?.unitId === item.definition.unitId) criticalStates.push('INCONCLUSIVE');
      }
      scenarios.push(result);
    }
    const checks = (suite?.checks?.checks ?? []).map(check => ({ identity, checkId: check.checkId, status: check.status,
      evidencePaths: ['native-checks.json'], diagnostics: check.status === 'PASS'
        ? check.baselineComparison === 'RESOLVED' ? [{ code: 'BASELINE_RESOLVED' as const, checkId: check.checkId, category: 'BASELINE' as const }] : []
        : [{ code: check.status === 'FAIL' ? 'NATIVE_CHECK_FAILED' as const : 'NATIVE_CHECK_INCONCLUSIVE' as const, checkId: check.checkId,
          side: check.side, category: check.baselineComparison === 'BASELINE_CHECK_FAILED' ? 'BASELINE' as const : 'OPERATIONAL' as const,
          detailCode: check.baselineComparison === 'BASELINE_CHECK_FAILED' ? 'BASELINE_CHECK_FAILED' : check.reason }] }));
    if (session.expired()) diagnostics.push({ code: 'OPERATION_FAILED', category: 'OPERATIONAL', detailCode: 'SESSION_TIMEOUT' });
    const finalReference = await verifyMigrationReference({ config, workspaceRoot: workspace, reference: preparation.reference });
    const unchanged = current && canonical((await collectMigrationReference({ config, workspaceRoot: workspace })).target) === canonical(current.target);
    const report = buildMigrationReport(config, { identity, evaluatedAt: new Date().toISOString(), reference: finalReference,
      referenceVerified: finalReference.status === 'VERIFIED' && sourceObservations.status === 'STABLE' && buildMatches
        && sourceUnchanged && !suite?.failureCode && validPreparation && !!unchanged && !session.expired(), scenarios, checks, executionDiagnostics: diagnostics,
      privacy: { mode: store.privacyMode, platform: process.platform },
      ...(config.criticalContract ? { criticalContractStatus: combine(criticalStates) } : {}) });
    if (suite?.checks) await store.write('native-checks.json', suite.checks);
    await store.write('reference-verification.json', finalReference);
    await store.write('criteria.json', { requirements: config.requirements, acceptedDifferences: config.acceptedDifferences });
    await store.write('migration-report.json', report);
    return report;
  } finally { session.close(); }
}

export function summarizeMigration(report: MigrationReport): string {
  const coverage = report.requiredCoverage;
  return [`Migration ${report.identity.migrationId}: ${report.status}`, `Preservation: ${report.preservation}; requirements: ${report.requirements}; native checks: ${report.projectChecks}`,
    `Reference: ${report.referenceStatus}; scenarios ${coverage.scenarios.received}/${coverage.scenarios.expected}; requirements ${coverage.requirements.received}/${coverage.requirements.expected}; checks ${coverage.checks.received}/${coverage.checks.expected}`,
    ...report.scenarios.map(item => `Scenario ${item.scenarioId}: ${item.status}`),
    ...report.diagnostics.map(item => `${item.code}${item.detailCode ? ` (${item.detailCode})` : ''}${item.scenarioId ? ` scenario=${item.scenarioId}` : ''}${item.checkId ? ` check=${item.checkId}` : ''}${item.requirementId ? ` requirement=${item.requirementId}` : ''}${item.side ? ` side=${item.side}` : ''}${item.stepId ? ` step=${item.stepId}` : ''}`)].join('\n');
}
