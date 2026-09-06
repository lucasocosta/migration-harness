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

/** Declared structural matcher over valueShape(payload): leaf type names, 'any', or nested shapes. An empty record matches any object payload. */
export interface ScenarioFrameShape {
  [key: string]: 'any' | 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | ScenarioFrameShape;
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
    }
  | {
      type: 'WEBSOCKET_FRAME';
      urlPattern: string;
      direction: 'sent' | 'received';
      payloadShape: ScenarioFrameShape;
      timeoutMs: number;
    };

/** Scenario-level policy. The harness defaults to block; allow supports verified transparent network proxies only. */
export type ServiceWorkerMode = 'block' | 'allow';

export interface ScenarioDefinition {
  scenarioId: string;
  unitId: string;
  name: string;
  description: string;
  entryUrl: string;
  preconditions: ScenarioPrecondition;
  steps: ScenarioInteractionStep[];
  completionSignal?: CompletionSignal;
  /** Opt-in transparent service workers. Cached, rewritten or autonomous exchanges require review. */
  serviceWorkers?: ServiceWorkerMode;
  testDataProfile: 'standard' | 'edge_case' | 'error_flow';
}
