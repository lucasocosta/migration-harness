import { randomUUID } from 'node:crypto';
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
  WebSocketFrameDirection,
} from '@migration-harness/core';
import { matchesDeclaredShape, urlPatternMatches, valueShape } from '@migration-harness/core';

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
}

export class TemporalTraceRecorder {
  private events: TraceEvent[] = [];
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
    this.listenersInstalled = true;
  }

  async finish(scenarioId: string, runIndex: number): Promise<RawObservedTrace> {
    if (!this.listenersInstalled) throw new Error('Trace recorder is not running.');
    try { await this.drainPendingHandlers(); } finally { this.detachListeners(); }
    if (this.handlerErrors.length) throw new Error('Trace capture failed while recording a response.');

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
    this.pushEvent({
      type: 'HTTP_REQUEST',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: startedAtMs,
      sequenceIndex,
      correlationId,
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      payload: parseBody(request.postData()),
    });
  };

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
    this.pushEvent({
      type: 'HTTP_FAILED',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      correlationId: meta.correlationId,
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText ?? 'Unknown request failure',
      causedByEventIds: [meta.requestEventId],
    });
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
      this.pushEvent({ type: 'HTTP_FAILED', eventId: `evt_${sequenceIndex}`, timestampMs: Date.now(), sequenceIndex, correlationId: meta.correlationId, method: request.method(), url: request.url(), errorText: 'Response unavailable after request completion', causedByEventIds: [meta.requestEventId] });
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
    const sequenceIndex = this.nextSeq();
    this.pushEvent({
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
      causedByEventIds: [meta.requestEventId],
    });
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
