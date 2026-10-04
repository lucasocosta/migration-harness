import { createHash } from 'node:crypto';
import {
  canonical, normalizeUrl, parseSanitizedTrace, SourceObservationsSchema,
  type EquivalenceDivergence, type SanitizedObservedTrace, type SuggestionReport,
} from '@migration-harness/core';
import { buildExchanges, compareNetworkBehavior, exchangeSignature, type NetworkComparisonPolicy } from './network/index.js';
import { compareCausality, compareObservables, type ObservablePolicy } from './dimensions.js';
import { compareWebSockets, type WebSocketComparisonPolicy } from './websocket.js';
import { proposeNoiseSuggestions } from './noise-suggestions.js';

/**
 * Source/source repeatability.
 *
 * A reference is only worth comparing against if the source behaves the same way twice under the declared
 * reset. This compares repeated source executions with the very policy used for the migration comparison and
 * reports what differed. It deliberately does not infer volatility: an unstable field is reported so the
 * owner can decide, because silently ignoring it would weaken the criteria without a decision.
 */
export type SourceObservations = ReturnType<typeof SourceObservationsSchema.parse>;
/** Same comparison dimensions as a migration comparison, minus requirements: stability is preservation only. */
export interface StabilityPolicy {
  network?: NetworkComparisonPolicy;
  observables?: ObservablePolicy;
  websockets?: WebSocketComparisonPolicy;
}
export interface SourceStabilityInput {
  /** Independent source executions, produced with a reset between them. */
  runs: readonly SanitizedObservedTrace[];
  /** Minimum number of runs the configuration requires (`limits.sourceRuns`). */
  requiredRuns: number;
  /** Declared reset strategy; stability without a declared reset is not a claim this makes. */
  reset: { kind: 'ISOLATED_FIXTURES' } | { kind: 'COMMANDS'; sourceCommandId: string; targetCommandId: string };
  policy?: StabilityPolicy;
}
export interface SourceStabilityResult {
  /** Ready to be recorded in a versioned reference; NOT_COLLECTED when the runs are insufficient. */
  observations: SourceObservations;
  resetKind: 'ISOLATED_FIXTURES' | 'COMMANDS';
  requiredRuns: number;
  observedRuns: number;
  /** Blocking codes seen between source executions: these make the source unstable. */
  unstableCodes: string[];
  /** Non-blocking differences between source executions, disclosed rather than ignored. */
  advisoryCodes: string[];
  /** Structural locations to review; the owner declares volatility, the harness never assumes it. */
  reviewPaths: string[];
  /**
   * Ranked noise proposals derived from source/source divergences. HINT_ONLY: never applied
   * to policy or acceptedDifferences (RFC §7). Absent when runs are insufficient or stable.
   */
  suggestions?: SuggestionReport;
}

/** Comparison-relevant projection of one execution: policy-filtered exchanges, routes, state and steps. */
export function comparableProjection(trace: SanitizedObservedTrace, policy: StabilityPolicy = {}): unknown {
  const network = policy.network ?? {};
  return {
    scenarioId: trace.scenarioId,
    exchanges: buildExchanges(trace, network).map(exchange => canonical([exchange.trigger, exchange.path, exchangeSignature(exchange, network)])).sort(),
    navigation: trace.events.flatMap(event => event.type === 'NAVIGATION' ? [normalizeUrl(event.toUrl, policy.observables?.volatileQueryParams)] : []),
    storage: trace.events.flatMap(event => event.type === 'STORAGE_DELTA' && !(policy.observables?.ignoredStorageKeys ?? []).includes(event.key)
      ? [[event.storageType, event.key, event.mutationType, event.newValue]] : []),
    aria: trace.events.flatMap(event => event.type === 'ARIA_STATE_CHANGE' ? [event.jsonTree] : []),
    steps: trace.events.flatMap(event => event.type === 'USER_INTERACTION' ? [[event.stepId, event.action]] : []),
    completion: trace.completion?.status ?? null,
  };
}
export const executionHash = (trace: SanitizedObservedTrace, policy: StabilityPolicy = {}): string =>
  createHash('sha256').update(canonical(comparableProjection(trace, policy))).digest('hex');

const safeLocation = (divergence: EquivalenceDivergence): string => {
  const detail = (divergence.source ?? divergence.target) as { path?: unknown; key?: unknown } | null | undefined;
  const path = detail && typeof detail === 'object' && typeof detail.path === 'string' ? detail.path : undefined;
  return `${divergence.code}${path ? ` ${path}` : ''}`;
};

/** Preservation comparison between two executions of the same side, in the validator's own order. */
function compareRuns(first: SanitizedObservedTrace, second: SanitizedObservedTrace, policy: StabilityPolicy): EquivalenceDivergence[] {
  const divergences = compareNetworkBehavior(first, second, policy.network);
  divergences.push(...compareObservables(first, second, policy.observables));
  if (!divergences.some(item => item.dimension === 'NETWORK')) divergences.push(...compareCausality(first, second, policy.network));
  divergences.push(...compareWebSockets(first, second, policy.websockets));
  return divergences;
}

export function verifySourceStability(input: SourceStabilityInput): SourceStabilityResult {
  const runs = input.runs.map(run => parseSanitizedTrace(run));
  if (!Number.isSafeInteger(input.requiredRuns) || input.requiredRuns < 2) throw new Error('Source stability requires at least two declared runs.');
  if (new Set(runs.map(run => run.scenarioId)).size > 1) throw new Error('Source stability compares runs of one scenario.');
  const base = { resetKind: input.reset.kind, requiredRuns: input.requiredRuns, observedRuns: runs.length };
  if (runs.length < input.requiredRuns) {
    return { ...base, observations: SourceObservationsSchema.parse({ status: 'NOT_COLLECTED', runs: 0 }), unstableCodes: [], advisoryCodes: [], reviewPaths: [] };
  }
  const divergences = runs.slice(1).flatMap(run => compareRuns(runs[0]!, run, input.policy ?? {}));
  const unstableCodes = [...new Set(divergences.filter(item => item.severity === 'BLOCKING').map(item => item.code))].sort();
  const advisoryCodes = [...new Set(divergences.filter(item => item.severity !== 'BLOCKING').map(item => item.code))].sort();
  const reviewPaths = [...new Set(divergences.map(safeLocation))].sort();
  const executionHashes = runs.map(run => executionHash(run, input.policy));
  return {
    ...base,
    observations: SourceObservationsSchema.parse({ status: unstableCodes.length ? 'UNSTABLE' : 'STABLE', runs: runs.length, executionHashes }),
    unstableCodes, advisoryCodes, reviewPaths,
    ...(divergences.length ? {
      suggestions: proposeNoiseSuggestions({
        scenarioId: runs[0]!.scenarioId, runCount: runs.length, divergences,
        generatedAt: new Date().toISOString(),
      }),
    } : {}),
  };
}
