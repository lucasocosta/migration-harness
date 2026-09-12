import type {
  HttpEndpointInvariant,
  HttpRequestEvent,
  HttpResponseEvent,
  Invariant,
  RawObservedTrace,
} from '@migration-harness/core';

interface ObservedOpInstance {
  runIndex: number;
  request: HttpRequestEvent;
  response?: HttpResponseEvent;
}

export interface RuntimeHttpEvidence {
  candidateInvariants: Invariant<HttpEndpointInvariant>[];
}

export class InvariantMiner {
  static mineHttpRuntimeEvidence(runs: RawObservedTrace[]): RuntimeHttpEvidence {
    if (runs.length < 3) throw new Error('At least 3 runs are required for invariant mining.');
    if (new Set(runs.map(run => run.scenarioId)).size !== 1) throw new Error('Mining requires one scenario.');
    if (new Set(runs.map(run => run.runIndex)).size !== runs.length) throw new Error('Mining requires distinct run indices.');
    if (new Set(runs.map(run => run.runId ?? run.startedAt)).size !== runs.length) throw new Error('Mining requires distinct execution identities; changing runIndex does not create a new observation.');

    const operationMap = new Map<string, ObservedOpInstance[]>();
    for (const run of runs) {
      const responses = run.events.filter((e): e is HttpResponseEvent => e.type === 'HTTP_RESPONSE');
      for (const event of run.events) {
        if (event.type !== 'HTTP_REQUEST') continue;
        const request = event as HttpRequestEvent;
        const url = new URL(request.url);
        const key = `${request.method}:${url.pathname}`;
        const list = operationMap.get(key) ?? [];
        const response = responses.find((r) => r.correlationId === request.correlationId);
        list.push({
          runIndex: run.runIndex,
          request,
          ...(response ? { response } : {}),
        });
        operationMap.set(key, list);
      }
    }

    const candidateInvariants: Invariant<HttpEndpointInvariant>[] = [];
    for (const [key, observations] of operationMap) {
      const separator = key.indexOf(':');
      const method = key.slice(0, separator) as HttpEndpointInvariant['method'];
      const pathname = key.slice(separator + 1);
      const runsObserved = new Set(observations.map((o) => o.runIndex)).size;
      const presenceRatio = runsObserved / runs.length;
      const fieldRuns = new Map<string, Set<number>>();

      for (const observation of observations) {
        if (!isRecord(observation.request.payload)) continue;
        for (const field of Object.keys(observation.request.payload)) {
          const seen = fieldRuns.get(field) ?? new Set<number>();
          seen.add(observation.runIndex);
          fieldRuns.set(field, seen);
        }
      }

      const ignoredVolatileFields: string[] = [];
      const observedAlwaysFields: string[] = [];
      const observedSometimesFields: string[] = [];
      for (const [field, seen] of fieldRuns) {
        if (ignoredVolatileFields.includes(field)) continue;
        (seen.size === runs.length ? observedAlwaysFields : observedSometimesFields).push(field);
      }

      const statuses = [...new Set(observations.flatMap((o) => o.response ? [o.response.statusCode] : []))];
      candidateInvariants.push({
        id: `runtime_http_${method}_${pathname.replace(/[^a-zA-Z0-9]+/g, '_')}`,
        value: {
          pathTemplate: pathname,
          pathParams: {},
          queryParams: { required: [], optional: [], ignored: [] },
          method,
          payloadRequirements: {
            observedAlwaysFields,
            observedSometimesFields,
            requiredFields: [],
            optionalFields: [],
            ignoredVolatileFields,
          },
          responseExpectations: { allowedStatusCodes: statuses },
          causalDependencies: { afterOperationIds: [] },
        },
        evidenceTrail: [{
          source: 'RUNTIME_OBSERVATION',
          evidenceConfidenceHeuristic: Number((presenceRatio * 0.9).toFixed(2)),
          runsObservedCount: runsObserved,
          totalRunsEvaluated: runs.length,
        }],
        enforcement: presenceRatio === 1 ? 'WARNING' : 'INFORMATIONAL',
      });
    }

    return { candidateInvariants };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
