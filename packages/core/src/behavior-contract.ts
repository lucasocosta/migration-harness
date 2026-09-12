export type EvidenceSource =
  | 'RUNTIME_OBSERVATION'
  | 'STATIC_ANALYSIS'
  | 'OPENAPI'
  | 'EXISTING_TESTS'
  | 'HUMAN_SPECIFICATION';

export interface ContractEvidence {
  source: EvidenceSource;
  evidenceConfidenceHeuristic: number;
  runsObservedCount?: number;
  totalRunsEvaluated?: number;
  sourceReference?: string;
}

export interface Invariant<T> {
  id: string;
  value: T;
  evidenceTrail: ContractEvidence[];
  enforcement: 'BLOCKING' | 'WARNING' | 'INFORMATIONAL';
}

export interface HttpEndpointInvariant {
  pathTemplate: string;
  pathParams: Record<string, { type: 'string' | 'number' | 'uuid'; pattern?: string }>;
  queryParams: {
    required: string[];
    optional: string[];
    ignored: string[];
  };
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payloadRequirements: {
    observedAlwaysFields: string[];
    observedSometimesFields: string[];
    requiredFields: string[];
    optionalFields: string[];
    ignoredVolatileFields: string[];
  };
  responseExpectations: {
    allowedStatusCodes: number[];
    bodyShapeRequiredKeys?: string[];
  };
  causalDependencies: {
    afterOperationIds: string[];
    triggerStepId?: string;
  };
}

export interface BehaviorContract {
  unitId: string;
  contractId: string;
  version: string;
  status: 'DRAFT' | 'REVIEW' | 'APPROVED' | 'DEPRECATED';
  integrity: {
    contentHash: string;
    algorithm: 'sha256';
    approvedBy?: string;
    approvedAt?: string;
  };
  scenarios: Array<{
    scenarioId: string;
    invariants: {
      network: Invariant<HttpEndpointInvariant>[];
      accessibilityAriaYaml?: Invariant<string>;
      accessibilityAriaJson?: Invariant<Record<string, unknown>>;
      navigation?: Invariant<{ destination: string }>[];
      storageDeltas: Invariant<Array<{
        storageType: 'localStorage' | 'sessionStorage';
        mutationType: 'SET' | 'REMOVE' | 'CLEAR';
        key: string;
        expectedPattern?: string;
      }>>[];
    };
  }>;
}
