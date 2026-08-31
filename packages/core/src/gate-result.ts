export type ReleaseEligibility = 'ELIGIBLE' | 'ELIGIBLE_WITH_REVIEW' | 'NOT_ELIGIBLE';

export type FailureDisposition =
  | 'AUTO_REPAIRABLE'
  | 'REQUIRES_CONTRACT_REVIEW'
  | 'REQUIRES_SECURITY_REVIEW'
  | 'REQUIRES_ARCHITECTURAL_REVIEW'
  | 'NON_DETERMINISTIC'
  | 'UNKNOWN';

export interface MinimumCoveragePolicy {
  unitRoutesPercent: number;
  networkMutationsPercent: number;
  primaryScenariosPercent: number;
  knownErrorStatesCount: number;
  scenarioControlsPercent: number;
  conditionalBranchesPercent?: number;
}

export interface GateResult {
  unitId: string;
  timestamp: string;
  contractIntegrityVerified: boolean;
  eligibility: ReleaseEligibility;
  disposition: FailureDisposition;
  experimentalConfidenceScore: number;
  contractCoverageMetrics: {
    routesCovered: number;
    mutationsCovered: number;
    controlsCovered: number;
    isPolicySatisfied: boolean;
  };
  blockingGates: Array<{ name: string; passed: boolean; errors: string[] }>;
  advisoryGates: Array<{ name: string; passed: boolean; warnings: string[] }>;
  diagnostics: {
    repairIteration: number;
    failingSymbols: string[];
    escalationReason?: string;
  };
}
