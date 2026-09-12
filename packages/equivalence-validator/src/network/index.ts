import { canonical, valueShape, matchPath, type EquivalenceDivergence, type HttpRequestEvent, type HttpResponseEvent, type HttpFailedEvent, type SanitizedObservedTrace } from '@migration-harness/core';
import { diffValues, valuePathPresent, type ValueDifference } from '../values.js';

export interface PathTemplateRule { pattern: RegExp; template: string; }
/** A value field that must be comparable for the criteria to be decidable. */
export interface RequiredValueField { method?: string; path?: string; field: string }
export interface NetworkComparisonPolicy {
  volatileQueryParams?: readonly string[];
  volatilePayloadFields?: readonly string[];
  volatileResponseFields?: readonly string[];
  volatilePathParams?: Record<string, readonly string[]>;
  pathTemplateRules?: readonly PathTemplateRule[];
  comparePayloadShape?: boolean;
  compareStatusCode?: boolean;
  compareResponseShape?: boolean;
  /**
   * Compare the observed request payload / response body values, not only their shapes. Opt-in: the v0.2
   * profile keeps shape-only comparison unless a policy enables it, and the standard profile requires it.
   */
  comparePayloadValues?: boolean;
  compareResponseValues?: boolean;
  requiredValueFields?: readonly RequiredValueField[];
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
  /** Retained values used for value comparison and evidence checks; never emitted in diagnostics. */
  payloadValue: unknown;
  responseValue: unknown;
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
    const body = terminal?.type === 'HTTP_RESPONSE' ? omitFields(terminal.body, policy.volatileResponseFields) : undefined;
    return [{ request: event, trigger, path, params,
      query: Object.fromEntries([...new Set(url.searchParams.keys())].sort().filter(key => !(policy.volatileQueryParams ?? []).includes(key)).map(key => [key, url.searchParams.getAll(key)])),
      payloadShape: valueShape(payload), responseShape: body === undefined ? null : valueShape(body),
      // Declared volatile field names are pruned at any depth for value comparison, so a tolerated nested
      // difference neither diverges nor changes the exchange identity used for causal labels.
      payloadValue: deepOmitFields(payload, policy.volatilePayloadFields ?? []),
      responseValue: body === undefined ? undefined : deepOmitFields(body, policy.volatileResponseFields ?? []),
      ...(terminal?.type === 'HTTP_RESPONSE' ? { response: terminal } : {}), ...(terminal?.type === 'HTTP_FAILED' ? { failure: terminal } : {}),
    }];
  });
}

