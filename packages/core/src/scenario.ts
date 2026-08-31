export type InteractionActionType = 'click' | 'fill' | 'select' | 'press' | 'focus';

export interface ScenarioInteractionStep {
  stepId: string;
  action: InteractionActionType;
  targetRole: string;
  targetName?: string;
  inputValue?: string;
  description?: string;
  completionSignal?: CompletionSignal;
}

export interface MockApiResponse {
  urlPattern: string;
  method: string;
  statusCode: number;
  fixturePath: string;
}

export interface ScenarioPrecondition {
  storageInitialState?: {
    local?: Record<string, string>;
    session?: Record<string, string>;
  };
  mockInitialApiResponses?: MockApiResponse[];
}

export type CompletionSignal =
  | {
      type: 'LOCATOR_VISIBLE';
      targetRole: string;
      targetName?: string;
      timeoutMs: number;
    }
  | {
      type: 'RESPONSE_RECEIVED';
      responseUrlPattern: string;
      responseMethod: string;
      timeoutMs: number;
    }
  | {
      type: 'STORAGE_KEY_SET';
      storageType: 'localStorage' | 'sessionStorage';
      storageKey: string;
      timeoutMs: number;
    };

export interface ScenarioDefinition {
  scenarioId: string;
  unitId: string;
  name: string;
  description: string;
  entryUrl: string;
  preconditions: ScenarioPrecondition;
  steps: ScenarioInteractionStep[];
  completionSignal?: CompletionSignal;
  testDataProfile: 'standard' | 'edge_case' | 'error_flow';
}
