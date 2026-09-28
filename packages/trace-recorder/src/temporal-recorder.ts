import { randomUUID, createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { Page, Request } from '@playwright/test';
import type {
  AriaStateEvent,
  RawObservedTrace,
  ScenarioFrameShape,
  StorageDeltaEvent,
  TraceEnvironment,
  TraceEvent,
  UserInteractionEvent,
  VisualCheckpointEvent,
  WebSocketFrameDirection,
} from '@migration-harness/core';
import { canonical, matchesDeclaredShape, urlPatternMatches, valueShape } from '@migration-harness/core';

interface PendingRequestMeta {
  correlationId: string;
  startedAtMs: number;
  requestEventId: string;
}

type StorageSnapshot = {
  local: Record<string, string>;
  session: Record<string, string>;
};

export interface TraceRecorderOptions {
  shouldRecordRequest?: (request: Request) => boolean;
  maxResponseBodyBytes?: number;
  maxWebSocketFrameBytes?: number;
  allowedResponseContentTypes?: readonly string[];
  locale?: string;
  drainTimeoutMs?: number;
  /** Opted-in workers must be transparent one-to-one network proxies in this adapter. */
  validateServiceWorkerProxy?: boolean;
}

export class TemporalTraceRecorder {
  private events: TraceEvent[] = [];
  private workerEvents: TraceEvent[] = [];
  private sequenceCounter = 0;
  private requestCorrelations = new WeakMap<Request, PendingRequestMeta>();
  private pendingAsyncHandlers = new Set<Promise<void>>();
  private startedAt = '';
  private runId = '';
  private initialUrl = '';
  private listenersInstalled = false;
  private lastMainFrameUrl = '';
  private inFlight = new Set<Request>();
  private handlerErrors: unknown[] = [];
  private lastUserInteractionEventId = '';

  private readonly options: Required<Pick<TraceRecorderOptions, 'maxResponseBodyBytes' | 'maxWebSocketFrameBytes' | 'allowedResponseContentTypes' | 'locale'>> & TraceRecorderOptions;

  constructor(private readonly page: Page, options: TraceRecorderOptions = {}) {
    this.options = {
      ...options,
      maxResponseBodyBytes: options.maxResponseBodyBytes ?? 256_000,
      maxWebSocketFrameBytes: options.maxWebSocketFrameBytes ?? 32_000,
      allowedResponseContentTypes: options.allowedResponseContentTypes ?? [
        'application/json',
        'text/plain',
        'application/problem+json',
      ],
      locale: options.locale ?? 'pt-BR',
    };
  }

  start(): void {
    if (this.listenersInstalled) throw new Error('Trace recorder is already running.');
    this.events = [];
    this.workerEvents = [];
    this.sequenceCounter = 0;
    this.requestCorrelations = new WeakMap<Request, PendingRequestMeta>();
    this.pendingAsyncHandlers.clear();
    this.inFlight.clear();
    this.handlerErrors = [];
    this.startedAt = new Date().toISOString();
    this.runId = randomUUID();
    this.initialUrl = this.page.url();
    this.lastMainFrameUrl = this.initialUrl;

    this.page.on('request', this.onRequest);
    this.page.on('requestfinished', this.onRequestFinished);
    this.page.on('requestfailed', this.onRequestFailed);
    this.page.on('framenavigated', this.onFrameNavigated);
    if (this.options.validateServiceWorkerProxy) {
      this.page.context().on('request', this.onWorkerRequest);
      this.page.context().on('requestfinished', this.onWorkerRequestFinished);
      this.page.context().on('requestfailed', this.onWorkerRequestFailed);
    }
    this.listenersInstalled = true;
  }

  async finish(scenarioId: string, runIndex: number): Promise<RawObservedTrace> {
    if (!this.listenersInstalled) throw new Error('Trace recorder is not running.');
    try { await this.drainPendingHandlers(); } finally { this.detachListeners(); }
    if (this.handlerErrors.length) throw new Error('Trace capture failed while recording a response.');
    if (this.options.validateServiceWorkerProxy) this.verifyTransparentWorker();

    return {
      scenarioId,
      runId: this.runId,
      runIndex,
      startedAt: this.startedAt,
      events: [...this.events].sort((a, b) => a.sequenceIndex - b.sequenceIndex),
      environment: await this.environment(),
    };
  }

  async abort(): Promise<void> {
    if (!this.listenersInstalled) return;
    this.detachListeners();
    await Promise.allSettled([...this.pendingAsyncHandlers]);
  }

  recordUserInteraction(input: Omit<UserInteractionEvent, keyof Pick<UserInteractionEvent,
    'eventId' | 'timestampMs' | 'sequenceIndex' | 'type'>>): UserInteractionEvent {
    const sequenceIndex = this.nextSeq();
    const event = this.pushEvent({
      ...input,
      type: 'USER_INTERACTION',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
    });
    this.lastUserInteractionEventId = event.eventId;
    return event;
  }

  /** Capture a routed WebSocket frame. Only ever active while recording: frames observed after finish/abort must not leak into the trace. */
  recordWebSocketFrame(direction: WebSocketFrameDirection, connectionUrl: string, payload: string | Buffer, connectionId: string = randomUUID()): void {
    if (!this.listenersInstalled) return;
    const byteLength = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.byteLength;
    const framePayload: unknown = typeof payload !== 'string' ? { omitted: true, reason: 'BINARY_FRAME', byteLength }
      : byteLength > this.options.maxWebSocketFrameBytes ? { omitted: true, reason: 'FRAME_TOO_LARGE', byteLength }
      : parseBody(payload);
    const causedBy = this.lastUserInteractionEventId;
    const sequenceIndex = this.nextSeq();
    this.pushEvent({
      type: 'WEBSOCKET_FRAME',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      correlationId: connectionId,
      url: connectionUrl,
      direction,
      payload: framePayload,
      ...(causedBy ? { causedByEventIds: [causedBy] } : {}),
    });
  }

  async waitForWebSocketFrame(input: { urlPattern: string; direction: WebSocketFrameDirection; payloadShape: ScenarioFrameShape; timeoutMs: number }): Promise<void> {
    const deadline = Date.now() + input.timeoutMs;
    for (;;) {
      const matched = this.events.some(event => event.type === 'WEBSOCKET_FRAME'
        && urlPatternMatches(input.urlPattern, event.url)
        && event.direction === input.direction
        && matchesDeclaredShape(input.payloadShape, valueShape(event.payload)));
      if (matched) return;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for a matching WebSocket frame.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  async captureAria(triggerEventId: string): Promise<AriaStateEvent> {
    const body = this.page.locator('body');
    const jsonTree = await body.ariaSnapshotJSON();
    const rawYamlTree = stringify(jsonTree);
    const sequenceIndex = this.nextSeq();
    return this.pushEvent({
      type: 'ARIA_STATE_CHANGE',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      triggerEventId,
      rawYamlTree,
      jsonTree: Array.isArray(jsonTree) ? { children: jsonTree } : jsonTree as Record<string, unknown>,
    });
  }

  /**
   * Optional visual checkpoint (policy.visual.enabled). Image bytes are hashed here and
   * discarded from the trace; private storage is the only place screenshots may be kept
   * by callers that opt into writing them. The event carries structure only.
   */
  async captureVisual(triggerEventId: string, options: { retainBytes?: (bytes: Buffer) => Promise<void> } = {}): Promise<VisualCheckpointEvent> {
    const bytes = await this.page.screenshot({ type: 'png', animations: 'disabled' });
    const buffer = Buffer.from(bytes);
    if (options.retainBytes) await options.retainBytes(buffer);
    const sequenceIndex = this.nextSeq();
    // Probe dimensions from the PNG IHDR without retaining pixels in the event.
    const width = buffer.length > 20 ? buffer.readUInt32BE(16) : 0;
    const height = buffer.length > 20 ? buffer.readUInt32BE(20) : 0;
    return this.pushEvent({
      type: 'VISUAL_CHECKPOINT',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      triggerEventId,
      imageSha256: createHash('sha256').update(buffer).digest('hex'),
      width,
      height,
    });
  }

  async captureStorage(): Promise<StorageSnapshot> {
    return this.page.evaluate(() => ({
      local: Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
          .filter((key): key is string => key !== null)
          .map((key) => [key, localStorage.getItem(key) ?? '']),
      ),
      session: Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i))
          .filter((key): key is string => key !== null)
          .map((key) => [key, sessionStorage.getItem(key) ?? '']),
      ),
    }));
  }

  recordStorageDeltas(before: StorageSnapshot, after: StorageSnapshot): StorageDeltaEvent[] {
    return [
      ...this.recordStorageDeltaFor('localStorage', before.local, after.local),
      ...this.recordStorageDeltaFor('sessionStorage', before.session, after.session),
    ];
  }

  private readonly onRequest = (request: Request): void => {
    if (!this.shouldRecord(request)) return;
    const sequenceIndex = this.nextSeq();
    const correlationId = randomUUID();
    const startedAtMs = Date.now();
    this.requestCorrelations.set(request, { correlationId, startedAtMs, requestEventId: `evt_${sequenceIndex}` });
    this.inFlight.add(request);
    this.pushHttpEvent({
      type: 'HTTP_REQUEST',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: startedAtMs,
      sequenceIndex,
      correlationId,
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      payload: parseBody(request.postData()),
    }, request);
  };

  private readonly onWorkerRequest = (request: Request): void => { if (request.serviceWorker()) this.onRequest(request); };
  private readonly onWorkerRequestFinished = (request: Request): void => { if (request.serviceWorker()) this.onRequestFinished(request); };
  private readonly onWorkerRequestFailed = (request: Request): void => { if (request.serviceWorker()) this.onRequestFailed(request); };

  private readonly onRequestFinished = (request: Request): void => {
    const meta = this.requestCorrelations.get(request);
    if (!meta) return;
    const task = this.captureFinishedRequest(request, meta).catch(error => { this.handlerErrors.push(error); }).finally(() => { this.pendingAsyncHandlers.delete(task); this.inFlight.delete(request); });
    this.pendingAsyncHandlers.add(task);
  };

  private readonly onRequestFailed = (request: Request): void => {
    const meta = this.requestCorrelations.get(request);
    if (!meta) return;
    const task = this.captureFailedRequest(request, meta).catch(error => { this.handlerErrors.push(error); }).finally(() => { this.pendingAsyncHandlers.delete(task); this.inFlight.delete(request); });
    this.pendingAsyncHandlers.add(task);
  };

  private async captureFailedRequest(request: Request, meta: PendingRequestMeta): Promise<void> {
    // Chromium can report ERR_ABORTED after a fulfilled bodyless response.
    const response = await request.response();
    if (response && (response.status() === 204 || response.status() === 304 || request.method() === 'HEAD') && request.failure()?.errorText === 'net::ERR_ABORTED') {
      await this.captureFinishedRequest(request, meta);
      return;
    }
    const sequenceIndex = this.nextSeq();
    this.pushHttpEvent({
      type: 'HTTP_FAILED',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      correlationId: meta.correlationId,
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText ?? 'Unknown request failure',
      causedByEventIds: [meta.requestEventId],
    }, request);
  }

  private readonly onFrameNavigated = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame !== this.page.mainFrame()) return;
    const toUrl = frame.url();
    const fromUrl = this.lastMainFrameUrl || this.initialUrl;
    if (!toUrl || toUrl === fromUrl && this.events.some(event => event.type === 'NAVIGATION')) return;
    this.lastMainFrameUrl = toUrl;
    const sequenceIndex = this.nextSeq();
    this.pushEvent({
      type: 'NAVIGATION',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      fromUrl,
      toUrl,
    });
  };

  private async captureFinishedRequest(request: Request, meta: PendingRequestMeta): Promise<void> {
    const response = await request.response();
    if (!response) {
      const sequenceIndex = this.nextSeq();
      this.pushHttpEvent({ type: 'HTTP_FAILED', eventId: `evt_${sequenceIndex}`, timestampMs: Date.now(), sequenceIndex, correlationId: meta.correlationId, method: request.method(), url: request.url(), errorText: 'Response unavailable after request completion', causedByEventIds: [meta.requestEventId] }, request);
      return;
    }
    const declaredLength = Number(response.headers()['content-length'] ?? '0');
    const body = declaredLength > this.options.maxResponseBodyBytes ? { omitted: true, reason: 'BODY_TOO_LARGE' }
      : response.status() === 204 || response.status() === 304 || request.method() === 'HEAD' ? null
      : await this.safeResponseBody(response.headers()['content-type'] ?? '', response.body.bind(response));
    const timing = request.timing();
    const duration = timing.requestStart >= 0 && timing.responseEnd >= 0
      ? Math.max(0, timing.responseEnd - timing.requestStart)
      : Math.max(0, Date.now() - meta.startedAtMs);
    // NON-COMPARABLE EVIDENCE METADATA: response.fromServiceWorker() is Playwright's signal that a service
    // worker fetch handler fulfilled the response (request.serviceWorker() stays null for page-initiated
    // requests). Emitted only when true so default traces are unchanged; equivalence never reads this field.
    const servedByServiceWorker = response.fromServiceWorker();
    const sequenceIndex = this.nextSeq();
    this.pushHttpEvent({
      type: 'HTTP_RESPONSE',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      correlationId: meta.correlationId,
      method: request.method(),
      url: request.url(),
      statusCode: response.status(),
      headers: response.headers(),
      body,
      requestToResponseEndMs: Math.round(duration),
      ...(servedByServiceWorker ? { servedByServiceWorker: true } : {}),
      causedByEventIds: [meta.requestEventId],
    }, request);
  }

  private async safeResponseBody(contentType: string, readBody: () => Promise<Buffer>): Promise<unknown> {
    const normalizedType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!this.options.allowedResponseContentTypes.includes(normalizedType)) {
      return { omitted: true, reason: 'CONTENT_TYPE_NOT_ALLOWED', contentType: normalizedType || 'unknown' };
    }
    try {
      const buffer = await readBody();
      if (buffer.byteLength > this.options.maxResponseBodyBytes) {
        return { omitted: true, reason: 'BODY_TOO_LARGE', byteLength: buffer.byteLength };
      }
      const text = buffer.toString('utf8');
      if (normalizedType.includes('json')) return JSON.parse(text) as unknown;
      return text;
    } catch {
      return { omitted: true, reason: 'BODY_READ_FAILED' };
    }
  }

  private shouldRecord(request: Request): boolean {
    if (this.options.shouldRecordRequest) return this.options.shouldRecordRequest(request);
    const type = request.resourceType();
    return type === 'xhr' || type === 'fetch';
  }

  private async drainPendingHandlers(): Promise<void> {
    const deadline = Date.now() + (this.options.drainTimeoutMs ?? 10000);
    while (this.pendingAsyncHandlers.size > 0 || this.inFlight.size > 0) {
      if (Date.now() >= deadline) throw new Error('Timed out draining recorded HTTP requests.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  private detachListeners(): void {
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onRequestFinished);
    this.page.off('requestfailed', this.onRequestFailed);
    this.page.off('framenavigated', this.onFrameNavigated);
    this.page.context().off('request', this.onWorkerRequest);
    this.page.context().off('requestfinished', this.onWorkerRequestFinished);
    this.page.context().off('requestfailed', this.onWorkerRequestFailed);
    this.listenersInstalled = false;
  }

  private async environment(): Promise<TraceEnvironment> {
    return {
      browser: this.page.context().browser()?.browserType().name() ?? 'unknown',
      viewport: this.page.viewportSize() ?? { width: 1280, height: 720 },
      locale: await this.page.evaluate(() => navigator.language),
    };
  }

  private nextSeq(): number {
    this.sequenceCounter += 1;
    return this.sequenceCounter;
  }

  private pushEvent<T extends TraceEvent>(event: T): T {
    this.events.push(event);
    return event;
  }

  private pushHttpEvent<T extends TraceEvent>(event: T, request: Request): T {
    if (request.serviceWorker()) { this.workerEvents.push(event); return event; }
    return this.pushEvent(event);
  }

  private verifyTransparentWorker(): void {
    const fingerprint = (events: TraceEvent[], servedOnly: boolean): string[] => {
      const requests = events.filter(event => event.type === 'HTTP_REQUEST');
      return events.flatMap(event => {
        if (event.type !== 'HTTP_RESPONSE' || servedOnly && !event.servedByServiceWorker) return [];
        const request = requests.find(request => request.correlationId === event.correlationId);
        if (!request) throw new Error('Incomplete service-worker network evidence.');
        // Chromium may not expose a worker-owned response body. The page body remains
        // the observable response checked by the normal validator; forwarding checks
        // cover outgoing request identity/payload and terminal status independently.
        return [canonical({ method: request.method, url: request.url, payload: request.payload, status: event.statusCode })];
      });
    };
    const outgoing = fingerprint(this.workerEvents, false);
    const incoming = fingerprint(this.events, true);
    if (outgoing.length !== this.workerEvents.filter(event => event.type === 'HTTP_REQUEST').length) throw new Error('Unsupported service-worker traffic: failed or incomplete network exchange.');
    for (const exchange of incoming) {
      const index = outgoing.indexOf(exchange);
      if (index < 0) throw new Error('Unsupported service-worker traffic: only transparent network proxies are supported; cached or rewritten responses require review.');
      outgoing.splice(index, 1);
    }
    if (outgoing.length) throw new Error('Unsupported service-worker traffic: autonomous network requests require review.');
  }

  private recordStorageDeltaFor(
    storageType: 'localStorage' | 'sessionStorage',
    before: Record<string, string>,
    after: Record<string, string>,
  ): StorageDeltaEvent[] {
    const result: StorageDeltaEvent[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const previousValue = before[key] ?? null;
      const newValue = after[key] ?? null;
      if (previousValue === newValue) continue;
      const sequenceIndex = this.nextSeq();
      result.push(this.pushEvent({
        type: 'STORAGE_DELTA',
        eventId: `evt_${sequenceIndex}`,
        timestampMs: Date.now(),
        sequenceIndex,
        storageType,
        mutationType: newValue === null ? 'REMOVE' : 'SET',
        key,
        previousValue,
        newValue,
      }));
    }
    return result;
  }
}

function parseBody(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}
