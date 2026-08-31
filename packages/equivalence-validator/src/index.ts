import type {
  EquivalenceDimension,
  EquivalenceResult,
  SanitizedObservedTrace,
  TransformationManifest,
} from '@migration-harness/core';
import { compareNetworkBehavior, type NetworkComparisonPolicy } from './network/index.js';

export interface EquivalenceValidationPolicy {
  network?: NetworkComparisonPolicy;
}

export interface EquivalenceValidationInput {
  source: SanitizedObservedTrace;
  target: SanitizedObservedTrace;
  transformationManifest?: TransformationManifest;
  policy?: EquivalenceValidationPolicy;
}

export class EquivalenceValidator {
  validate(input: EquivalenceValidationInput): EquivalenceResult {
    if (input.source.scenarioId !== input.target.scenarioId) {
      throw new Error(`Scenario mismatch: source=${input.source.scenarioId}, target=${input.target.scenarioId}`);
    }

    const divergences = compareNetworkBehavior(input.source, input.target, input.policy?.network);
    const evaluatedDimensions: EquivalenceDimension[] = ['NETWORK'];

    return {
      scenarioId: input.source.scenarioId,
      status: divergences.some((item) => item.severity === 'BLOCKING') ? 'NOT_EQUIVALENT' : 'EQUIVALENT',
      evaluatedAt: new Date().toISOString(),
      divergences,
      evidence: {
        sourceEventCount: input.source.events.length,
        targetEventCount: input.target.events.length,
        evaluatedDimensions,
        transformationManifestUsedAsHint: input.transformationManifest !== undefined,
      },
    };
  }
}

export * from './network/index.js';
