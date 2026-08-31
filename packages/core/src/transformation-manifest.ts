export type PreservedBehaviorClaim =
  | 'HTTP_METHOD'
  | 'HTTP_PATH'
  | 'HTTP_PAYLOAD'
  | 'HTTP_STATUS'
  | 'VALIDATION'
  | 'SUCCESS_BEHAVIOR'
  | 'ERROR_BEHAVIOR'
  | 'NAVIGATION'
  | 'STORAGE'
  | 'ARIA_SEMANTICS';

export interface TransformationMapping {
  mappingId: string;
  source: string;
  target: string;
  preserves: PreservedBehaviorClaim[];
  rationale?: string;
}

export interface TransformationManifest {
  unitId: string;
  generatedAt: string;
  transformer: {
    kind: 'CODEMOD' | 'LLM' | 'HYBRID' | 'MANUAL';
    name: string;
    version?: string;
  };
  mappings: TransformationMapping[];
}
