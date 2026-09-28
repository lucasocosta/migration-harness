/**
 * Data-hygiene for the agent-facing MCP transport. Tool arguments and results must
 * never carry raw-trace tokens or private artifact roots (AGENTS.md §4/§7).
 */
import { PRIVATE_STATE_FRAGMENT } from '@migration-harness/core';

const PSEUDONYM = /p_[0-9a-f]{24}/;
const PRIVATE_MARKERS = ['.migration-private', 'migration-harness-private', PRIVATE_STATE_FRAGMENT];

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
