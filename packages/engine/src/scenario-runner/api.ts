import { randomUUID } from 'node:crypto';
import type {
  HttpRequestEvent, HttpResponseEvent, RawObservedTrace, ScenarioDefinition, TraceEvent, UserInteractionEvent,
} from '@migration-harness/core';
import { parseScenario } from '@migration-harness/core';
import { ScenarioExecutionError } from './index.js';

/**
 * API-pure capture driver.
 *
 * A scenario whose steps are direct HTTP requests is executed against one application's base URL without a
 * browser: each step issues its call in order and records the same network-exchange and interaction events
 * the browser recorder produces, so the equivalence validator, sanitizer and reports consume the trace
 * unchanged. Server lifecycle belongs to the caller (the managed-serve lane); this driver only talks to the
 * URL it is given. Browser-driven and request-driven steps may not mix — the scenario schema refuses that
 * before a capture starts.
 */
export interface ApiCaptureOptions {
  /** Served origin of this application; defaults to the scenario entry URL, which is this side's route. */
  baseUrl?: string;
  /** Origins a request may address. Defaults to the base URL origin, mirroring the browser capture. */
  allowedOrigins?: string[];
  signal?: AbortSignal;
  /** Bound for one request/response exchange, mirroring the 10s browser step timeout. */
  stepTimeoutMs?: number;
  locale?: string;
  viewport?: { width: number; height: number };
  /** Only its locale is relevant here; browser recording options do not apply to an API capture. */
  traceRecorder?: { locale?: string };
  /** Browser-only evidence: refused here so an opted-in capture fails instead of silently recording nothing. */
  visualCapture?: boolean;
  webSocketSink?: unknown;
  /** Served build identity: verified on every response header the managed server echoes. */
  expectedBuild?: { origin: string; buildHash: string };
}

/** Response projections mirror the browser recorder's allow-list and caps byte for byte. */
const ALLOWED_RESPONSE_CONTENT_TYPES = ['application/json', 'text/plain', 'application/problem+json'];
const MAX_RESPONSE_BODY_BYTES = 256_000;
const STEP_TIMEOUT_MS = 10_000;

export const isApiScenario = (scenario: ScenarioDefinition): boolean =>
  scenario.steps.some(step => step.action === 'request');

const responseHeaders = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return headers;
};

/** Stop consuming a body we deliberately will not record; the connection is then free to close. */
const discardBody = async (response: Response): Promise<void> => {
  try { await response.body?.cancel(); } catch { /* the body was intentionally discarded */ }
};

/**
 * Recordable body of one response: parsed JSON or text inside the allow-list, `null` for a bodyless status
 * and the same omission records the browser recorder emits for anything else. Reading the body may reject
 * (transport or abort) — the caller decides whether that fails the step or is recorded as a read failure.
 */
async function projectResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (declaredLength > maxBytes) { await discardBody(response); return { omitted: true, reason: 'BODY_TOO_LARGE' }; }
  if (response.status === 204 || response.status === 304) return null;
  if (!ALLOWED_RESPONSE_CONTENT_TYPES.includes(contentType)) {
    await discardBody(response);
    return { omitted: true, reason: 'CONTENT_TYPE_NOT_ALLOWED', contentType: contentType || 'unknown' };
  }
  const text = await response.text();
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxBytes) return { omitted: true, reason: 'BODY_TOO_LARGE', byteLength };
  if (contentType.includes('json')) {
    try { return JSON.parse(text) as unknown; } catch { return { omitted: true, reason: 'BODY_READ_FAILED' }; }
  }
  return text;
}

