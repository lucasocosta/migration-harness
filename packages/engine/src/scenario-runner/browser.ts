import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from '@playwright/test';
import { parseScenario, urlPatternMatches, type CompletionSignal, type RawObservedTrace, type ScenarioDefinition } from '@migration-harness/core';
import { captureApiScenario } from './api.js';
import { ScenarioRunner, type ScenarioPhaseRecorder, type ScenarioRunnerOptions, type WebSocketFrameSink } from './index.js';

type WebSocketCompletionSignal = Extract<CompletionSignal, { type: 'WEBSOCKET_FRAME' }>;

/** Chromium process handed between harness layers; one per operation, never a shared context. */
export type CaptureBrowser = Browser;

export async function preflightBrowser(): Promise<void> {
  const browser = await chromium.launch({ timeout: 10000 });
  await browser.close();
}

/**
 * Launch one Chromium owned by the caller (the operation closes it in `finally`). A capture never
 * borrows a context: every capture gets a fresh `BrowserContext` even when the process is shared.
 */
export async function launchBrowser(options: { timeout?: number } = {}): Promise<Browser> {
  return chromium.launch(options.timeout === undefined ? {} : { timeout: options.timeout });
}

/** Record one capture span when a recorder is present; otherwise just run (observation-only path). */
const record = async <T>(timings: ScenarioPhaseRecorder | undefined, name: string, run: () => T | Promise<T>,
  detail?: Record<string, string | number | boolean>): Promise<T> => timings ? timings.phase(name, run, detail) : await run();

export function webSocketCompletionSignals(scenario: ScenarioDefinition): WebSocketCompletionSignal[] {
  return [scenario.completionSignal, ...scenario.steps.map(step => step.completionSignal)]
    .filter((signal): signal is WebSocketCompletionSignal => signal?.type === 'WEBSOCKET_FRAME');
}

export async function captureScenario(scenario: ScenarioDefinition, runIndex: number, options: ScenarioRunnerOptions & { browser?: Browser; baseUrl?: string; allowedOrigins?: string[]; signal?: AbortSignal } = {}): Promise<RawObservedTrace> {
  scenario = parseScenario(structuredClone(scenario));
  // API-pure scenarios never launch a browser: the request driver talks to the side's base URL directly.
  if (scenario.steps.some(step => step.action === 'request')) return captureApiScenario(scenario, runIndex, options);
  if (options.baseUrl) {
    const entry = new URL(scenario.entryUrl);
    scenario.entryUrl = new URL(`${entry.pathname}${entry.search}${entry.hash}`, options.baseUrl).toString();
  }
  if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
  const detail = { scenarioId: scenario.scenarioId, runIndex };
  // `launch` is measured only when this capture owns the process; a shared browser was launched once
  // by the operation (its `launch`/`preflightBrowser` span), so reuse shows up as a missing span.
  const owned = !options.browser;
  const browser = options.browser ?? await record(options.timings, 'launch', () => chromium.launch(), detail);
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
  let closing: Promise<void> | undefined;
  const abort = (): void => { if (context) closing ??= context.close().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
    // Workers are default-deny. Opted-in traffic is routed at context level;
    // the recorder separately verifies the bounded transparent-proxy contract.
    const prepared = await record(options.timings, 'context', async () => {
      context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 720 }, locale: options.locale ?? options.traceRecorder?.locale ?? 'pt-BR', serviceWorkers: scenario.serviceWorkers ?? 'block', acceptDownloads: false });
      if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
      context.setDefaultTimeout(10000);
      const origins = new Set(options.allowedOrigins ?? [new URL(scenario.entryUrl).origin]);
      await context.route('**/*', route => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
      // WebSockets require an explicit completion signal; opted-in connections are proxied and captured frame-by-frame.
      const patterns = [...new Set(webSocketCompletionSignals(scenario).map(signal => signal.urlPattern))];
      const sink: WebSocketFrameSink = {};
      await context.routeWebSocket('**/*', socket => {
        const url = socket.url();
        if (!patterns.some(pattern => urlPatternMatches(pattern, url))) { socket.close(); return; }
        const server = socket.connectToServer();
        const connectionId = randomUUID();
        socket.onMessage(message => { sink.handler?.('sent', url, message, connectionId); server.send(message); });
        server.onMessage(message => { sink.handler?.('received', url, message, connectionId); socket.send(message); });
      });
      const opened = await context.newPage();
      return { opened, patterns, sink };
    }, detail);
    return await new ScenarioRunner(prepared.opened, { ...options, ...(prepared.patterns.length ? { webSocketSink: prepared.sink } : {}) }).run(scenario, runIndex);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    // `close` = this capture's context teardown plus the process close when this capture owns it.
    await record(options.timings, 'close', async () => {
      try { if (context) await (closing ?? context.close()); }
      finally { if (owned) await browser.close(); }
    }, detail);
  }
}
