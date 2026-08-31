import type { HttpEndpointInvariant, Invariant } from '@migration-harness/core';

/**
 * Week 2 extension point. Runtime observations are deliberately not promoted to
 * BLOCKING required fields without corroborating evidence.
 */
export interface EvidenceFusionEngine {
  fuseHttpEvidence(
    runtimeCandidates: Invariant<HttpEndpointInvariant>[],
    additionalEvidence: Invariant<HttpEndpointInvariant>[],
  ): Invariant<HttpEndpointInvariant>[];
}
