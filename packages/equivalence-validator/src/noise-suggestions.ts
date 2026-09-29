import {
  SuggestionReportSchema, type EquivalenceDivergence, type PolicySnippet, type Suggestion,
  type SuggestionReport,
} from '@migration-harness/core';

/**
 * Diffy-style noise ranking over repeated source executions. Output-only: the
 * harness never applies these proposals. The owner declares volatility (or
 * acceptedDifferences) and versions the policy; see stability.ts and RFC §7.
 */

export interface NoiseProposal {
  fieldPath: string;
  observedFrequency: number;
  runCount: number;
  codes: string[];
  policySnippet: PolicySnippet;
  rank: number;
  dimension: string;
}

export interface NoiseSuggestionInput {
  scenarioId: string;
  /** Number of source executions compared (limits.sourceRuns). */
  runCount: number;
  /** Divergences from source/source comparison (verifySourceStability / compareRuns). */
  divergences: readonly EquivalenceDivergence[];
  generatedAt?: string;
}

/** Structural field path from a divergence detail, if present. */
function fieldPathOf(item: EquivalenceDivergence): string | undefined {
  const detail = (item.source ?? item.target) as { path?: unknown } | undefined;
  if (detail && typeof detail === 'object' && typeof detail.path === 'string' && detail.path) return detail.path;
  // Value-difference messages carry `... at <requestPath> <fieldPath>`; prefer explicit detail above.
  const match = item.message.match(/ at \S+ (\S+)$/);
  return match?.[1];
}

/** Map a divergence code + field path to an existing policy snippet shape. */
function snippetFor(item: EquivalenceDivergence, fieldPath: string): PolicySnippet | undefined {
  const code = item.code;
  const leaf = (root: string): string => fieldPath.replace(new RegExp(`^${root}\\.?`), '').replace(/\[\d+\]/g, '') || fieldPath;
  if (code.startsWith('NETWORK_PAYLOAD_')) {
    return { kind: 'volatilePayloadFields', names: [leaf('payload')] };
  }
  if (code.startsWith('NETWORK_RESPONSE_')) {
    return { kind: 'volatileResponseFields', names: [leaf('response')] };
  }
  if (item.dimension === 'STATE' || code.includes('STORAGE')) {
    return { kind: 'volatileStorageValues', storageType: 'localStorage', key: fieldPath.split('.').at(-1) ?? fieldPath };
  }
  if (item.dimension === 'NETWORK' && code.includes('QUERY')) {
    return { kind: 'volatileQueryParams', names: [fieldPath.split(/[?.]/).at(-1) ?? fieldPath] };
  }
  if (code === 'NETWORK_MISSING_REQUEST' || code === 'NETWORK_PAYLOAD_VALUE_MISMATCH') {
    const requestPath = item.message.match(/ at (\S+)/)?.[1] ?? '/';
    return {
      kind: 'acceptedDifference',
      requestPath,
      method: typeof item.source === 'string' ? item.source : undefined,
      matchCode: code === 'NETWORK_MISSING_REQUEST' ? 'NETWORK_MISSING_REQUEST' : 'NETWORK_PAYLOAD_VALUE_MISMATCH',
    };
  }
  return undefined;
}

function rankFrequency(observed: number, runCount: number): number {
  if (runCount <= 1) return 0;
  return Math.min(1, Math.max(0, observed / Math.max(1, runCount - 1)));
}

/**
 * Rank fields that diverge across source runs. Frequency is pairwise (run0 vs each
 * other run), matching verifySourceStability's comparison style. Never writes policy.
 */
export function proposeNoiseSuggestions(input: NoiseSuggestionInput): SuggestionReport {
  const runCount = Math.max(2, input.runCount);
  const byField = new Map<string, { codes: Set<string>; dimension: string; count: number; snippet: PolicySnippet | null }>();
  // Pairwise comparisons with run 0 produce at most runCount-1 observations per field.
  for (const divergence of input.divergences) {
    const path = fieldPathOf(divergence);
    if (!path) continue;
    const key = `${divergence.dimension}:${path}`;
    const entry = byField.get(key) ?? { codes: new Set<string>(), dimension: divergence.dimension, count: 0, snippet: null };
    entry.codes.add(divergence.code);
    entry.count += 1;
    if (!entry.snippet) entry.snippet = snippetFor(divergence, path) ?? null;
    byField.set(key, entry);
  }
  const proposals: NoiseProposal[] = [...byField.entries()].map(([key, entry]) => {
    const fieldPath = key.slice(key.indexOf(':') + 1);
    const observedFrequency = rankFrequency(entry.count, runCount);
    const snippet: PolicySnippet = entry.snippet
      ?? { kind: 'volatilePayloadFields', names: [fieldPath.replace(/^(payload|response)\./, '')] };
    return {
      fieldPath,
      observedFrequency,
      runCount,
      codes: [...entry.codes].sort(),
      policySnippet: snippet,
      rank: observedFrequency,
      dimension: entry.dimension,
    };
  }).sort((a, b) => b.rank - a.rank || a.fieldPath.localeCompare(b.fieldPath));

  const suggestions: Suggestion[] = proposals.map((proposal, index) => ({
    suggestionId: `noise-${String(index + 1).padStart(4, '0')}`,
    kind: 'NOISE_PROPOSAL',
    status: 'PROPOSED',
    rank: Number(proposal.rank.toFixed(4)),
    observedFrequency: Number(proposal.observedFrequency.toFixed(4)),
    runCount: proposal.runCount,
    codes: proposal.codes,
    target: { scenarioId: input.scenarioId, fieldPath: proposal.fieldPath },
    policySnippet: proposal.policySnippet,
    description: `Field '${proposal.fieldPath}' diverged across source runs (${proposal.dimension}); owner may declare volatility or an accepted difference. Not auto-applied.`,
  }));

  return SuggestionReportSchema.parse({
    kind: 'SUGGESTION_REPORT',
    version: '1',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scenarioId: input.scenarioId,
    suggestions,
    authority: 'HINT_ONLY',
  });
}
