export type TraceEventType =
  | 'USER_INTERACTION'
  | 'HTTP_REQUEST'
  | 'HTTP_RESPONSE'
  | 'HTTP_FAILED'
  | 'ARIA_STATE_CHANGE'
  | 'STORAGE_DELTA'
  | 'NAVIGATION';

export interface BaseTraceEvent {
  eventId: string;
  timestampMs: number;
  sequenceIndex: number;
  correlationId?: string;
}

export interface UserInteractionEvent extends BaseTraceEvent {
  type: 'USER_INTERACTION';
  stepId: string;
  action: 'click' | 'fill' | 'select' | 'press' | 'focus';
  targetAriaRole: string;
  targetAriaName?: string;
  inputValue?: string;
}

export interface HttpRequestEvent extends BaseTraceEvent {
  type: 'HTTP_REQUEST';
  method: string;
  url: string;
  headers: Record<string, string>;
  payload: unknown;
}

export interface HttpResponseEvent extends BaseTraceEvent {
  type: 'HTTP_RESPONSE';
  method: string;
  url: string;
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  requestToResponseEndMs: number;
}

export interface HttpFailedEvent extends BaseTraceEvent {
  type: 'HTTP_FAILED';
  method: string;
  url: string;
  errorText: string;
}

export interface AriaStateEvent extends BaseTraceEvent {
  type: 'ARIA_STATE_CHANGE';
  triggerEventId: string;
  rawYamlTree: string;
  jsonTree: Record<string, unknown>;
}

export interface StorageDeltaEvent extends BaseTraceEvent {
  type: 'STORAGE_DELTA';
  storageType: 'localStorage' | 'sessionStorage';
  mutationType: 'SET' | 'REMOVE' | 'CLEAR';
  key: string;
  previousValue: string | null;
  newValue: string | null;
}

export interface NavigationEvent extends BaseTraceEvent {
  type: 'NAVIGATION';
  fromUrl: string;
  toUrl: string;
}

export type TraceEvent =
  | UserInteractionEvent
  | HttpRequestEvent
  | HttpResponseEvent
  | HttpFailedEvent
  | AriaStateEvent
  | StorageDeltaEvent
  | NavigationEvent;

export interface TraceEnvironment {
  browser: string;
  viewport: { width: number; height: number };
  locale: string;
}

export interface RawObservedTrace {
  scenarioId: string;
  runIndex: number;
  startedAt: string;
  events: TraceEvent[];
  environment: TraceEnvironment;
}

export interface SanitizedObservedTrace extends RawObservedTrace {
  sanitization: {
    version: string;
    appliedAt: string;
    redactionsCount: number;
  };
}