export function omitFields(value: unknown, keys: readonly string[] = []): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) : value;
}
export function deepOmitFields(value: unknown, keys: readonly string[]): unknown {
  if (!keys.length) return value;
  if (Array.isArray(value)) return value.map(item => deepOmitFields(item, keys));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)).map(([key, child]) => [key, deepOmitFields(child, keys)]));
  return value;
}
export function exchangeSignature(e: HttpExchange, policy: NetworkComparisonPolicy = {}): string {
  return canonical([e.request.method, e.params, e.query, policy.comparePayloadShape !== false ? e.payloadShape : null, policy.compareStatusCode !== false ? e.response?.statusCode ?? null : null,
    policy.compareResponseShape !== false ? e.responseShape : null, e.failure ? 'FAILED' : e.response ? 'RESPONSE' : 'INCOMPLETE',
    // Values participate in identity only when they are compared, so equal exchanges still cancel out.
    policy.comparePayloadValues === true ? e.payloadValue : null, policy.compareResponseValues === true ? e.responseValue ?? null : null]);
}
/** Names of path parameters that differ, so a route defect stays localizable without exposing ids. */
function differingKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => canonical(left[key]) !== canonical(right[key])).sort();
}
export function compareNetworkBehavior(source: SanitizedObservedTrace, target: SanitizedObservedTrace, policy: NetworkComparisonPolicy = {}): EquivalenceDivergence[] {
  const s = buildExchanges(source, policy), t = buildExchanges(target, policy);
  const divergences: EquivalenceDivergence[] = [];
  const add = (code: string, expected: unknown, actual: unknown, path: string): void => {
    divergences.push({ divergenceId: `${code}:${divergences.length}`, scenarioId: source.scenarioId, dimension: 'NETWORK', code, severity: 'BLOCKING', message: `${code} at ${path}`, ...(expected !== undefined ? { source: expected } : {}), ...(actual !== undefined ? { target: actual } : {}) });
  };
  /** Diagnostics carry the structural location and the kinds involved, never an observed value. */
  const addValueDifference = (prefix: 'PAYLOAD' | 'RESPONSE', difference: ValueDifference, path: string): void => {
    divergences.push({
      divergenceId: `${prefix}:${difference.code}:${divergences.length}`, scenarioId: source.scenarioId,
      dimension: 'NETWORK', code: `NETWORK_${prefix}_${difference.code}`, severity: 'BLOCKING',
      message: `NETWORK_${prefix}_${difference.code} at ${path} ${difference.path}`,
      source: { path: difference.path, kind: difference.sourceKind }, target: { path: difference.path, kind: difference.targetKind },
    });
  };
  const compareValues = (a: HttpExchange, b: HttpExchange): void => {
    // Volatile fields are already pruned from the value projections built by buildExchanges.
    if (policy.comparePayloadValues === true) {
      for (const difference of diffValues(a.payloadValue, b.payloadValue, 'payload')) addValueDifference('PAYLOAD', difference, a.path);
    }
    if (policy.compareResponseValues === true) {
      for (const difference of diffValues(a.responseValue, b.responseValue, 'response')) addValueDifference('RESPONSE', difference, a.path);
    }
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
      if (!e.response && !e.failure || !other.response && !other.failure) add('NETWORK_INCOMPLETE_EXCHANGE', e.path, other.path, e.path);
      return false;
    });
    for (let i = 0; i < Math.max(unmatched.length, right.length); i++) {
      const a = unmatched[i], b = right[i];
      if (!a) { add('NETWORK_UNEXPECTED_REQUEST', undefined, b?.request.method, b!.path); continue; }
      if (!b) { add('NETWORK_MISSING_REQUEST', a.request.method, undefined, a.path); continue; }
      const compare = (code: string, av: unknown, bv: unknown): void => { if (canonical(av) !== canonical(bv)) add(code, av, bv, a.path); };
      compare('NETWORK_METHOD_MISMATCH', a.request.method, b.request.method);
      if (canonical(a.params) !== canonical(b.params)) add('NETWORK_PATH_PARAMS_MISMATCH', { pathParams: differingKeys(a.params, b.params) }, undefined, a.path);
      if (canonical(a.query) !== canonical(b.query)) add('NETWORK_QUERY_MISMATCH', { queryParams: differingKeys(a.query, b.query) }, undefined, a.path);
      if (policy.comparePayloadShape !== false) compare('NETWORK_PAYLOAD_SHAPE_MISMATCH', a.payloadShape, b.payloadShape);
      if (policy.compareStatusCode !== false) compare('NETWORK_STATUS_MISMATCH', a.response?.statusCode, b.response?.statusCode);
      if (policy.compareResponseShape !== false) compare('NETWORK_RESPONSE_SHAPE_MISMATCH', a.responseShape, b.responseShape);
      compare('NETWORK_TRANSPORT_MISMATCH', Boolean(a.failure), Boolean(b.failure));
      compareValues(a, b);
      if (!a.response && !a.failure || !b.response && !b.failure) add('NETWORK_INCOMPLETE_EXCHANGE', a.path, b.path, a.path);
    }
  }
  divergences.push(...missingValueEvidence(source.scenarioId, s, t, policy));
  return divergences;
}

/**
 * A declared required value field that neither side exposes cannot be judged: the operation may be absent,
 * or sanitization may have dropped the field. That is insufficient evidence, never a pass.
 */
function missingValueEvidence(scenarioId: string, source: readonly HttpExchange[], target: readonly HttpExchange[], policy: NetworkComparisonPolicy): EquivalenceDivergence[] {
  const divergences: EquivalenceDivergence[] = [];
  for (const rule of policy.requiredValueFields ?? []) {
    const [prefix, ...rest] = rule.field.split('.');
    const relative = rest.join('.');
    const applies = (exchange: HttpExchange): boolean => (!rule.method || rule.method.toUpperCase() === exchange.request.method.toUpperCase()) && (!rule.path || rule.path === exchange.path);
    const matched = [...source, ...target].filter(applies);
    const observed = prefix === 'payload' || prefix === 'response'
      ? matched.some(exchange => valuePathPresent(prefix === 'payload' ? exchange.payloadValue : exchange.responseValue, relative))
      : false;
    if (!observed) {
      divergences.push({
        divergenceId: `VALUE_EVIDENCE_OMITTED:${divergences.length}`, scenarioId, dimension: 'CONTRACT',
        code: 'VALUE_EVIDENCE_OMITTED', severity: 'BLOCKING',
        message: `A required value field is not observable on either side: ${rule.field}`,
        source: { field: rule.field, observedOperations: matched.length },
      });
    }
  }
  return divergences;
}
