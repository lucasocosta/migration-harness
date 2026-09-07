import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from '@playwright/test';
import { parseScenario, urlPatternMatches, type CompletionSignal, type RawObservedTrace, type ScenarioDefinition } from '@migration-harness/core';
import { ScenarioRunner, type ScenarioRunnerOptions, type WebSocketFrameSink } from './index.js';

type WebSocketCompletionSignal = Extract<CompletionSignal, { type: 'WEBSOCKET_FRAME' }>;
export async function preflightBrowser(): Promise<void> {
  const browser = await chromium.launch({ timeout: 10000 });
  await browser.close();
}
export function webSocketCompletionSignals(scenario: ScenarioDefinition): WebSocketCompletionSignal[] {
  return [scenario.completionSignal, ...scenario.steps.map(step => step.completionSignal)]
    .filter((signal): signal is WebSocketCompletionSignal => signal?.type === 'WEBSOCKET_FRAME');
}

export async function captureScenario(scenario: ScenarioDefinition, runIndex: number, options: ScenarioRunnerOptions & { browser?: Browser; baseUrl?: string; allowedOrigins?: string[]; signal?: AbortSignal } = {}): Promise<RawObservedTrace> {
  scenario = parseScenario(structuredClone(scenario));
  if (options.baseUrl) {
    const entry = new URL(scenario.entryUrl);
    scenario.entryUrl = new URL(`${entry.pathname}${entry.search}${entry.hash}`, options.baseUrl).toString();
  }
  if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
  const browser = options.browser ?? await chromium.launch();
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
  let closing: Promise<void> | undefined;
  const abort = (): void => { if (context) closing ??= context.close().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error('CAPTURE_ABORTED');
    // Workers are default-deny. Opted-in traffic is routed at context level;
    // the recorder separately verifies the bounded transparent-proxy contract.
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
    return await new ScenarioRunner(await context.newPage(), { ...options, ...(patterns.length ? { webSocketSink: sink } : {}) }).run(scenario, runIndex);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { if (context) await (closing ?? context.close()); }
    finally { if (!options.browser) await browser.close(); }
  }
}
