import { type MigrationConfig, type EquivalenceDivergence, type SanitizedObservedTrace, type UnitAssertionOutcome } from '@migration-harness/core';
import { evaluateUnitAssertions, type DeclaredMock } from './assertions.js';

/** Does not alter traces or legacy verdicts. Only exact declared NETWORK defects may be resolved. */
export function resolveExpectedDifferences(input: {
  differences: MigrationConfig['acceptedDifferences']; scenarioId: string;
  source: SanitizedObservedTrace; target: SanitizedObservedTrace;
  divergences: EquivalenceDivergence[]; targetOutcomes: UnitAssertionOutcome[]; mocks?: readonly DeclaredMock[];
}) {
  const accepted = new Set<string>();
  const evidence: Array<{ differenceId: string; status: 'APPLIED' | 'UNVERIFIED'; sourceOutcomes: UnitAssertionOutcome[]; divergenceIds: string[] }> = [];
  for (const difference of input.differences.filter(item => item.scenarioId === input.scenarioId && item.resolution)) {
    const resolution = difference.resolution!;
    const sourceOutcomes = evaluateUnitAssertions({ source: input.source, target: input.source,
      assertions: resolution.sourceAssertions.map((assertion, index) => ({ ...assertion, id: `source-${index}`, required: true })),
      ...(input.mocks ? { mocks: input.mocks } : {}),
    }).outcomes.filter(item => item.side === 'source');
    const guarded = sourceOutcomes.every(item => item.status === 'SATISFIED') && resolution.targetRequirementIds.every(id =>
      input.targetOutcomes.some(item => item.side === 'target' && item.assertionId === id && item.required && item.status === 'SATISFIED'));
    const selected = new Set<string>();
    const matched = resolution.matches.every(match => {
      const found = input.divergences.filter(item => item.dimension === 'NETWORK' && item.severity === 'BLOCKING' && item.code === match.code
        && !accepted.has(item.divergenceId) && !selected.has(item.divergenceId)
        && (match.code === 'NETWORK_MISSING_REQUEST'
          ? item.source === match.method && item.message === `${match.code} at ${match.requestPath}`
          : item.message === `${match.code} at ${match.requestPath} ${match.field}`
            && (item.source as { path?: string } | undefined)?.path === match.field
            && (item.target as { path?: string } | undefined)?.path === match.field));
      found.forEach(item => selected.add(item.divergenceId));
      return found.length === match.count;
    });
    const applied = guarded && matched;
    if (applied) selected.forEach(id => accepted.add(id));
    evidence.push({ differenceId: difference.id, status: applied ? 'APPLIED' : 'UNVERIFIED', sourceOutcomes,
      divergenceIds: applied ? [...selected] : [] });
  }
  return { acceptedDivergenceIds: [...accepted], evidence };
}
