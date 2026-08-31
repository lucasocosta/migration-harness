import { randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import type {
  AriaStateEvent,
  RawObservedTrace,
  StorageDeltaEvent,
  TraceEnvironment,
  TraceEvent,
  UserInteractionEvent,
} from '@migration-harness/core';

interface PendingRequestMeta {
  correlationId: string;
  startedAtMs: number;
}

type StorageSnapshot = {
  local: Record<string, string>;
  session: Record<string, string>;
};

export interface TraceRecorderOptions {
  shouldRecordRequest?: (request: Request) => boolean;
  maxResponseBodyBytes?: number;
  allowedResponseContentTypes?: readonly string[];
  locale?: string;
}

export class TemporalTraceRecorder {
  private events: TraceEvent[] = [];
  private sequenceCounter = 0;
  private requestCorrelations = new WeakMap<Request, PendingRequestMeta>();
  private pendingAsyncHandlers = new Set<Promise<void>>();
  private startedAt = '';
  private initialUrl = '';
  private listenersInstalled = false;
  private lastMainFrameUrl = '';

  private readonly options: Required<Pick<TraceRecorderOptions, 'maxResponseBodyBytes' | 'allowedResponseContentTypes' | 'locale'>> & TraceRecorderOptions;

  constructor(private readonly page: Page, options: TraceRecorderOptions = {}) {
    this.options = {
      ...options,
      maxResponseBodyBytes: options.maxResponseBodyBytes ?? 256_000,
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
    this.startedAt = new Date().toISOString();
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
    await this.drainPendingHandlers();
    this.detachListeners();

    return {
      scenarioId,
      runIndex,
      startedAt: this.startedAt,
      events: [...this.events].sort((a, b) => a.sequenceIndex - b.sequenceIndex),
      environment: this.environment(),
    };
  }

  async abort(): Promise<void> {
    if (!this.listenersInstalled) return;
    await this.drainPendingHandlers();
    this.detachListeners();
  }

  recordUserInteraction(input: Omit<UserInteractionEvent, keyof Pick<UserInteractionEvent,
    'eventId' | 'timestampMs' | 'sequenceIndex' | 'type'>>): UserInteractionEvent {
    const sequenceIndex = this.nextSeq();
    return this.pushEvent({
      ...input,
      type: 'USER_INTERACTION',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
    });
  }

  async captureAria(triggerEventId: string): Promise<AriaStateEvent> {
    const body = this.page.locator('body');
    const rawYamlTree = await body.ariaSnapshot();
    const jsonTree = await body.ariaSnapshotJSON({ boxes: true });
    const sequenceIndex = this.nextSeq();
    return this.pushEvent({
      type: 'ARIA_STATE_CHANGE',
      eventId: `evt_${sequenceIndex}`,
      timestampMs: Date.now(),
      sequenceIndex,
      triggerEventId,
      rawYamlTree,
      jsonTree: jsonTree as Record<string, unknown>,
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
    this.requestCorrelations.set(request, { correlationId, startedAtMs });
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
    const task = this.captureFinishedRequest(request, meta).finally(() => this.pendingAsyncHandlers.delete(task));
    this.pendingAsyncHandlers.add(task);
  };

  private readonly onRequestFailed = (request: Request): void => {
    const meta = this.requestCorrelations.get(request);
    if (!meta) return;
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
    });
  };

  private readonly onFrameNavigated = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame !== this.page.mainFrame()) return;
    const toUrl = frame.url();
    const fromUrl = this.lastMainFrameUrl || this.initialUrl;
    if (!toUrl || toUrl === fromUrl) return;
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
    if (!response) return;
    const body = await this.safeResponseBody(response.headers()['content-type'] ?? '', response.body.bind(response));
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
    while (this.pendingAsyncHandlers.size > 0) {
      await Promise.all([...this.pendingAsyncHandlers]);
    }
  }

  private detachListeners(): void {
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onRequestFinished);
    this.page.off('requestfailed', this.onRequestFailed);
    this.page.off('framenavigated', this.onFrameNavigated);
    this.listenersInstalled = false;
  }

  private environment(): TraceEnvironment {
    return {
      browser: this.page.context().browser()?.browserType().name() ?? 'unknown',
      viewport: this.page.viewportSize() ?? { width: 1280, height: 720 },
      locale: this.options.locale,
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
