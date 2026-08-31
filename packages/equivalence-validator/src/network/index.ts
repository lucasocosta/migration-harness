import type {
  EquivalenceDivergence,
  HttpRequestEvent,
  HttpResponseEvent,
  SanitizedObservedTrace,
} from '@migration-harness/core';

export interface PathTemplateRule {
  pattern: RegExp;
  template: string;
}

export interface NetworkComparisonPolicy {
  volatileQueryParams?: readonly string[];
  pathTemplateRules?: readonly PathTemplateRule[];
  comparePayloadShape?: boolean;
  compareStatusCode?: boolean;
}

interface HttpExchange {
  request: HttpRequestEvent;
  response?: HttpResponseEvent;
  normalized: {
    pathTemplate: string;
    query: Record<string, string[]>;
    payloadShape: unknown;
  };
}

export function compareNetworkBehavior(
  source: SanitizedObservedTrace,
  target: SanitizedObservedTrace,
  policy: NetworkComparisonPolicy = {},
): EquivalenceDivergence[] {
  const sourceExchanges = buildExchanges(source, policy);
  const targetExchanges = buildExchanges(target, policy);
  const divergences: EquivalenceDivergence[] = [];

  const sourceByPath = groupByPath(sourceExchanges);
  const targetByPath = groupByPath(targetExchanges);
  const allPaths = new Set([...sourceByPath.keys(), ...targetByPath.keys()]);

  for (const path of allPaths) {
    const sourceItems = sourceByPath.get(path) ?? [];
    const targetItems = targetByPath.get(path) ?? [];
    const max = Math.max(sourceItems.length, targetItems.length);

    for (let index = 0; index < max; index += 1) {
      const s = sourceItems[index];
      const t = targetItems[index];
      const base = `${path}#${index + 1}`;

      if (!s) {
        divergences.push(divergence(source.scenarioId, 'NETWORK_UNEXPECTED_REQUEST',
          `Target emitted an additional request for ${path}.`, undefined, summarize(t), base));
        continue;
      }
      if (!t) {
        divergences.push(divergence(source.scenarioId, 'NETWORK_MISSING_REQUEST',
          `Target did not emit an expected request for ${path}.`, summarize(s), undefined, base));
        continue;
      }

      if (s.request.method !== t.request.method) {
        divergences.push(divergence(source.scenarioId, 'NETWORK_METHOD_MISMATCH',
          `HTTP method differs for ${path}.`, s.request.method, t.request.method, base));
      }

      if (!deepEqual(s.normalized.query, t.normalized.query)) {
        divergences.push(divergence(source.scenarioId, 'NETWORK_QUERY_MISMATCH',
          `Query parameters differ for ${path}.`, s.normalized.query, t.normalized.query, base));
      }

      if (policy.comparePayloadShape !== false && !deepEqual(s.normalized.payloadShape, t.normalized.payloadShape)) {
        divergences.push(divergence(source.scenarioId, 'NETWORK_PAYLOAD_SHAPE_MISMATCH',
          `Request payload shape differs for ${path}.`, s.normalized.payloadShape, t.normalized.payloadShape, base));
      }

      if (policy.compareStatusCode !== false && s.response?.statusCode !== t.response?.statusCode) {
        divergences.push(divergence(source.scenarioId, 'NETWORK_STATUS_MISMATCH',
          `HTTP response status differs for ${path}.`, s.response?.statusCode, t.response?.statusCode, base));
      }
    }
  }

  return divergences;
}

function buildExchanges(trace: SanitizedObservedTrace, policy: NetworkComparisonPolicy): HttpExchange[] {
  const responseByCorrelation = new Map<string, HttpResponseEvent>();
  for (const event of trace.events) {
    if (event.type === 'HTTP_RESPONSE' && event.correlationId) responseByCorrelation.set(event.correlationId, event);
  }

  return trace.events
    .filter((event): event is HttpRequestEvent => event.type === 'HTTP_REQUEST')
    .map((request) => {
      const url = new URL(request.url);
      const volatile = new Set(policy.volatileQueryParams ?? []);
      const query: Record<string, string[]> = {};
      for (const key of [...new Set(url.searchParams.keys())].sort()) {
        if (!volatile.has(key)) query[key] = url.searchParams.getAll(key).sort();
      }
      const response = request.correlationId ? responseByCorrelation.get(request.correlationId) : undefined;
      return {
        request,
        ...(response !== undefined ? { response } : {}),
        normalized: {
          pathTemplate: normalizePath(url.pathname, policy.pathTemplateRules ?? []),
          query,
          payloadShape: valueShape(request.payload),
        },
      };
    });
}

function normalizePath(pathname: string, rules: readonly PathTemplateRule[]): string {
  for (const rule of rules) {
    if (rule.pattern.test(pathname)) return rule.template;
  }
  return pathname;
}

function groupByPath(exchanges: HttpExchange[]): Map<string, HttpExchange[]> {
  const result = new Map<string, HttpExchange[]>();
  for (const exchange of exchanges) {
    const items = result.get(exchange.normalized.pathTemplate) ?? [];
    items.push(exchange);
    result.set(exchange.normalized.pathTemplate, items);
  }
  return result;
}

function valueShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [valueShape(value[0])];
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, valueShape(item)]));
  }
  if (value === null) return 'null';
  return typeof value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarize(exchange: HttpExchange | undefined): unknown {
  if (!exchange) return undefined;
  return {
    method: exchange.request.method,
    pathTemplate: exchange.normalized.pathTemplate,
    query: exchange.normalized.query,
    payloadShape: exchange.normalized.payloadShape,
    statusCode: exchange.response?.statusCode,
  };
}

function divergence(
  scenarioId: string,
  code: string,
  message: string,
  source: unknown,
  target: unknown,
  suffix: string,
): EquivalenceDivergence {
  return {
    divergenceId: `${code}:${suffix}`,
    scenarioId,
    dimension: 'NETWORK',
    code,
    severity: 'BLOCKING',
    message,
    ...(source !== undefined ? { source } : {}),
    ...(target !== undefined ? { target } : {}),
  };
}
