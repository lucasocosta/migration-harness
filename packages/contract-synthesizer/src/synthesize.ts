import { parseSanitizedTrace, parseContract, canonical, normalizeUrl, matchPath, type BehaviorContract, type SanitizedObservedTrace, type Invariant, type HttpEndpointInvariant, type ContractEvidence } from '@migration-harness/core';
import { InvariantMiner } from './invariant-miner.js';
import { EvidenceFusionEngine } from './evidence-fusion.js';

export function synthesizeContract(unitId: string, runs: SanitizedObservedTrace[], additionalEvidence: Invariant<HttpEndpointInvariant>[] = []): BehaviorContract {
  const validated = runs.map(parseSanitizedTrace);
  const groups = new Map<string, SanitizedObservedTrace[]>();
  for (const run of validated) groups.set(run.scenarioId, [...groups.get(run.scenarioId) ?? [], run]);
  return parseContract({ unitId, contractId: `${unitId}-contract`, version: '1.0.0', status: 'DRAFT', integrity: { algorithm: 'sha256', contentHash: '' },
    scenarios: [...groups].map(([scenarioId, traces]) => {
      const candidates = InvariantMiner.mineHttpRuntimeEvidence(traces).candidateInvariants;
      const applicable = additionalEvidence.filter(evidence => candidates.some(candidate => candidate.value.method === evidence.value.method && matchPath(evidence.value.pathTemplate, candidate.value.pathTemplate) !== undefined));
      return { scenarioId, invariants: { network: new EvidenceFusionEngine().fuseHttpEvidence(candidates, applicable), ...mineObservables(traces) } };
    }),
  });
}

function mineObservables(traces: SanitizedObservedTrace[]): Pick<BehaviorContract['scenarios'][number]['invariants'], 'storageDeltas' | 'navigation' | 'accessibilityAriaJson'> {
  const evidence = (count: number): ContractEvidence[] => [{ source: 'RUNTIME_OBSERVATION', evidenceConfidenceHeuristic: 0.9 * count / traces.length, runsObservedCount: count, totalRunsEvaluated: traces.length, sourceReference: `traces:${traces[0]!.scenarioId}` }];
  const navigation = traces.map(trace => trace.events.filter(event => event.type === 'NAVIGATION').at(-1)).map(event => event ? normalizeUrl(event.toUrl) : undefined);
  const finalAria = traces.map(trace => trace.events.filter(event => event.type === 'ARIA_STATE_CHANGE').at(-1)?.jsonTree);
  const storage = new Map<string, { value: BehaviorContract['scenarios'][number]['invariants']['storageDeltas'][number]['value'][number]; runs: Set<number> }>();
  traces.forEach((trace, run) => {
    for (const event of trace.events) if (event.type === 'STORAGE_DELTA') {
      const value = { storageType: event.storageType, mutationType: event.mutationType, key: event.key };
      const key = canonical(value);
      const entry = storage.get(key) ?? { value, runs: new Set<number>() };
      entry.runs.add(run); storage.set(key, entry);
    }
  });
  return {
    storageDeltas: [...storage.values()].map((entry, index) => ({ id: `observed-storage-${index}`, value: [entry.value], evidenceTrail: evidence(entry.runs.size), enforcement: entry.runs.size === traces.length ? 'WARNING' : 'INFORMATIONAL' })),
    ...(navigation[0] && navigation.every(value => value === navigation[0]) ? { navigation: [{ id: 'observed-final-navigation', value: { destination: navigation[0] }, evidenceTrail: evidence(traces.length), enforcement: 'WARNING' as const }] } : {}),
    ...(finalAria[0] && finalAria.every(value => canonical(value) === canonical(finalAria[0])) ? { accessibilityAriaJson: { id: 'observed-final-aria', value: finalAria[0], evidenceTrail: evidence(traces.length), enforcement: 'WARNING' as const } } : {}),
  };
}
