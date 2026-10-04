import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type * as ts from 'typescript';
import { PRIVATE_STATE_FRAGMENT } from '../platform-paths.js';

/**
 * `typescript` is only needed to decode string literals inside `screenPatchContent`. It is loaded
 * lazily (never at module evaluation) so importing `@migration-harness/core` for `fileHash` — or any
 * other consumer that never calls the screen — does not pay for the compiler. Behavior is unchanged:
 * the same compiler APIs run on first use.
 */
const requireModule = createRequire(import.meta.url);
let compiler: typeof ts | undefined;
const typescript = (): typeof ts => (compiler ??= requireModule('typescript') as typeof ts);

/**
 * Lightweight content screens for generated patches (baseline hash + pseudonym/raw-domain screens).
 *
 * These live in their own leaf module so the core entry point can expose `fileHash` and
 * `screenPatchContent` without statically loading `typescript` (which is only needed by the AST
 * validators in `bounded-worker.ts`). `bounded-worker.ts` re-exports everything here, so the worker
 * module stays complete for its direct consumers.
 */
export interface CandidatePatch { path: string; beforeHash: string; content: string; }

export const fileHash = (content: string): string => createHash('sha256').update(content).digest('hex');

export interface PatchScreenRefusal { code: 'PSEUDONYM_IN_PATCH' | 'RAW_PATH_REFERENCE' | 'SCHEMA_INVALID'; path: string; message: string; }
/** Result of a bounded trace-value walk: `overflow` means the walk was truncated, so the screen must fail closed. */
export interface TraceScreen { values: string[]; overflow: boolean; }
export interface PatchScreenOptions {
  /** Extra raw-domain fragments observed for this brief's private artifacts. */
  privatePathFragments?: readonly string[];
  /** Sanitized trace-derived values that must never enter generated code, with their collection completeness. */
  trace?: TraceScreen | undefined;
  /** Authorized pre-existing implementation/context content: values already present there are legitimate to reuse. */
  baselineTexts?: readonly string[];
}
const PSEUDONYM_TOKEN = /p_[0-9a-f]{24}/;
// Content screens are bounded like the worker budgets: hitting any cap marks the screen incomplete and refuses.
const MAX_SCREEN_LITERALS = 250_000;
const MAX_SCREEN_TEXT_BYTES = 8_000_000;
const MAX_SCREEN_MATCH_BYTES = 512_000_000;
const MAX_TRACE_VALUES = 10_000;
const MAX_TRACE_CANDIDATES = 40_000;
const MAX_TRACE_DEPTH = 32;
const MAX_TRACE_NODES = 1_000_000;
// Heuristic coverage floor, not a completeness claim: only trace strings at least this long are screened.
// Shorter runtime values (HTTP verbs, short ids) are deliberately out of scope so ordinary code stays compilable.
const MIN_TRACE_VALUE_LENGTH = 8;

/**
 * Sanitized trace-derived literal values. The walk is bounded by depth, node, distinct-value and final-value caps;
 * hitting any cap returns `overflow: true` so callers refuse instead of silently accepting the dropped values.
 */
export function collectTraceValues(trace: unknown): TraceScreen {
  const candidates = new Set<string>();
  let visited = 0, overflow = false;
  const walk = (value: unknown, depth: number): void => {
    if (overflow) return;
    if (typeof value === 'string') {
      if (value.length < MIN_TRACE_VALUE_LENGTH || candidates.has(value)) return;
      if (candidates.size >= MAX_TRACE_CANDIDATES) { overflow = true; return; }
      candidates.add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (depth > MAX_TRACE_DEPTH || visited >= MAX_TRACE_NODES) { overflow = true; return; }
    visited++;
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, depth + 1);
  };
  walk(trace, 0);
  const values = [...candidates].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (values.length > MAX_TRACE_VALUES) { overflow = true; return { values: values.slice(0, MAX_TRACE_VALUES), overflow }; }
  return { values, overflow };
}

interface DecodedText { text: string; overflow: boolean; }
/**
 * Decode string/template literals and simple constant concatenations without evaluating anything, so escape
 * tricks like `'\u0070_...'` are screened by their runtime value. Values are newline-joined: one literal's
 * text can never bleed into the next, so no screen matches across a boundary that is not a real token.
 */