export async function captureApiScenario(
  scenario: ScenarioDefinition, runIndex: number, options: ApiCaptureOptions = {},
): Promise<RawObservedTrace> {
  scenario = parseScenario(scenario);
  if (!scenario.steps.every(step => step.action === 'request')) throw new Error('A scenario may not mix request steps with browser interaction steps.');
  // Completion of a request step is its response receipt; anything else here cannot be honored by this driver.
  if (scenario.completionSignal) throw new Error('Request scenarios complete on response receipt; a scenario completionSignal cannot be honored.');
  if (scenario.preconditions.storageInitialState || scenario.preconditions.mockInitialApiResponses?.length) {
    throw new Error('Request scenarios cannot declare storage seeding or mocked API responses; those are browser preconditions.');
  }
  if (options.visualCapture) throw new Error('Visual checkpoints require the browser capture driver.');
  if (options.webSocketSink) throw new Error('WebSocket frames require the browser capture driver.');
  if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
  const base = options.baseUrl ?? scenario.entryUrl;
  const baseOrigin = new URL(base).origin;
  const allowedOrigins = new Set(options.allowedOrigins ?? [baseOrigin]);
  if (options.expectedBuild && baseOrigin !== options.expectedBuild.origin) throw new ScenarioExecutionError('BUILD_IDENTITY_MISMATCH');
  const timeoutMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const events: TraceEvent[] = [];
  const startedAt = new Date().toISOString();
  let sequence = 0;
  const nextSequence = (): number => { sequence += 1; return sequence; };
  for (const step of scenario.steps) {
    if (step.action !== 'request' || step.method === undefined || step.path === undefined) throw new Error(`Request step ${step.stepId} requires method and path.`);
    if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
    const url = new URL(step.path, base).toString();
    if (!allowedOrigins.has(new URL(url).origin)) throw new Error(`Request origin ${new URL(url).origin} is outside the allowed origins of this capture.`);
    if (step.method === 'GET' && step.body !== undefined) throw new Error(`A GET request step cannot declare a body: ${step.stepId}`);

    const interactionSequence = nextSequence();
    const interaction: UserInteractionEvent = {
      type: 'USER_INTERACTION', eventId: `evt_${interactionSequence}`, timestampMs: Date.now(), sequenceIndex: interactionSequence,
      stepId: step.stepId, action: 'request',
      ...(step.targetRole !== undefined ? { targetAriaRole: step.targetRole } : {}),
      ...(step.targetName !== undefined ? { targetAriaName: step.targetName } : {}),
    };
    events.push(interaction);

    const requestSequence = nextSequence();
    const requestEventId = `evt_${requestSequence}`;
    const correlationId = randomUUID();
    const requestStartedAt = Date.now();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (step.body !== undefined) headers['content-type'] = 'application/json';
    const requestEvent: HttpRequestEvent = {
      type: 'HTTP_REQUEST', eventId: requestEventId, timestampMs: requestStartedAt, sequenceIndex: requestSequence,
      correlationId, method: step.method, url, headers, payload: step.body ?? null,
    };
    events.push(requestEvent);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: step.method, headers, signal: controller.signal, redirect: 'error',
          ...(step.body !== undefined ? { body: JSON.stringify(step.body) } : {}),
        });
      } catch {
        if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
        // Headers never arrived: the step did not complete within its bound.
        throw new ScenarioExecutionError(timedOut ? 'COMPLETION_FAILED' : 'STEP_FAILED', step.stepId);
      }
      if (options.expectedBuild && response.headers.get('x-migration-build') !== options.expectedBuild.buildHash) {
        throw new ScenarioExecutionError('BUILD_IDENTITY_MISMATCH');
      }
      let body: unknown;
      try {
        body = await projectResponseBody(response, MAX_RESPONSE_BODY_BYTES);
      } catch {
        if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
        if (timedOut) throw new ScenarioExecutionError('COMPLETION_FAILED', step.stepId);
        // The response arrived but its body could not be read: recorded exactly like a browser read failure.
        body = { omitted: true, reason: 'BODY_READ_FAILED' };
      }
      const responseSequence = nextSequence();
      const responseEvent: HttpResponseEvent = {
        type: 'HTTP_RESPONSE', eventId: `evt_${responseSequence}`, timestampMs: Date.now(), sequenceIndex: responseSequence,
        correlationId, method: step.method, url, statusCode: response.status, headers: responseHeaders(response),
        body, requestToResponseEndMs: Math.max(0, Math.round(Date.now() - requestStartedAt)),
        causedByEventIds: [requestEventId],
      };
      events.push(responseEvent);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  return {
    scenarioId: scenario.scenarioId,
    runId: randomUUID(),
    runIndex,
    startedAt,
    events,
    // No browser observed this execution; the structural fields stay honest rather than claiming chromium.
    environment: { browser: 'none', viewport: options.viewport ?? { width: 1280, height: 720 }, locale: options.locale ?? options.traceRecorder?.locale ?? 'pt-BR' },
    completion: { status: 'COMPLETED', completedStepIds: scenario.steps.map(step => step.stepId) },
  };
}
