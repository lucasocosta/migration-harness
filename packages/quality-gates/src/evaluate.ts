import type { EquivalenceResult, FailureDisposition, GateResult, ReleaseEligibility } from '@migration-harness/core';
import type { CoverageReport } from './coverage/index.js';

export function classifyFailure(result: EquivalenceResult): FailureDisposition {
  const blocking = result.divergences.filter(d => d.severity === 'BLOCKING');
  if (!blocking.length) return 'UNKNOWN';
  if (blocking.some(d => d.dimension === 'SECURITY' || d.code === 'CONTRACT_INTEGRITY_FAILURE')) return 'REQUIRES_SECURITY_REVIEW';
  if (blocking.some(d => d.code === 'SCENARIO_FAILED')) return 'UNKNOWN';
  if (blocking.some(d => d.code === 'NON_DETERMINISTIC_EXECUTION')) return 'NON_DETERMINISTIC';
  if (blocking.some(d => d.dimension === 'CONTRACT' && d.code !== 'CONTRACT_NETWORK_METHOD')) return 'REQUIRES_CONTRACT_REVIEW';
  if (blocking.every(d => ['NETWORK_METHOD_MISMATCH', 'CONTRACT_NETWORK_METHOD'].includes(d.code))) return 'AUTO_REPAIRABLE';
  if (blocking.some(d => d.code === 'CAUSAL_ORDER_MISMATCH')) return 'REQUIRES_ARCHITECTURAL_REVIEW';
  return 'UNKNOWN';
}

export interface GateInput {
  unitId: string;
  results: EquivalenceResult[];
  requiredScenarioIds: string[];
  contractIntegrityVerified: boolean;
  securityBoundaryVerified: boolean;
  staticChecksPassed?: boolean;
  repairIteration?: number;
  experimentalConfidenceScore?: number;
  coverage?: CoverageReport;
}
export function evaluateGates(input: GateInput): GateResult {
  const divergences = input.results.flatMap(result => result.divergences);
  const required = [...new Set(input.requiredScenarioIds)];
  const covered = required.filter(id => input.results.some(result => result.scenarioId === id));
  const blockingGates = [
    { name: 'contract-integrity', passed: input.contractIntegrityVerified, errors: input.contractIntegrityVerified ? [] : ['Contract integrity is not verified.'] },
    { name: 'security-boundary', passed: input.securityBoundaryVerified, errors: input.securityBoundaryVerified ? [] : ['Security boundary is not verified.'] },
    { name: 'required-scenarios', passed: required.length > 0 && covered.length === required.length, errors: required.filter(id => !covered.includes(id)) },
    { name: 'equivalence', passed: input.results.length > 0 && !divergences.some(d => d.severity === 'BLOCKING') && input.results.every(r => r.status === 'EQUIVALENT'), errors: divergences.filter(d => d.severity === 'BLOCKING').map(d => d.code) },
    { name: 'static-checks', passed: input.staticChecksPassed === true, errors: input.staticChecksPassed === true ? [] : ['Static checks have not passed.'] },
  ];
  const warnings = divergences.filter(d => d.severity === 'WARNING');
  if (input.coverage) blockingGates.push({ name: 'minimum-coverage', passed: input.coverage.isPolicySatisfied, errors: input.coverage.isPolicySatisfied ? [] : ['Required routes, mutations, controls or scenarios are not fully covered.'] });
  const coverageWarning = !input.coverage || !input.coverage.knownErrorScenarios;
  const eligibility: ReleaseEligibility = blockingGates.some(g => !g.passed) ? 'NOT_ELIGIBLE' : warnings.length || coverageWarning ? 'ELIGIBLE_WITH_REVIEW' : 'ELIGIBLE';
  const failed = input.results.find(r => r.status === 'NOT_EQUIVALENT');
  return { unitId: input.unitId, timestamp: new Date().toISOString(), contractIntegrityVerified: input.contractIntegrityVerified, eligibility,
    disposition: !input.contractIntegrityVerified || !input.securityBoundaryVerified ? 'REQUIRES_SECURITY_REVIEW' : failed ? classifyFailure(failed) : eligibility === 'NOT_ELIGIBLE' ? 'UNKNOWN' : null,
    experimentalConfidenceScore: input.experimentalConfidenceScore ?? 0,
    contractCoverageMetrics: { routesCovered: input.coverage?.routesCovered ?? 0, mutationsCovered: input.coverage?.mutationsCovered ?? 0, controlsCovered: input.coverage?.controlsCovered ?? 0, isPolicySatisfied: input.coverage?.isPolicySatisfied ?? false },
    blockingGates, advisoryGates: [{ name: 'advisory-equivalence', passed: !warnings.length, warnings: warnings.map(d => d.code) }, { name: 'scenario-coverage', passed: !coverageWarning, warnings: coverageWarning ? ['Coverage is unmeasured or a known error scenario is missing.'] : [] }], diagnostics: { repairIteration: input.repairIteration ?? 0, failingSymbols: [] },
  };
}
