export function canonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function valueShape(value: unknown): unknown {
  if (Array.isArray(value)) return [...new Set(value.map(item => canonical(valueShape(item))))].sort().map(item => JSON.parse(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, valueShape(child)]));
  }
  return value === null ? 'null' : typeof value;
}

export function normalizeUrl(value: string, volatile: readonly string[] = []): string {
  const url = new URL(value, 'http://harness.invalid');
  for (const key of volatile) url.searchParams.delete(key);
  url.searchParams.sort();
  return `${url.pathname}${url.search}${url.hash}`;
}

export function matchPath(template: string, pathname: string): Record<string, string> | undefined {
  const expected = template.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const part = expected[i]!;
    if (part.startsWith(':') && actual[i]) params[part.slice(1)] = decodeURIComponent(actual[i]!);
    else if (part !== actual[i]) return undefined;
  }
  return params;
}
