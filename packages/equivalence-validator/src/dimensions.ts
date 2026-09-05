import { canonical, normalizeUrl, type EquivalenceDivergence, type EquivalenceDimension, type SanitizedObservedTrace, type TraceEvent } from '@migration-harness/core';
import { buildExchanges, exchangeSignature, type NetworkComparisonPolicy } from './network/index.js';

export interface ObservablePolicy {
  volatileQueryParams?: readonly string[];
  ignoredStorageKeys?: readonly string[];
  volatileStorageValues?: ReadonlyArray<{ storageType: 'localStorage' | 'sessionStorage'; key: string }>;
  ariaSeverity?: 'BLOCKING' | 'WARNING' | 'INFORMATIONAL';
  navigationAliases?: Record<string, string>;
}
export function compareObservables(source: SanitizedObservedTrace, target: SanitizedObservedTrace, policy: ObservablePolicy = {}): EquivalenceDivergence[] {
  const divergences: EquivalenceDivergence[] = [];
  const compare = (dimension: EquivalenceDimension, code: string, left: unknown, right: unknown): void => {
    if (canonical(left) !== canonical(right)) divergences.push({ divergenceId: code, scenarioId: source.scenarioId, dimension, code, severity: dimension === 'ARIA' ? policy.ariaSeverity ?? 'WARNING' : 'BLOCKING', message: `${dimension} observations differ.`, source: left, target: right });
  };
  const navigation = (trace: SanitizedObservedTrace) => trace.events.filter(e => e.type === 'NAVIGATION').map(e => {
    const path = normalizeUrl(e.toUrl, policy.volatileQueryParams);
    return policy.navigationAliases?.[path] ?? path;
  });
  const storage = (trace: SanitizedObservedTrace) => {
    const keys = new Map<string, unknown[]>();
    for (const event of trace.events) if (event.type === 'STORAGE_DELTA' && !(policy.ignoredStorageKeys ?? []).includes(event.key)) {
      const key = `${event.storageType}:${event.key}`;
      const volatile = policy.volatileStorageValues?.some(rule => rule.storageType === event.storageType && rule.key === event.key);
      const value = (item: string | null) => volatile && item !== null ? '<VOLATILE>' : item;
      keys.set(key, [...keys.get(key) ?? [], [event.mutationType, value(event.previousValue), value(event.newValue)]]);
    }
    return Object.fromEntries(keys);
  };
  const aria = (trace: SanitizedObservedTrace) => trace.events.filter(e => e.type === 'ARIA_STATE_CHANGE').map(e => ({
    checkpoint: checkpoint(trace, e.triggerEventId),
    tree: Object.keys(e.jsonTree).length ? normalizeAria(e.jsonTree) : e.rawYamlTree,
  }));
  compare('NAVIGATION', 'NAVIGATION_MISMATCH', navigation(source), navigation(target));
  compare('STATE', 'STORAGE_MISMATCH', storage(source), storage(target));
  compare('ARIA', 'ARIA_SEMANTICS_MISMATCH', aria(source), aria(target));
  if ([source, target].some(trace => trace.events.some(event => event.type === 'ARIA_STATE_CHANGE' && !Object.keys(event.jsonTree).length && !event.rawYamlTree))) divergences.push({ divergenceId: 'ARIA_CAPTURE_MISSING', scenarioId: source.scenarioId, dimension: 'ARIA', code: 'ARIA_CAPTURE_MISSING', severity: 'WARNING', message: 'An ARIA checkpoint contains no semantic evidence.' });
  compare('CONTRACT', 'SCENARIO_STEPS_MISMATCH', source.events.filter(e => e.type === 'USER_INTERACTION').map(e => [e.stepId, e.action]), target.events.filter(e => e.type === 'USER_INTERACTION').map(e => [e.stepId, e.action]));
  for (const trace of [source, target]) if (trace.completion?.status === 'FAILED') divergences.push({ divergenceId: `SCENARIO_FAILED:${divergences.length}`, scenarioId: source.scenarioId, dimension: 'CONTRACT', code: 'SCENARIO_FAILED', severity: 'BLOCKING', message: 'A required scenario failed.' });
  return divergences;
}
function checkpoint(trace: SanitizedObservedTrace, triggerId: string): string {
  const event = trace.events.find(event => event.eventId === triggerId);
  return event?.type === 'USER_INTERACTION' ? `step:${event.stepId}` : triggerId;
}
export function normalizeAria(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAria);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['box', 'ref', 'cursor'].includes(key)).map(([key, item]) => [key, key === 'url' && typeof item === 'string' ? normalizeUrl(item) : normalizeAria(item)]));
  return value;
}

/** Compare declared causal ancestors, not request completion timestamps. */
export function compareCausality(source: SanitizedObservedTrace, target: SanitizedObservedTrace, policy: NetworkComparisonPolicy = {}): EquivalenceDivergence[] {
  const graph = (trace: SanitizedObservedTrace): Array<{ label: string; ancestors: Set<number> }> => {
    const events = new Map(trace.events.map(e => [e.eventId, e]));
    const exchanges = buildExchanges(trace, policy);
    const labels = new Map<string, string>();
    for (const item of exchanges) {
      const label = canonical([item.trigger, item.path, exchangeSignature(item, policy)]);
      labels.set(item.request.eventId, `request:${label}`);
      if (item.response) labels.set(item.response.eventId, `response:${label}`);
      if (item.failure) labels.set(item.failure.eventId, `failure:${label}`);
    }
    for (const event of trace.events) if (event.type === 'USER_INTERACTION') labels.set(event.eventId, `step:${event.stepId}`);
    const relevant = trace.events.filter(e => labels.has(e.eventId));
    const indices = new Map(relevant.map((event, index) => [event.eventId, index]));
    const ancestors = (event: TraceEvent): Set<number> => {
      const result = new Set<number>();
      const pending = [...event.causedByEventIds ?? []];
      const visited = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        if (indices.has(id)) result.add(indices.get(id)!);
        pending.push(...events.get(id)?.causedByEventIds ?? []);
      }
      return result;
    };
    return relevant.map(e => ({ label: labels.get(e.eventId)!, ancestors: ancestors(e) }));
  };
  const left = graph(source), right = graph(target);
  let budget = 20000;
  const alignment = new Map<number, number>(), used = new Set<number>();
  const candidates = left.map(node => right.flatMap((other, index) => node.label === other.label && node.ancestors.size === other.ancestors.size ? [index] : []));
  const order = left.map((_, index) => index).sort((a, b) => candidates[a]!.length - candidates[b]!.length);
  const align = (offset: number): boolean => {
    if (--budget < 0) return false;
    if (offset === order.length) return true;
    const index = order[offset]!;
    for (const other of candidates[index]!) {
      if (used.has(other)) continue;
      if ([...alignment].some(([a, b]) => left[index]!.ancestors.has(a) !== right[other]!.ancestors.has(b) || left[a]!.ancestors.has(index) !== right[b]!.ancestors.has(other))) continue;
      alignment.set(index, other); used.add(other);
      if (align(offset + 1)) return true;
      alignment.delete(index); used.delete(other);
    }
    return false;
  };
  if (left.length === right.length && left.length <= 1000 && align(0)) return [];
  const code = budget < 0 || left.length > 1000 ? 'CAUSAL_ALIGNMENT_BUDGET_EXCEEDED' : 'CAUSAL_ORDER_MISMATCH';
  return [{ divergenceId: code, scenarioId: source.scenarioId, dimension: 'NETWORK', code, severity: 'BLOCKING', message: 'Declared causal dependencies differ or cannot be aligned within the comparison budget.' }];
}
