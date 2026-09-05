import type {
  EquivalenceDimension,
  EquivalenceResult,
  SanitizedObservedTrace,
  TransformationManifest,
  BehaviorContract,
  MigrationUnit,
} from '@migration-harness/core';
import { parseSanitizedTrace, parseContract, parseManifest, parseEquivalenceResult, parseMigrationUnit, HarnessPolicySchema } from '@migration-harness/core';
import { compareNetworkBehavior, type NetworkComparisonPolicy } from './network/index.js';
import { compareObservables, compareCausality, type ObservablePolicy } from './dimensions.js';
import { verifyCriticalContract } from './contract.js';

export interface EquivalenceValidationPolicy {
  network?: NetworkComparisonPolicy;
  observables?: ObservablePolicy;
}

export interface EquivalenceValidationInput {
  source: SanitizedObservedTrace;
  target: SanitizedObservedTrace;
  transformationManifest?: TransformationManifest;
  policy?: EquivalenceValidationPolicy;
  contract?: BehaviorContract;
  unit?: MigrationUnit;
}

export class EquivalenceValidator {
  validate(input: EquivalenceValidationInput): EquivalenceResult {
    input = { ...input, source: parseSanitizedTrace(input.source), target: parseSanitizedTrace(input.target) };
    if (input.contract) input.contract = parseContract(input.contract);
    if (input.transformationManifest) input.transformationManifest = parseManifest(input.transformationManifest);
    if (input.unit) input.unit = parseMigrationUnit(input.unit);
    const unitIds = [input.unit?.id, input.contract?.unitId, input.transformationManifest?.unitId].filter(Boolean);
    if (new Set(unitIds).size > 1) throw new Error('Migration unit mismatch');
    if (input.source.scenarioId !== input.target.scenarioId) {
      throw new Error(`Scenario mismatch: source=${input.source.scenarioId}, target=${input.target.scenarioId}`);
    }

    const divergences = compareNetworkBehavior(input.source, input.target, input.policy?.network);
    if (!input.source.events.length || !input.target.events.length) divergences.push({ divergenceId: 'INSUFFICIENT_EVIDENCE', scenarioId: input.source.scenarioId, dimension: 'CONTRACT', code: 'INSUFFICIENT_EVIDENCE', severity: 'BLOCKING', message: 'An empty trace cannot establish behavioral equivalence.' });
    divergences.push(...compareObservables(input.source, input.target, input.policy?.observables));
    // Network differences already explain graph label changes.
    if (!divergences.some(d => d.dimension === 'NETWORK')) divergences.push(...compareCausality(input.source, input.target, input.policy?.network));
    const evaluatedDimensions: EquivalenceDimension[] = ['NETWORK', 'NAVIGATION', 'STATE', 'ARIA', 'CONTRACT'];
    if (input.contract) divergences.push(...verifyCriticalContract(input.contract, input.target));
    let manifestUsed = false;
    for (const divergence of divergences) {
      const claim = divergence.code === 'NETWORK_METHOD_MISMATCH' ? 'HTTP_METHOD' : divergence.dimension === 'NAVIGATION' ? 'NAVIGATION' : divergence.dimension === 'STATE' ? 'STORAGE' : divergence.dimension === 'ARIA' ? 'ARIA_SEMANTICS' : undefined;
      const hints = input.transformationManifest?.mappings.filter(mapping => claim && mapping.preserves.includes(claim)) ?? [];
      if (hints.length === 1) { divergence.relatedMappingId = hints[0]!.mappingId; manifestUsed = true; }
    }

    divergences.forEach((divergence, index) => { divergence.divergenceId = `${divergence.dimension}:${divergence.code}:${index}`; });
    return parseEquivalenceResult({
      scenarioId: input.source.scenarioId,
      status: divergences.some((item) => item.severity === 'BLOCKING') ? 'NOT_EQUIVALENT' : 'EQUIVALENT',
      evaluatedAt: new Date().toISOString(),
      divergences,
      evidence: {
        sourceEventCount: input.source.events.length,
        targetEventCount: input.target.events.length,
        evaluatedDimensions,
        transformationManifestUsedAsHint: manifestUsed,
      },
    });
  }
}

export * from './network/index.js';
export * from './dimensions.js';
export * from './contract.js';

export function parseValidationPolicy(value: unknown): EquivalenceValidationPolicy {
  const parsed = HarnessPolicySchema.parse(value);
  const { pathTemplates, ...network } = parsed.network ?? {};
  return {
    network: { ...network, pathTemplateRules: (pathTemplates ?? []).map(template => ({ template, pattern: new RegExp('^' + template.split('/').map(part => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$') })) },
    ...(parsed.observables ? { observables: parsed.observables } : {}),
  } as EquivalenceValidationPolicy;
}
