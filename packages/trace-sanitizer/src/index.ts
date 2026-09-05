import { createHmac } from 'node:crypto';
import { stringify } from 'yaml';
import { parseRawTrace, parseSanitizedTrace, valueShape, type RawObservedTrace, type SanitizedObservedTrace, type TraceEvent } from '@migration-harness/core';

const sensitive = /authorization|cookie|token|password|secret|api.?key|credit.?card|cardnumber|cvv/i;
const pii = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|Bearer\s+[\w.~+/=-]+/giu;
const ariaKeys = new Set(['role', 'name', 'text', 'children', 'checked', 'disabled', 'expanded', 'active', 'invalid', 'level', 'pressed', 'selected', 'url', 'placeholder']);
export interface SanitizationPolicy {
  pseudonymizationKey: string;
  allowedPayloadKeys?: readonly string[];
  allowedStorageKeys?: readonly string[];
  sensitiveKeys?: readonly string[];
}

export function sanitizeTrace(input: RawObservedTrace, policy: SanitizationPolicy): SanitizedObservedTrace {
  if (policy.pseudonymizationKey.length < 32) throw new Error('A shared pseudonymization key of at least 32 characters is required.');
  const raw = parseRawTrace(input);
  let count = 0;
  const pseudo = (value: string): string => {
    count++;
    return `p_${createHmac('sha256', policy.pseudonymizationKey).update(value).digest('hex').slice(0, 24)}`;
  };
  const scrubText = (value: string): string => value.normalize('NFC').replace(pii, match => pseudo(match));
  const isSensitive = (key: string): boolean => {
    const normalized = key.normalize('NFKC').toLowerCase();
    return ['__proto__', 'constructor', 'prototype'].includes(normalized) || sensitive.test(normalized) || (policy.sensitiveKeys ?? []).includes(normalized);
  };
  const scrub = (value: unknown, mode: 'payload' | 'aria' = 'payload', approved = false): unknown => {
    if (typeof value === 'string') return mode === 'payload' && !approved ? pseudo(value) : scrubText(value);
    if (Array.isArray(value)) return value.map(item => scrub(item, mode, approved));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (isSensitive(key)) { count++; return []; }
      if (mode === 'aria' && !ariaKeys.has(key)) return [];
      if (mode === 'payload' && !(policy.allowedPayloadKeys ?? []).includes(key)) { count++; return []; }
      return [[scrubText(key), mode === 'aria' && key === 'url' && typeof child === 'string' ? url(child) : scrub(child, mode, true)]];
    }));
    if (mode === 'payload' && !approved && typeof value === 'number') { count++; return 0; }
    return value;
  };
  const url = (value: string): string => {
    try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) count++;
    parsed.username = ''; parsed.password = '';
    for (const key of [...new Set(parsed.searchParams.keys())]) {
      const values = parsed.searchParams.getAll(key);
      parsed.searchParams.delete(key);
      if (isSensitive(key)) { count++; continue; }
      for (const item of values) parsed.searchParams.append(scrubText(key), scrubText(item));
    }
    parsed.pathname = parsed.pathname.split('/').map(part => encodeURIComponent(scrubText(decodeURIComponent(part)))).join('/');
    parsed.hash = sensitive.test(parsed.hash) ? '' : scrubText(decodeURIComponent(parsed.hash));
    return parsed.toString();
    } catch {
      return `https://redacted.invalid/${pseudo(value)}`;
    }
  };
  const events = raw.events.flatMap<TraceEvent>(event => {
    switch (event.type) {
      case 'HTTP_REQUEST': return [{ ...event, url: url(event.url), headers: {}, payload: scrub(event.payload) }];
      case 'HTTP_RESPONSE': return [{ ...event, url: url(event.url), headers: {}, body: scrub(event.body) }];
      case 'HTTP_FAILED': return [{ ...event, url: url(event.url), errorText: 'TRANSPORT_FAILURE' }];
      case 'NAVIGATION': return [{ ...event, fromUrl: url(event.fromUrl), toUrl: url(event.toUrl) }];
      case 'USER_INTERACTION': return [{ ...event, ...(event.inputValue !== undefined ? { inputValue: pseudo(event.inputValue) } : {}), ...(event.targetAriaName !== undefined ? { targetAriaName: scrubText(event.targetAriaName) } : {}) }];
      case 'ARIA_STATE_CHANGE': {
        const jsonTree = scrub(event.jsonTree, 'aria') as Record<string, unknown>;
        return [{ ...event, rawYamlTree: Object.keys(jsonTree).length ? stringify(jsonTree) : '', jsonTree }];
      }
      case 'STORAGE_DELTA':
        if (isSensitive(event.key) || !(policy.allowedStorageKeys ?? []).includes(event.key)) { count++; return []; }
        return [{ ...event, previousValue: event.previousValue === null ? null : scrubText(event.previousValue), newValue: event.newValue === null ? null : scrubText(event.newValue) }];
      case 'WEBSOCKET_FRAME': return [{ ...event, url: url(event.url), payload: scrub(event.payload) }];
    }
  });
  const retained = new Set(events.map(event => event.eventId));
  for (const event of events) if (event.causedByEventIds) event.causedByEventIds = event.causedByEventIds.filter(id => retained.has(id));
  return parseSanitizedTrace({ ...raw, events, sanitization: { version: '0.4.0', appliedAt: new Date().toISOString(), redactionsCount: count } });
}

/** Runtime strings never enter the worker context, even when they look sanitized. */
export function projectTraceForLlm(input: SanitizedObservedTrace): { kind: 'LLM_SAFE_TRACE'; events: unknown[] } {
  const trace = parseSanitizedTrace(input);
  return { kind: 'LLM_SAFE_TRACE', events: trace.events.map(event => {
    switch (event.type) {
      case 'HTTP_REQUEST': return { type: event.type, method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(event.method) ? event.method : 'OTHER', payloadTypes: leafTypes(valueShape(event.payload)) };
      case 'HTTP_RESPONSE': return { type: event.type, statusCode: event.statusCode, bodyTypes: leafTypes(valueShape(event.body)) };
      case 'USER_INTERACTION': return { type: event.type, action: event.action };
      case 'STORAGE_DELTA': return { type: event.type, storageType: event.storageType, mutationType: event.mutationType };
      case 'WEBSOCKET_FRAME': return { type: event.type, direction: event.direction, frameTypes: leafTypes(valueShape(event.payload)) };
      default: return { type: event.type };
    }
  }) };
}

function leafTypes(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leafTypes).sort();
  return [];
}
