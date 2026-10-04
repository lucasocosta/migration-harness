import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
  canonical, MigrationIdSchema, MigrationPathSchema, migrationConfigHash, parseMigrationConfig, parseScenario,
  resolveScenarioForSide, scenarioBindingProjection, isWithin, type ProjectCheckReport, type SanitizedObservedTrace,
  type ServedBuildIdentity,
} from '@migration-harness/core';
import { sanitizeTrace } from '@migration-harness/core';
import { migrationComparisonPolicy, type SourceStabilityResult } from './equivalence/index.js';
import type { CaptureBrowser } from './scenario-runner/index.js';
import { ArtifactStore, safeArtifactPath } from './artifacts.js';
import { ProjectBuildError, serveDeclarations, withProjectBuildServers, type BuildServerSession } from './build-servers.js';
import { preflightProjectChecks, runProjectReset, type ProjectResetResult } from './project-checks.js';
import {
  captureStateSnapshot, stateCapturesOf, stateEvidenceKey, verifyStateSourceStability,
  type StateCaptureReason, type StateCheckpoint, type StateCompleteness, type StateSettleStatus,
} from './state-capture.js';
import { PhaseTimer } from './timings.js';

type Side = 'source' | 'target';
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
/** One declared state capture of this record: codes, hashes and paths only, never projection values. */
export interface SuiteStateEvidence {
  captureId: string; checkpoint: StateCheckpoint; required: boolean;
  completeness: StateCompleteness;
  settle?: StateSettleStatus;
  /** Stable probe failure code; present exactly when the snapshot is INCOMPLETE. */
  reason?: StateCaptureReason;
  evidencePath?: string;
  evidenceHash?: string;
  /** Fingerprint of the projection's privacy+comparison config, absent when no envelope was produced. */
  projectionFingerprint?: string;
}
export interface SuiteCapture {
  scenarioId: string; unitId: string; required: boolean; side: Side; runIndex: number;
  status: 'COMPLETED' | 'INCONCLUSIVE' | 'NOT_RUN';
  reason?: 'RESET_FAILED' | 'CAPTURE_FAILED' | 'ABORTED' | 'NOT_RUN';
  reset?: ProjectResetResult;
  buildRunId?: string; buildHash?: string; bindingHash: string;
  traceRunId?: string; traceHash?: string; evidencePath?: string;
  stepId?: string; executionCode?: string;
  /** Declared state-capture outcomes; absent when the configuration declares no state vocabulary. */
  state?: SuiteStateEvidence[];
}
export interface CaptureSuiteResult {
  kind: 'CAPTURE_SUITE'; version: '1'; suiteId: string; configurationHash: string;
  /** Capture completion only. Even COMPLETED + stable source is not migration equivalence. */
  status: 'COMPLETED' | 'INCONCLUSIVE';
  captures: SuiteCapture[];
  stability: Array<{ scenarioId: string; result: SourceStabilityResult }>;
  builds?: { source: ServedBuildIdentity; target: ServedBuildIdentity };
  checks?: ProjectCheckReport;
  failureCode?: string;
}

