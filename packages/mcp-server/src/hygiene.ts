/**
 * Data-hygiene for the agent-facing MCP transport. Tool arguments, results and error
 * payloads must never carry raw-trace tokens or private artifact roots (AGENTS.md §4/§7).
 * Error branches respond with the stable refusal vocabulary only: raw exception text can
 * echo path content, file data or caller input.
 */
import { PRIVATE_STATE_FRAGMENT } from '@migration-harness/core';

const PSEUDONYM = /p_[0-9a-f]{24}/;
const PRIVATE_MARKERS = ['.migration-private', 'migration-harness-private', PRIVATE_STATE_FRAGMENT];

/** Uppercase code with an optional kebab-case label — never a path, errno or file excerpt. */
const STABLE_CODE = /^[A-Z][A-Z0-9_]*(?::[a-z0-9-]+)?$/;

export function assertAgentSafe(value: unknown, label = 'payload'): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (PSEUDONYM.test(text)) throw new Error(`ASSISTANT_CHANNEL_PSEUDONYM:${label}`);
  for (const marker of PRIVATE_MARKERS) {
    if (text.includes(marker)) throw new Error(`ASSISTANT_CHANNEL_PRIVATE_PATH:${label}`);
  }
}

export function screenResult(value: unknown): unknown {
  assertAgentSafe(value, 'tool-result');
  return value;
}

/**
 * Map any thrown value onto the refusal vocabulary. Stable hygiene/refusal codes pass
 * through untouched; a missing file keeps the `INPUT_FILE_MISSING` diagnosis without its
 * path; everything else becomes TOOL_FAILED instead of echoing raw exception text.
 */
export function stableErrorMessage(error: unknown): string {
  const message = error instanceof Error && typeof error.message === 'string' ? error.message : '';
  if (STABLE_CODE.test(message) && !PSEUDONYM.test(message) && !PRIVATE_MARKERS.some(marker => message.includes(marker))) return message;
  const code = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' ? 'INPUT_FILE_MISSING' : 'TOOL_FAILED';
}
