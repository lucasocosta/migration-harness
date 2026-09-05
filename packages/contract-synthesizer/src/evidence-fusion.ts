import type { HttpEndpointInvariant, Invariant } from '@migration-harness/core';
import { canonical, matchPath } from '@migration-harness/core';

/**
 * Runtime observations are deliberately not promoted to
 * BLOCKING required fields without corroborating evidence.
 */
export interface EvidenceFusionPort {
  fuseHttpEvidence(
    runtimeCandidates: Invariant<HttpEndpointInvariant>[],
    additionalEvidence: Invariant<HttpEndpointInvariant>[],
  ): Invariant<HttpEndpointInvariant>[];
}

export class EvidenceFusionEngine implements EvidenceFusionPort {
  fuseHttpEvidence(runtimeCandidates: Invariant<HttpEndpointInvariant>[], additionalEvidence: Invariant<HttpEndpointInvariant>[]): Invariant<HttpEndpointInvariant>[] {
    const result = structuredClone(runtimeCandidates).map(candidate => ({ ...candidate, enforcement: 'WARNING' as const,
      value: { ...candidate.value, payloadRequirements: { ...candidate.value.payloadRequirements, requiredFields: [] } } } as Invariant<HttpEndpointInvariant>));
    for (const evidence of additionalEvidence) {
      if (!evidence.evidenceTrail.some(item => item.source !== 'RUNTIME_OBSERVATION')) throw new Error('Additional evidence requires a non-runtime source.');
      const candidate = result.find(item => item.value.method === evidence.value.method && (item.value.pathTemplate === evidence.value.pathTemplate || matchPath(evidence.value.pathTemplate, item.value.pathTemplate) !== undefined));
      if (!candidate) { result.push(structuredClone(evidence)); continue; }
      const normative = (value: HttpEndpointInvariant) => ({ ...value, payloadRequirements: { ...value.payloadRequirements, observedAlwaysFields: [], observedSometimesFields: [] } });
      if (candidate.evidenceTrail.some(item => item.source !== 'RUNTIME_OBSERVATION') && canonical(normative(candidate.value)) !== canonical(normative(evidence.value))) throw new Error('Conflicting normative evidence requires human review.');
      // Normative sources supply requirements. Observed sets remain observational.
      candidate.value = { ...structuredClone(evidence.value), payloadRequirements: {
        ...structuredClone(evidence.value.payloadRequirements), observedAlwaysFields: candidate.value.payloadRequirements.observedAlwaysFields,
        observedSometimesFields: candidate.value.payloadRequirements.observedSometimesFields,
      } };
      candidate.evidenceTrail.push(...structuredClone(evidence.evidenceTrail));
      candidate.enforcement = evidence.enforcement;
    }
    return result;
  }
}
