import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
  canonical, MigrationIdSchema, MigrationPathSchema, migrationConfigHash, parseMigrationConfig, parseScenario,
  resolveScenarioForSide, scenarioBindingProjection, type ProjectCheckReport, type SanitizedObservedTrace,
  type ServedBuildIdentity,
} from '@migration-harness/core';
import { sanitizeTrace } from '@migration-harness/trace-sanitizer';
import { migrationComparisonPolicy, verifySourceStability, type SourceStabilityResult } from '@migration-harness/equivalence-validator';
import { ArtifactStore, safeArtifactPath } from './artifacts.js';
import { ProjectBuildError, withProjectBuildServers, type BuildServerSession } from './build-servers.js';
import { preflightProjectChecks, runProjectReset, type ProjectResetResult } from './project-checks.js';

type Side = 'source' | 'target';
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export interface SuiteCapture {
  scenarioId: string; unitId: string; required: boolean; side: Side; runIndex: number;
  status: 'COMPLETED' | 'INCONCLUSIVE' | 'NOT_RUN';
  reason?: 'RESET_FAILED' | 'CAPTURE_FAILED' | 'ABORTED' | 'NOT_RUN';
  reset?: ProjectResetResult;
  buildRunId?: string; buildHash?: string; bindingHash: string;
  traceRunId?: string; traceHash?: string; evidencePath?: string;
  stepId?: string; executionCode?: string;
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
}): Promise<CaptureSuiteResult> {
  const config = parseMigrationConfig(input.config);
  if (input.allowProjectCommands !== true) throw new Error('EXECUTION_NOT_AUTHORIZED');
  for (const scenario of config.scenarios) MigrationIdSchema.parse(scenario.definition.unitId);
  const artifactPath = MigrationPathSchema.parse(input.artifactPath);
  if ((await preflightProjectChecks(input)).status !== 'PASS') throw new Error('SUITE_PREFLIGHT_FAILED');
  const workspace = await realpath(resolve(input.workspaceRoot));
  const output = resolve(workspace, artifactPath);
  const overlaps = (path: string): boolean => path === output || path.startsWith(`${output}/`) || output.startsWith(`${path}/`);
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
  const capture = async (session: BuildServerSession): Promise<void> => {
    const { captureScenario, ScenarioExecutionError } = await import('@migration-harness/scenario-runner');
    report.builds = { source: session.source, target: session.target };
    for (const item of config.scenarios) {
      const runs: SanitizedObservedTrace[] = [];
      for (const record of report.captures.filter(record => record.scenarioId === item.definition.scenarioId)) {
        if (session.signal.aborted) return;
        const build = session[record.side];
        record.buildHash = build.buildHash; record.buildRunId = build.runId;
        record.reset = await runProjectReset({ config, workspaceRoot: workspace, side: record.side,
          allowProjectCommands: true, signal: session.signal });
        if (record.reset.status !== 'PASS') {
          record.status = 'INCONCLUSIVE'; record.reason = session.signal.aborted ? 'ABORTED' : 'RESET_FAILED';
        } else {
          try {
            const scenario = resolveScenarioForSide(config, record.scenarioId, record.side);
            const raw = await captureScenario(parseScenario(scenario.definition), record.runIndex, {
              fixtureBaseDir: resolve(workspace, item.fixtureRoot), signal: session.signal,
              locale: config.environment.locale, viewport: config.environment.viewport,
              allowedOrigins: [...new Set([build.origin, ...(config.policy.allowedOrigins ?? [])])],
              expectedBuild: { origin: build.origin, buildHash: build.buildHash },
            });
            const trace = sanitizeTrace(raw, { pseudonymizationKey: key,
              allowedPayloadKeys: config.policy.sanitization?.allowedPayloadKeys ?? [],
              allowedStorageKeys: config.policy.sanitization?.allowedStorageKeys ?? [],
              sensitiveKeys: config.policy.sanitization?.sensitiveKeys ?? [],
            });
            if (!trace.runId || trace.completion?.status !== 'COMPLETED') throw new Error('CAPTURE_INCOMPLETE');
            const path = await store.writeSanitized(record.unitId, record.side, trace);
            record.evidencePath = relative(output, path).split('\\').join('/');
            record.traceRunId = trace.runId; record.traceHash = digest(trace);
            record.status = 'COMPLETED'; delete record.reason;
            if (record.side === 'source') runs.push(trace);
          } catch (error) {
            record.status = 'INCONCLUSIVE'; record.reason = session.signal.aborted ? 'ABORTED' : 'CAPTURE_FAILED';
            if (error instanceof ScenarioExecutionError) {
              record.executionCode = error.code;
              if (error.stepId && MigrationIdSchema.safeParse(error.stepId).success) record.stepId = error.stepId;
            }
          }
        }
        await store.write(`captures/${record.scenarioId}/${record.side}/${record.runIndex}.json`, record);
      }
      report.stability.push({ scenarioId: item.definition.scenarioId, result: verifySourceStability({
        runs, requiredRuns: config.limits.sourceRuns, reset: config.reset, policy,
      }) });
    }
  };
  try {
    const result = await withProjectBuildServers({ config, workspaceRoot: workspace,
      ...(input.phase ? { phase: input.phase } : {}), ...(input.baseline ? { baseline: input.baseline } : {}),
      allowProjectCommands: true, ...(input.signal ? { signal: input.signal } : {}) }, session => work = capture(session));
    report.builds = result.builds; report.checks = result.checks;
    report.status = report.captures.every(record => record.status === 'COMPLETED') ? 'COMPLETED' : 'INCONCLUSIVE';
  } catch (error) {
    report.failureCode = error instanceof ProjectBuildError ? error.code : 'SUITE_EXECUTION_FAILED';
    if (error instanceof ProjectBuildError && error.checks) report.checks = error.checks;
  } finally {
    // The managed server deadline may win its callback race; await our cooperative capture cleanup before persisting the result.
    await work?.catch(() => undefined);
  }
  await store.write('capture-suite.json', report);
  return report;
}
