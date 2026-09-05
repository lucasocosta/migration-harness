import { chromium, type Browser } from '@playwright/test';
import { parseScenario, type RawObservedTrace, type ScenarioDefinition } from '@migration-harness/core';
import { ScenarioRunner, type ScenarioRunnerOptions } from './index.js';

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
  await context.routeWebSocket('**/*', socket => socket.close());
  try { return await new ScenarioRunner(await context.newPage(), options).run(scenario, runIndex); }
  finally { await context.close(); if (!options.browser) await browser.close(); }
}
