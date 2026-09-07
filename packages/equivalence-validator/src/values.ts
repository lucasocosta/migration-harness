/**
 * Value comparison for selected evaluation data.
 *
 * Shape equality cannot establish that the destination submitted or displayed the same data, so this
 * module compares the values themselves. Comparison happens in process against sanitized traces, where
 * PII is already replaced by deterministic pseudonyms derived from the shared key: equal source and
 * target data therefore stay equal. Nothing observed leaves here — a difference reports the structural
 * location and the kinds involved, never the values.
 */

export type ValueKind = 'absent' | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
export type ValueDifferenceCode = 'VALUE_MISMATCH' | 'VALUE_TYPE_MISMATCH' | 'FIELD_MISSING'
  | 'FIELD_UNEXPECTED' | 'NULL_MISMATCH' | 'ARRAY_LENGTH_MISMATCH' | 'COMPARISON_TRUNCATED';
export interface ValueDifference {
  code: ValueDifferenceCode;
  /** Structural location such as `payload.customer.email` or `response.items[0].id`. */
  path: string;
  sourceKind: ValueKind;
  targetKind: ValueKind;
}
export interface ValueDiffOptions {
  /** Field names excluded at any depth, mirroring the declared volatile fields of the policy. */
  volatileFields?: readonly string[];
  maxDifferences?: number;
  maxDepth?: number;
}

const PSEUDONYM = /^p_[0-9a-f]{24}$/;
/** Keys reach diagnostics, so anything that is not a plain identifier is reduced to a placeholder. */
export function safeSegment(key: string): string {
  if (PSEUDONYM.test(key)) return '<pseudonym>';
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(key) ? key : '<key>';
}
export function valueKind(value: unknown): ValueKind {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'boolean' || type === 'number' || type === 'string' ? type : 'object';
}

/**
 * Compare two observed values position by position. Arrays are an ordered sequence here: element order
 * is part of the observed behavior, unlike the set-of-shapes projection used for structural comparison.
 */
export function diffValues(source: unknown, target: unknown, rootPath: string, options: ValueDiffOptions = {}): ValueDifference[] {
  const maxDifferences = options.maxDifferences ?? 50, maxDepth = options.maxDepth ?? 20;
  const volatile = new Set(options.volatileFields ?? []);
  const differences: ValueDifference[] = [];
  const push = (code: ValueDifferenceCode, path: string, sourceKind: ValueKind, targetKind: ValueKind): void => {
    if (differences.length < maxDifferences) differences.push({ code, path, sourceKind, targetKind });
  };
  const walk = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (differences.length >= maxDifferences) return;
    const left = valueKind(a), right = valueKind(b);
    if (left === 'absent' && right === 'absent') return;
    if (left === 'absent' || right === 'absent') return push(left === 'absent' ? 'FIELD_UNEXPECTED' : 'FIELD_MISSING', path, left, right);
    // Absence and an explicit null are different observations and stay distinguishable.
    if ((left === 'null') !== (right === 'null')) return push('NULL_MISMATCH', path, left, right);
    if (left === 'null') return;
    if (left !== right) return push('VALUE_TYPE_MISMATCH', path, left, right);
    if (depth >= maxDepth) return push('COMPARISON_TRUNCATED', path, left, right);
    if (left === 'array') {
      const first = a as unknown[], second = b as unknown[];
      if (first.length !== second.length) push('ARRAY_LENGTH_MISMATCH', path, left, right);
      for (let index = 0; index < Math.min(first.length, second.length); index++) walk(first[index], second[index], `${path}[${index}]`, depth + 1);
      return;
    }
    if (left === 'object') {
      const first = a as Record<string, unknown>, second = b as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(first), ...Object.keys(second)])].sort()) {
        if (volatile.has(key)) continue;
        walk(Object.hasOwn(first, key) ? first[key] : undefined, Object.hasOwn(second, key) ? second[key] : undefined, `${path}.${safeSegment(key)}`, depth + 1);
      }
      return;
    }
    if (a !== b) push('VALUE_MISMATCH', path, left, right);
  };
  walk(source, target, rootPath, 0);
  return differences;
}

/** Resolve a value path relative to a root (`items[0].id`), reporting presence without revealing the value. */
export function resolveValuePath(root: unknown, path: string): { present: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of path ? path.split('.') : []) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return { present: false, value: undefined };
    const [, key, indexes] = match as unknown as [string, string, string];
    if (key) {
      if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return { present: false, value: undefined };
      current = (current as Record<string, unknown>)[key];
    }
    for (const position of indexes.match(/\d+/g) ?? []) {
      if (!Array.isArray(current) || current.length <= Number(position)) return { present: false, value: undefined };
      current = current[Number(position)];
    }
  }
  return { present: current !== undefined, value: current };
}
export const valuePathPresent = (root: unknown, path: string): boolean => resolveValuePath(root, path).present;
