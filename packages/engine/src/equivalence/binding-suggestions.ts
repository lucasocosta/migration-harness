import {
  SuggestionReportSchema, type Suggestion, type SuggestionReport,
  type UnitAssertionOutcome,
} from '@migration-harness/core';

/**
 * Binding adaptation and scenario-inventory proposals. Output-only: only the
 * binding projection (entryUrl, locators, unitScope) is ever targeted. Semantic
 * steps/actions/values cannot be proposed or rewritten (RFC §7, resolveScenarioForSide).
 */

const BINDING_ANCHOR_CODES = new Set([
  'STEP_FAILED', 'NODE_MISSING', 'SCOPE_NOT_FOUND', 'COMPLETION_FAILED',
  'BOOT_FAILED', 'NODE_TEXT_DIFFERS', 'NODE_STATE_DIFFERS', 'NODE_PRESENT_UNEXPECTED',
]);

export interface BindingSuggestionInput {
  scenarioId: string;
  side?: 'source' | 'target';
  stepId?: string;
  anchors: readonly string[];
  /** Nearby accessible controls as structural locator candidates — names/roles only. */
  observedCandidates?: ReadonlyArray<{ targetRole?: string; targetName?: string; targetLabel?: string }>;
  generatedAt?: string;
}

export function proposeBindingAdaptations(input: BindingSuggestionInput): SuggestionReport {
  const relevant = input.anchors.filter(code => BINDING_ANCHOR_CODES.has(code));
  const suggestions: Suggestion[] = [];
  if (relevant.length && input.stepId) {
    const codes = [...new Set(relevant)].sort();
    const candidate = input.observedCandidates?.[0];
    suggestions.push({
      suggestionId: 'binding-0001',
      kind: 'BINDING_ADAPTATION_PROPOSAL',
      status: 'PROPOSED',
      rank: 0.5,
      codes,
      target: { scenarioId: input.scenarioId, stepId: input.stepId },
      description: candidate
        ? `Step '${input.stepId}' failed with ${codes.join(', ')}. Suggested binding target: role=${candidate.targetRole ?? '?'} name=${candidate.targetName ?? '?'} label=${candidate.targetLabel ?? '?'}. Binding projection only; semantic actions must not change. Owner must approve and re-run both sides.`
        : `Step '${input.stepId}' failed with ${codes.join(', ')}. Review locator or entryUrl in the binding projection. Semantic actions must not change. Owner must approve and re-run both sides.`,
    });
  }
  return SuggestionReportSchema.parse({
    kind: 'SUGGESTION_REPORT',
    version: '1',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scenarioId: input.scenarioId,
    suggestions,
    authority: 'HINT_ONLY',
  });
}

export interface ScenarioInventoryInput {
  unitId: string;
  routes: ReadonlyArray<{ path: string; componentId?: string; dynamic: boolean }>;
  endpoints: ReadonlyArray<{ method: string; path: string; dynamic: boolean }>;
  runtimeRoutes?: readonly string[];
  generatedAt?: string;
}

/**
 * Propose a non-authoritative scenario inventory from discovery. Never writes
 * MigrationConfig.scenarios; coverage gaps stay visible until the owner declares them.
 */
export function proposeScenarioInventory(input: ScenarioInventoryInput): SuggestionReport {
  const suggestions: Suggestion[] = [];
  const routes = [...input.routes.map(item => item.path), ...(input.runtimeRoutes ?? [])];
  for (const path of [...new Set(routes)].sort()) {
    if (path.includes(':') || path.includes('*')) continue;
    const slug = path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'root';
    suggestions.push({
      suggestionId: `inv-route-${slug}`,
      kind: 'SCENARIO_INVENTORY_PROPOSAL',
      status: 'PROPOSED',
      rank: 0.3,
      target: {},
      description: `Route '${path}' may need a declared scenario. Inventory remains explicit (required coverage in reports).`,
    });
  }
  for (const endpoint of input.endpoints.filter(item => !item.dynamic).slice(0, 50)) {
    suggestions.push({
      suggestionId: `inv-endpoint-${endpoint.method.toLowerCase()}-${endpoint.path.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}`,
      kind: 'SCENARIO_INVENTORY_PROPOSAL',
      status: 'PROPOSED',
      rank: 0.2,
      target: { requestPath: endpoint.path },
      description: `Endpoint ${endpoint.method} ${endpoint.path} may need a scenario requirement (unit '${input.unitId}').`,
    });
  }
  return SuggestionReportSchema.parse({
    kind: 'SUGGESTION_REPORT',
    version: '1',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    suggestions,
    authority: 'HINT_ONLY',
  });
}

/** Map assertion outcomes / runner anchors into binding proposals for one scenario. */
export function proposeFromOutcomes(input: {
  scenarioId: string;
  side?: 'source' | 'target';
  outcomes: readonly Pick<UnitAssertionOutcome, 'status' | 'reason' | 'assertionId'>[];
  stepId?: string;
  generatedAt?: string;
}): SuggestionReport {
  const anchors = input.outcomes
    .filter(item => item.status !== 'SATISFIED' && item.reason && BINDING_ANCHOR_CODES.has(item.reason))
    .map(item => item.reason!);
  return proposeBindingAdaptations({
    scenarioId: input.scenarioId,
    ...(input.side ? { side: input.side } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    anchors,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
}

export function isBindingAnchor(code: string): boolean {
  return BINDING_ANCHOR_CODES.has(code);
}