function decodeLiterals(content: string, path: string): DecodedText {
  const t = typescript();
  const source = t.createSourceFile(path, content, t.ScriptTarget.Latest, true, path.endsWith('x') ? t.ScriptKind.TSX : t.ScriptKind.TS);
  let text = '', literals = 0, overflow = false;
  const collect = (value: string): void => {
    if (overflow) return;
    literals++; text += `${value}\n`;
    if (literals > MAX_SCREEN_LITERALS || text.length > MAX_SCREEN_TEXT_BYTES) overflow = true;
  };
  const constant = (node: ts.Expression): string | undefined => {
    if (t.isStringLiteral(node) || t.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (t.isParenthesizedExpression(node)) return constant(node.expression);
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.PlusToken) {
      const left = constant(node.left), right = constant(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (t.isTemplateExpression(node)) {
      let folded = node.head.text;
      for (const span of node.templateSpans) { const value = constant(span.expression); if (value === undefined) return undefined; folded += value + span.literal.text; }
      return folded;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (overflow) return;
    if (t.isStringLiteralLike(node)) { collect(node.text); return; }
    if (t.isTemplateExpression(node)) {
      const folded = constant(node);
      if (folded !== undefined) { collect(folded); return; }
      collect(node.head.text);
      for (const span of node.templateSpans) { collect(span.literal.text); visit(span.expression); }
      return;
    }
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.PlusToken) {
      const folded = constant(node);
      if (folded !== undefined) { collect(folded); return; }
    }
    t.forEachChild(node, visit);
  };
  visit(source);
  return { text, overflow };
}

/**
 * Per-value substring matching: every value is checked with String.includes, so overlapping forbidden values
 * are never skipped the way a non-overlapping regex iteration would. Bounded by a byte budget that fails closed.
 */
function matchingValues(values: readonly string[], texts: readonly string[]): { found: Set<string>; overflow: boolean } {
  const found = new Set<string>();
  let work = 0;
  for (const value of values) {
    for (const text of texts) {
      work += text.length;
      if (work > MAX_SCREEN_MATCH_BYTES) return { found, overflow: true };
      if (text.includes(value)) { found.add(value); break; }
    }
  }
  return { found, overflow: false };
}

/** Cheap, high-signal content screens for the apply path: trace-derived pseudonyms and raw-domain path references must never enter generated code. */
export function screenPatchContent(patches: CandidatePatch[], options: PatchScreenOptions = {}): PatchScreenRefusal[] {
  const refusals: PatchScreenRefusal[] = [];
  const fragments = ['.migration-private', PRIVATE_STATE_FRAGMENT, ...(options.privatePathFragments ?? [])];
  const trace = options.trace;
  const values = (trace?.values ?? []).filter(value => value.length >= MIN_TRACE_VALUE_LENGTH);
  let decodedBaseline: string[] | undefined;
  // Baseline literals go through the same decoder as candidate literals, so an escaped spelling still exempts.
  const baseline = (): string[] => (decodedBaseline ??= (options.baselineTexts ?? []).flatMap(text => [text, decodeLiterals(text, '<baseline>').text]));
  for (const patch of patches) {
    const decoded = decodeLiterals(patch.content, patch.path);
    if (decoded.overflow) { refusals.push({ code: 'SCHEMA_INVALID', path: patch.path, message: 'Patch content exceeds the screening budget.' }); continue; }
    const texts = [patch.content, decoded.text];
    const pseudonym = texts.some(text => PSEUDONYM_TOKEN.test(text));
    if (pseudonym) refusals.push({ code: 'PSEUDONYM_IN_PATCH', path: patch.path, message: 'Patch content embeds a pseudonymized trace token.' });
    if (trace?.overflow) refusals.push({ code: 'SCHEMA_INVALID', path: patch.path, message: 'Trace value screening budget exceeded; screening is incomplete.' });
    else if (trace && !pseudonym && values.length) {
      const suspects = matchingValues(values, texts);
      if (suspects.overflow) refusals.push({ code: 'SCHEMA_INVALID', path: patch.path, message: 'Trace value matching exceeds the screening budget.' });
      else if (suspects.found.size) {
        const allowed = matchingValues([...suspects.found], baseline());
        if (allowed.overflow) refusals.push({ code: 'SCHEMA_INVALID', path: patch.path, message: 'Trace value matching exceeds the screening budget.' });
        else if ([...suspects.found].some(value => !allowed.found.has(value))) refusals.push({ code: 'PSEUDONYM_IN_PATCH', path: patch.path, message: 'Patch content embeds a trace-derived value.' });
      }
    }
    for (const fragment of fragments) {
      if (fragment && (patch.content.replace(/\\+/g, '/').includes(fragment.replace(/\\+/g, '/')) || decoded.text.replace(/\\+/g, '/').includes(fragment.replace(/\\+/g, '/')))) { refusals.push({ code: 'RAW_PATH_REFERENCE', path: patch.path, message: 'Patch content references the raw artifact domain.' }); break; }
    }
  }
  return refusals;
}

export function changedBytes(before: string, after: string): number {
  let start = 0, end = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (end < Math.min(before.length, after.length) - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return Buffer.byteLength(before.slice(start, before.length - end)) + Buffer.byteLength(after.slice(start, after.length - end));
}
