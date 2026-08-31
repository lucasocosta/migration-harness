export type EquivalenceStatus = 'EQUIVALENT' | 'NOT_EQUIVALENT';

export type EquivalenceDimension =
  | 'NETWORK'
  | 'NAVIGATION'
  | 'STATE'
  | 'ARIA'
  | 'CONTRACT'
  | 'SECURITY';

export type DivergenceSeverity = 'BLOCKING' | 'WARNING' | 'INFORMATIONAL';

export interface EquivalenceDivergence {
  divergenceId: string;
  scenarioId: string;
  dimension: EquivalenceDimension;
  code: string;
  severity: DivergenceSeverity;
  message: string;
  source?: unknown;
  target?: unknown;
  relatedMappingId?: string;
}

export interface EquivalenceEvidenceSummary {
  sourceEventCount: number;
  targetEventCount: number;
  evaluatedDimensions: EquivalenceDimension[];
  transformationManifestUsedAsHint: boolean;
}

export interface EquivalenceResult {
  scenarioId: string;
  status: EquivalenceStatus;
  evaluatedAt: string;
  divergences: EquivalenceDivergence[];
  evidence: EquivalenceEvidenceSummary;
}
