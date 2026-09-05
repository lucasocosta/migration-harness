import { canonical, valueShape, matchPath, type EquivalenceDivergence, type HttpRequestEvent, type HttpResponseEvent, type HttpFailedEvent, type SanitizedObservedTrace } from '@migration-harness/core';

export interface PathTemplateRule { pattern: RegExp; template: string; }
export interface NetworkComparisonPolicy {
  volatileQueryParams?: readonly string[];
  volatilePayloadFields?: readonly string[];
  volatileResponseFields?: readonly string[];
  volatilePathParams?: Record<string, readonly string[]>;
  pathTemplateRules?: readonly PathTemplateRule[];
  comparePayloadShape?: boolean;
  compareStatusCode?: boolean;
  compareResponseShape?: boolean;
}
export interface HttpExchange {
  request: HttpRequestEvent;
  response?: HttpResponseEvent;
  failure?: HttpFailedEvent;
  trigger: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string[]>;
  payloadShape: unknown;
  responseShape: unknown;
}
export function buildExchanges(trace: SanitizedObservedTrace, policy: NetworkComparisonPolicy = {}): HttpExchange[] {
  const terminals = new Map(trace.events.flatMap(e => (e.type === 'HTTP_RESPONSE' || e.type === 'HTTP_FAILED') && e.correlationId ? [[e.correlationId, e] as const] : []));
  let trigger = 'initial_mount';
  return trace.events.flatMap(event => {
    if (event.type === 'USER_INTERACTION') trigger = event.stepId;
    if (event.type !== 'HTTP_REQUEST') return [];
    const url = new URL(event.url);
    let path = url.pathname;
    let params: Record<string, string> = {};
    for (const rule of policy.pathTemplateRules ?? []) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(path)) {
        const matched = matchPath(rule.template, path);
        if (!matched) throw new Error('Path rule pattern matches a path incompatible with its template.');
        params = matched;
        for (const name of policy.volatilePathParams?.[rule.template] ?? []) if (Object.hasOwn(params, name)) params[name] = '<VOLATILE>';
        path = rule.template;
        break;
      }
    }
    const terminal = terminals.get(event.correlationId ?? '');
    const payload = omitFields(event.payload, policy.volatilePayloadFields);
    return [{ request: event, trigger, path, params,
      query: Object.fromEntries([...new Set(url.searchParams.keys())].sort().filter(key => !(policy.volatileQueryParams ?? []).includes(key)).map(key => [key, url.searchParams.getAll(key)])),
      payloadShape: valueShape(payload), responseShape: terminal?.type === 'HTTP_RESPONSE' ? valueShape(omitFields(terminal.body, policy.volatileResponseFields)) : null,
      ...(terminal?.type === 'HTTP_RESPONSE' ? { response: terminal } : {}), ...(terminal?.type === 'HTTP_FAILED' ? { failure: terminal } : {}),
    }];
  });
}

export function omitFields(value: unknown, keys: readonly string[] = []): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) : value;
}
export function exchangeSignature(e: HttpExchange, policy: NetworkComparisonPolicy = {}): string {
  return canonical([e.request.method, e.params, e.query, policy.comparePayloadShape !== false ? e.payloadShape : null, policy.compareStatusCode !== false ? e.response?.statusCode ?? null : null,
    policy.compareResponseShape !== false ? e.responseShape : null, e.failure ? 'FAILED' : e.response ? 'RESPONSE' : 'INCOMPLETE']);
}
export function compareNetworkBehavior(source: SanitizedObservedTrace, target: SanitizedObservedTrace, policy: NetworkComparisonPolicy = {}): EquivalenceDivergence[] {
  const s = buildExchanges(source, policy), t = buildExchanges(target, policy);
  const divergences: EquivalenceDivergence[] = [];
  const add = (code: string, expected: unknown, actual: unknown, path: string): void => {
    divergences.push({ divergenceId: `${code}:${divergences.length}`, scenarioId: source.scenarioId, dimension: 'NETWORK', code, severity: 'BLOCKING', message: `${code} at ${path}`, ...(expected !== undefined ? { source: expected } : {}), ...(actual !== undefined ? { target: actual } : {}) });
  };
  const groups = new Set([...s, ...t].map(e => canonical([e.trigger, e.path])));
  for (const group of groups) {
    const left = s.filter(e => canonical([e.trigger, e.path]) === group);
    const right = t.filter(e => canonical([e.trigger, e.path]) === group);
    // Cancel exact exchanges as a multiset before localizing residual differences.
    const unmatched = left.filter(e => {
      const index = right.findIndex(other => exchangeSignature(e, policy) === exchangeSignature(other, policy));
      if (index < 0) return true;
      const other = right.splice(index, 1)[0]!;
      if (!e.response && !e.failure || !other.response && !other.failure) add('NETWORK_INCOMPLETE_EXCHANGE', e.request.url, other.request.url, e.path);
      return false;
    });
    for (let i = 0; i < Math.max(unmatched.length, right.length); i++) {
      const a = unmatched[i], b = right[i];
      if (!a) { add('NETWORK_UNEXPECTED_REQUEST', undefined, b?.request.method, b!.path); continue; }
      if (!b) { add('NETWORK_MISSING_REQUEST', a.request.method, undefined, a.path); continue; }
      const compare = (code: string, av: unknown, bv: unknown): void => { if (canonical(av) !== canonical(bv)) add(code, av, bv, a.path); };
      compare('NETWORK_METHOD_MISMATCH', a.request.method, b.request.method);
      compare('NETWORK_PATH_PARAMS_MISMATCH', a.params, b.params);
      compare('NETWORK_QUERY_MISMATCH', a.query, b.query);
      if (policy.comparePayloadShape !== false) compare('NETWORK_PAYLOAD_SHAPE_MISMATCH', a.payloadShape, b.payloadShape);
      if (policy.compareStatusCode !== false) compare('NETWORK_STATUS_MISMATCH', a.response?.statusCode, b.response?.statusCode);
      if (policy.compareResponseShape !== false) compare('NETWORK_RESPONSE_SHAPE_MISMATCH', a.responseShape, b.responseShape);
      compare('NETWORK_TRANSPORT_MISMATCH', Boolean(a.failure), Boolean(b.failure));
      if (!a.response && !a.failure || !b.response && !b.failure) add('NETWORK_INCOMPLETE_EXCHANGE', a.request.url, b.request.url, a.path);
    }
  }
  return divergences;
}
