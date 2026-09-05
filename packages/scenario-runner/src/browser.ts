import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from '@playwright/test';
import { parseScenario, urlPatternMatches, type CompletionSignal, type RawObservedTrace, type ScenarioDefinition } from '@migration-harness/core';
import { ScenarioRunner, type ScenarioRunnerOptions, type WebSocketFrameSink } from './index.js';

type WebSocketCompletionSignal = Extract<CompletionSignal, { type: 'WEBSOCKET_FRAME' }>;
export function webSocketCompletionSignals(scenario: ScenarioDefinition): WebSocketCompletionSignal[] {
  return [scenario.completionSignal, ...scenario.steps.map(step => step.completionSignal)]
    .filter((signal): signal is WebSocketCompletionSignal => signal?.type === 'WEBSOCKET_FRAME');
}

export async function captureScenario(scenario: ScenarioDefinition, runIndex: number, options: ScenarioRunnerOptions & { browser?: Browser; baseUrl?: string; allowedOrigins?: string[] } = {}): Promise<RawObservedTrace> {
  scenario = parseScenario(structuredClone(scenario));
  if (options.baseUrl) {
    const entry = new URL(scenario.entryUrl);
    scenario.entryUrl = new URL(`${entry.pathname}${entry.search}${entry.hash}`, options.baseUrl).toString();
  }
  const browser = options.browser ?? await chromium.launch();
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 720 }, locale: options.locale ?? options.traceRecorder?.locale ?? 'pt-BR', serviceWorkers: 'block', acceptDownloads: false });
  context.setDefaultTimeout(10000);
  const origins = new Set(options.allowedOrigins ?? [new URL(scenario.entryUrl).origin]);
  await context.route('**/*', route => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
  // WebSockets stay blocked unless the scenario opts in through a WEBSOCKET_FRAME completion signal; opted-in connections are proxied to the real server and captured frame-by-frame.
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
  try { return await new ScenarioRunner(await context.newPage(), { ...options, ...(patterns.length ? { webSocketSink: sink } : {}) }).run(scenario, runIndex); }
  finally { await context.close(); if (!options.browser) await browser.close(); }
}
