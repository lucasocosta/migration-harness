export type TraceEventType =
  | 'USER_INTERACTION'
  | 'HTTP_REQUEST'
  | 'HTTP_RESPONSE'
  | 'HTTP_FAILED'
  | 'ARIA_STATE_CHANGE'
  | 'STORAGE_DELTA'
  | 'NAVIGATION'
  | 'WEBSOCKET_FRAME'
  | 'VISUAL_CHECKPOINT';

export interface BaseTraceEvent {
  eventId: string;
  timestampMs: number;
  sequenceIndex: number;
  correlationId?: string;
  causedByEventIds?: string[];
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
  /**
   * NON-COMPARABLE EVIDENCE METADATA — never an equivalence input. True only when Playwright reports the
   * response as fulfilled by a service worker's fetch handler; absent otherwise. Whether a response came from
   * a worker is an implementation detail, not observable behavior: equivalence stays on network shapes,
   * status, storage and ARIA. A schema mutation adding/removing this field must not change any comparison.
   */
  servedByServiceWorker?: boolean;
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

export type WebSocketFrameDirection = 'sent' | 'received';

export interface WebSocketFrameEvent extends BaseTraceEvent {
  type: 'WEBSOCKET_FRAME';
  /** Connection URL; correlationId identifies the individual connection across frames. */
  url: string;
  direction: WebSocketFrameDirection;
  /** Text frames parsed to JSON when possible, otherwise the string; binary/oversized frames are replaced by an omission record. */
  payload: unknown;
}

export interface VisualCheckpointEvent extends BaseTraceEvent {
  type: 'VISUAL_CHECKPOINT';
  /** Capture trigger shared with the ARIA checkpoint vocabulary (mount, step interaction or scenario end). */
  triggerEventId: string;
  /** SHA-256 of the PNG screenshot bytes. Image bytes live only in private storage, never in the trace. */
  imageSha256: string;
  width: number;
  height: number;
}

export type TraceEvent =
  | UserInteractionEvent
  | HttpRequestEvent
  | HttpResponseEvent
  | HttpFailedEvent
  | AriaStateEvent
  | StorageDeltaEvent
  | NavigationEvent
  | WebSocketFrameEvent
  | VisualCheckpointEvent;

export interface TraceEnvironment {
  browser: string;
  viewport: { width: number; height: number };
  locale: string;
}

export interface RawObservedTrace {
  scenarioId: string;
  runId?: string;
  runIndex: number;
  startedAt: string;
  events: TraceEvent[];
  environment: TraceEnvironment;
  completion?: { status: 'COMPLETED' | 'FAILED'; completedStepIds: string[] };
}

export interface SanitizedObservedTrace extends RawObservedTrace {
  sanitization: {
    version: string;
    appliedAt: string;
    redactionsCount: number;
  };
}