/** Capture every declared scenario against freshly built applications, with reset before each independent run. */
export async function captureProjectSuite(input: {
  config: unknown; workspaceRoot: string;
  /** A new, public workspace-relative directory, outside apps and evaluation inputs. */
  artifactPath: string; allowProjectCommands?: boolean; signal?: AbortSignal;
  phase?: 'baseline' | 'candidate'; baseline?: unknown; sourceOnly?: boolean;
  /** Harness-owned shared key for versioned reference comparison; omitted keys remain invocation-local. */
  pseudonymizationKey?: string;
  /** Optional operation-level phase recorder; observation only, never influences capture decisions. */
  timings?: PhaseTimer;
  /**
   * Optional operation-owned browser: one process for the whole suite, a fresh `BrowserContext`
   * per capture (contexts are never reused — cookies, storage, listeners and mocks would leak).
   * The caller keeps ownership and must close it; a standalone suite launches and closes its own.
   */
  browser?: CaptureBrowser;
}): Promise<CaptureSuiteResult> {
  const serve = serveDeclarations(input.config);
  const config = parseMigrationConfig(input.config);
  if (input.allowProjectCommands !== true) throw new Error('EXECUTION_NOT_AUTHORIZED');
  for (const scenario of config.scenarios) MigrationIdSchema.parse(scenario.definition.unitId);
  const artifactPath = MigrationPathSchema.parse(input.artifactPath);
  // Local timer keeps standalone callers measurable; operation runs share the caller's recorder.
  const timer = input.timings ?? new PhaseTimer();
  const preflight = await timer.phase('project-checks', () => preflightProjectChecks(input), { step: 'capture-preflight' });
  if (preflight.status !== 'PASS') throw new Error('SUITE_PREFLIGHT_FAILED');
  const workspace = await realpath(resolve(input.workspaceRoot));
  const output = resolve(workspace, artifactPath);
  const overlaps = (path: string): boolean => path === output || isWithin(output, path) || isWithin(path, output);
  if ([config.source.root, config.target.root, ...config.scenarios.map(item => item.fixtureRoot),
    ...(config.criticalContract ? [config.criticalContract.path] : [])].some(path => overlaps(resolve(workspace, path)))) throw new Error('UNSAFE_SUITE_OUTPUT');
  await safeArtifactPath(workspace, artifactPath);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Exclusive run directory, before build cleanup or native commands.
  const store = new ArtifactStore(output);
  const report: CaptureSuiteResult = { kind: 'CAPTURE_SUITE', version: '1', suiteId: randomUUID(),
    configurationHash: migrationConfigHash(config), status: 'INCONCLUSIVE', captures: [], stability: [] };
  for (const item of config.scenarios) for (const side of ['source', 'target'] as const) {
    if (input.sourceOnly && side === 'target') continue;
    for (let runIndex = 0; runIndex < (side === 'source' ? config.limits.sourceRuns : 1); runIndex++) {
      report.captures.push({ scenarioId: item.definition.scenarioId, unitId: item.definition.unitId, required: item.required,
        side, runIndex, status: 'NOT_RUN', reason: 'NOT_RUN', bindingHash: digest(scenarioBindingProjection(item, side)) });
    }
  }
  await store.write('started.json', report);
  // Raw events stay in memory. A single ephemeral key makes this invocation comparable without retaining raw files or keys.
  const key = input.pseudonymizationKey ?? randomBytes(32).toString('hex');
  if (key.length < 32) throw new Error('INVALID_PSEUDONYMIZATION_KEY');
  const policy = migrationComparisonPolicy(config.policy);
  let work: Promise<void> | undefined;
  // One browser for the whole suite. `shared` is never a context: every capture below opens a new
  // BrowserContext. `ownsShared` records who must close the process (the suite when it launched it).
  let shared: CaptureBrowser | undefined;
  let ownsShared = false;
  const capture = async (session: BuildServerSession): Promise<void> => {
    const { captureScenario, ScenarioExecutionError, launchBrowser } = await import('./scenario-runner/index.js');
    report.builds = { source: session.source, target: session.target };
    for (const item of config.scenarios) {
      const runs: SanitizedObservedTrace[] = [];
      // Sanitized state of each observed source run, aligned with `runs` for the stability projection.
      const stateRuns: Array<Record<string, unknown>> = [];
      const declaredState = stateCapturesOf(config, item.definition.scenarioId);
      for (const record of report.captures.filter(record => record.scenarioId === item.definition.scenarioId)) {
        if (session.signal.aborted) return;
        const build = session[record.side];
        record.buildHash = build.buildHash; record.buildRunId = build.runId;
        record.reset = await timer.phase('reset', () => runProjectReset({ config, workspaceRoot: workspace, side: record.side,
          allowProjectCommands: true, signal: session.signal }), { scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex });
        if (record.reset.status !== 'PASS') {
          record.status = 'INCONCLUSIVE'; record.reason = session.signal.aborted ? 'ABORTED' : 'RESET_FAILED';
        } else {
          const state: SuiteStateEvidence[] = [];
          const observed: Record<string, unknown> = {};
          const stateRunId = randomUUID();
          if (declaredState.length) record.state = state;
          const checkpointState = async (checkpoint: StateCheckpoint): Promise<void> => {
            for (const declaration of declaredState.filter(entry => entry.checkpoint.kind === checkpoint)) {
              try {
                const result = await captureStateSnapshot({ config, workspaceRoot: workspace, side: record.side,
                  scenarioId: record.scenarioId, captureId: declaration.id, checkpoint, runIndex: record.runIndex,
                  runId: stateRunId, buildHash: record.buildHash!, pseudonymizationKey: key,
                  configurationHash: report.configurationHash, store, signal: session.signal });
                observed[stateEvidenceKey(declaration)] = result.envelope.completeness === 'COMPLETE'
                  ? result.envelope.projection : null;
                state.push({ captureId: declaration.id, checkpoint, required: declaration.required,
                  completeness: result.envelope.completeness, settle: result.envelope.settle.status,
                  evidenceHash: result.envelope.evidenceHash,
                  projectionFingerprint: result.envelope.projectionFingerprint,
                  ...(result.reason ? { reason: result.reason } : {}),
                  ...(result.evidencePath ? { evidencePath: result.evidencePath } : {}) });
              } catch {
                // A declaration failure is a stable code in the report; nothing from the probe reaches it.
                state.push({ captureId: declaration.id, checkpoint, required: declaration.required,
                  completeness: 'INCOMPLETE', reason: 'PROBE_DECLARATION_INVALID' });
              }
            }
          };
          // AFTER_RESET: after the reset/baseline and before the scenario's steps.
          await timer.phase('capture', () => checkpointState('AFTER_RESET'),
            { step: 'state-after-reset', scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex });
          try {
            const scenario = resolveScenarioForSide(config, record.scenarioId, record.side);
            // One process for the whole suite: take the operation's browser while it is connected
            // and launch at most once otherwise (a process that dies mid-suite is relaunched). This
            // lives inside the record's try, so a launch failure stays a per-record CAPTURE_FAILED
            // exactly like the per-capture launch it replaces; the process closes in the finally.
            if (!shared && input.browser?.isConnected()) { shared = input.browser; ownsShared = false; }
            if (!shared?.isConnected()) {
              shared = await timer.phase('launch', () => launchBrowser(), { step: 'suite-browser',
                scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex });
              ownsShared = true;
            }
            // `boot` = one capture end to end (a container for timings.json): its disjoint sub-spans
            // `context`, `navigation`, `steps` and `close` are recorded by the runner. The suite's
            // `launch` (shared process) is recorded once, outside this container.
            const raw = await timer.phase('boot', () => captureScenario(parseScenario(scenario.definition), record.runIndex, {
              fixtureBaseDir: resolve(workspace, item.fixtureRoot), signal: session.signal,
              locale: config.environment.locale, viewport: config.environment.viewport,
              timings: timer, browser: shared!,
              allowedOrigins: [...new Set([build.origin, ...(config.policy.allowedOrigins ?? [])])],
              // Managed sides answer with their own bytes: the harness health header cannot attest them.
              ...(serve[record.side] ? {} : { expectedBuild: { origin: build.origin, buildHash: build.buildHash } }),
            }), { step: 'scenario', scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex,
              steps: scenario.definition.steps.length });
            const trace = timer.phaseSync('capture', () => sanitizeTrace(raw, { pseudonymizationKey: key,
              allowedPayloadKeys: config.policy.sanitization?.allowedPayloadKeys ?? [],
              allowedStorageKeys: config.policy.sanitization?.allowedStorageKeys ?? [],
              sensitiveKeys: config.policy.sanitization?.sensitiveKeys ?? [],
            }), { step: 'sanitize', scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex });
            if (!trace.runId || trace.completion?.status !== 'COMPLETED') throw new Error('CAPTURE_INCOMPLETE');
            const path = await timer.phase('persistence', () => store.writeSanitized(record.unitId, record.side, trace),
              { step: 'trace-write', scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex });
            record.evidencePath = relative(output, path).split('\\').join('/');
            record.traceRunId = trace.runId; record.traceHash = digest(trace);
            // SCENARIO_END: after the scenario's steps.
            await timer.phase('capture', () => checkpointState('SCENARIO_END'),
              { step: 'state-scenario-end', scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex });
            // A required snapshot is part of this capture: without complete state evidence the record
            // is not COMPLETED, so source stability sees a missing run and fails closed.
            if (state.some(entry => entry.required && entry.completeness !== 'COMPLETE')) {
              record.status = 'INCONCLUSIVE'; record.reason = 'CAPTURE_FAILED';
            } else { record.status = 'COMPLETED'; delete record.reason; }
            if (record.status === 'COMPLETED' && record.side === 'source') { runs.push(trace); stateRuns.push(observed); }
          } catch (error) {
            record.status = 'INCONCLUSIVE'; record.reason = session.signal.aborted ? 'ABORTED' : 'CAPTURE_FAILED';
            if (error instanceof ScenarioExecutionError) {
              record.executionCode = error.code;
              if (error.stepId && MigrationIdSchema.safeParse(error.stepId).success) record.stepId = error.stepId;
            }
          }
        }
        await timer.phase('persistence', () => store.write(`captures/${record.scenarioId}/${record.side}/${record.runIndex}.json`, record),
          { step: 'capture-record', scenarioId: record.scenarioId, side: record.side, runIndex: record.runIndex });
      }
      report.stability.push({ scenarioId: item.definition.scenarioId, result: timer.phaseSync('comparison', () => verifyStateSourceStability({
        runs, requiredRuns: config.limits.sourceRuns, reset: config.reset, policy, captures: declaredState, stateRuns,
      }), { step: 'source-stability', scenarioId: item.definition.scenarioId }) });
    }
  };
  try {
    const result = await withProjectBuildServers({ config, workspaceRoot: workspace,
      ...(input.phase ? { phase: input.phase } : {}), ...(input.baseline ? { baseline: input.baseline } : {}),
      allowProjectCommands: true, ...(input.signal ? { signal: input.signal } : {}), timings: timer }, session => work = capture(session));
    report.builds = result.builds; report.checks = result.checks;
    report.status = report.captures.every(record => record.status === 'COMPLETED') ? 'COMPLETED' : 'INCONCLUSIVE';
  } catch (error) {
    report.failureCode = error instanceof ProjectBuildError ? error.code : 'SUITE_EXECUTION_FAILED';
    if (error instanceof ProjectBuildError && error.checks) report.checks = error.checks;
  } finally {
    // The managed server deadline may win its callback race; await our cooperative capture cleanup before persisting the result.
    await work?.catch(() => undefined);
    // Guaranteed process close for abort/crash paths: only a browser this suite launched is closed
    // here — an operation-supplied one stays with the operation, which closes it in its own finally.
    if (ownsShared && shared) await timer.phase('close', () => shared!.close().catch(() => undefined), { step: 'suite-browser' });
  }
  await timer.phase('persistence', () => store.write('capture-suite.json', report), { step: 'suite-report' });
  return report;
}
