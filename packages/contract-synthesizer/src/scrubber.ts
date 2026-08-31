import type { RawObservedTrace, SanitizedObservedTrace } from '@migration-harness/core';

const SENSITIVE_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie', 'token', 'access_token', 'refresh_token',
  'password', 'secret', 'apikey', 'api_key', 'credit_card', 'cardnumber', 'cvv',
]);

const PATTERNS: Array<[RegExp, string]> = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[REDACTED_DOCUMENT]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]'],
];

export interface SanitizationPolicy {
  allowedObjectKeys?: Set<string>;
  sensitiveKeys?: Set<string>;
}

export function sanitizeTrace(
  raw: RawObservedTrace,
  policy: SanitizationPolicy = {},
): SanitizedObservedTrace {
  let redactionsCount = 0;
  const sensitiveKeys = policy.sensitiveKeys ?? SENSITIVE_KEYS;

  const scrub = (value: unknown, key?: string): unknown => {
    if (key && sensitiveKeys.has(key.toLowerCase())) {
      redactionsCount += 1;
      return '[REDACTED_SECRET]';
    }
    if (typeof value === 'string') {
      let result = value;
      for (const [pattern, replacement] of PATTERNS) {
        const next = result.replace(pattern, replacement);
        if (next !== result) redactionsCount += 1;
        result = next;
      }
      return result;
    }
    if (Array.isArray(value)) return value.map((item) => scrub(item));
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        if (policy.allowedObjectKeys && !policy.allowedObjectKeys.has(childKey)) continue;
        output[childKey] = scrub(child, childKey);
      }
      return output;
    }
    return value;
  };

  const sanitized = scrub(raw) as RawObservedTrace;
  return {
    ...sanitized,
    sanitization: {
      version: '0.1.0',
      appliedAt: new Date().toISOString(),
      redactionsCount,
    },
  };
}
