import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, relative } from 'node:path';
import type { Page } from '@playwright/test';
import type { CompletionSignal, RawObservedTrace, ScenarioDefinition, ScenarioInteractionStep } from '@migration-harness/core';
import { parseScenario } from '@migration-harness/core';
import { TemporalTraceRecorder, type TraceRecorderOptions } from '@migration-harness/trace-recorder';
export * from './browser.js';

type StorageSnapshot = { local: Record<string, string>; session: Record<string, string> };

export interface ScenarioRunnerOptions {
  fixtureBaseDir?: string;
  traceRecorder?: TraceRecorderOptions;
  allowedOrigins?: string[];
  locale?: string;
  viewport?: { width: number; height: number };
}

export class ScenarioRunner {
  private used = false;
  private controller = new AbortController();
  constructor(private readonly page: Page, private readonly options: ScenarioRunnerOptions = {}) {}

  async run(scenario: ScenarioDefinition, runIndex: number): Promise<RawObservedTrace> {
    scenario = parseScenario(scenario);
    if (this.used) throw new Error('Use a fresh BrowserContext and ScenarioRunner for each run.');
    this.used = true;
    const recorder = new TemporalTraceRecorder(this.page, this.options.traceRecorder);
    await this.installPreconditions(scenario);
    recorder.start();
    const responseCompletion = scenario.completionSignal?.type === 'RESPONSE_RECEIVED' ? this.armCompletionSignal(scenario.completionSignal) : undefined;
    void responseCompletion?.catch(() => undefined);
    try {
      await this.page.goto(scenario.entryUrl);
      let beforeStorage = await recorder.captureStorage();
      await recorder.captureAria('initial_mount');

      for (const step of scenario.steps) {
        await this.executeStep(step, recorder);
        const afterStep = await recorder.captureStorage();
        recorder.recordStorageDeltas(beforeStorage, afterStep);
        beforeStorage = afterStep;
      }
      if (responseCompletion) await responseCompletion;
      else if (scenario.completionSignal) await this.waitForCompletionSignal(scenario.completionSignal);

      const afterStorage = await recorder.captureStorage();
      recorder.recordStorageDeltas(beforeStorage, afterStorage);
      await recorder.captureAria('scenario_completed');
      return { ...await recorder.finish(scenario.scenarioId, runIndex), completion: { status: 'COMPLETED', completedStepIds: scenario.steps.map(step => step.stepId) } };
    } catch (error) {
      await recorder.abort();
      throw error;
    } finally {
      this.controller.abort();
    }
  }

  private async installPreconditions(scenario: ScenarioDefinition): Promise<void> {
    const storage = scenario.preconditions.storageInitialState;
    if (storage) {
      // Seed the origin once without executing application code or resetting later navigations.
      await this.page.route(scenario.entryUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }), { times: 1 });
      await this.page.goto(scenario.entryUrl);
      await this.page.evaluate((initial: StorageSnapshot) => {
        for (const [key, value] of Object.entries(initial.local)) localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(initial.session)) sessionStorage.setItem(key, value);
      }, { local: storage.local ?? {}, session: storage.session ?? {} });
    }

    for (const mock of scenario.preconditions.mockInitialApiResponses ?? []) {
      const fixtureBase = await realpath(resolve(this.options.fixtureBaseDir ?? process.cwd()));
      const fixturePath = await realpath(resolve(fixtureBase, mock.fixturePath));
      const fixtureRelative = relative(fixtureBase, fixturePath);
      if (isAbsolute(fixtureRelative) || fixtureRelative === '..' || fixtureRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || fixturePath.split(/[\\/]/).includes('.migration-private')) throw new Error('Mock fixture escapes the allowed fixture directory.');
      const fixture = await readFile(fixturePath, 'utf8');
      const origins = new Set(this.options.allowedOrigins ?? [new URL(scenario.entryUrl).origin]);
      await this.page.route(mock.urlPattern, async (route) => {
        if (!origins.has(new URL(route.request().url()).origin)) { await route.abort('blockedbyclient'); return; }
        if (route.request().method().toUpperCase() !== mock.method.toUpperCase()) {
          await route.fallback();
          return;
        }
        await route.fulfill({ status: mock.statusCode, contentType: 'application/json', body: fixture });
      });
    }
  }

  private async executeStep(step: ScenarioInteractionStep, recorder: TemporalTraceRecorder): Promise<void> {
    recorder.recordUserInteraction({
      stepId: step.stepId,
      action: step.action,
      targetAriaRole: step.targetRole,
      ...(step.targetName !== undefined ? { targetAriaName: step.targetName } : {}),
      ...(step.inputValue !== undefined ? { inputValue: step.inputValue } : {}),
    });

    const signalPromise = step.completionSignal ? this.armCompletionSignal(step.completionSignal) : undefined;
    void signalPromise?.catch(() => undefined);
    const target = this.page.getByRole(step.targetRole as never, step.targetName !== undefined ? { name: step.targetName } : {});

    switch (step.action) {
      case 'click': await target.click(); break;
      case 'fill': await target.fill(step.inputValue ?? ''); break;
      case 'select': await target.selectOption(step.inputValue ?? ''); break;
      case 'press': await target.press(step.inputValue ?? 'Enter'); break;
      case 'focus': await target.focus(); break;
      default: assertNever(step.action);
    }
    await signalPromise;
  }

  private armCompletionSignal(signal: CompletionSignal): Promise<void> {
    switch (signal.type) {
      case 'LOCATOR_VISIBLE':
        return this.page.getByRole(signal.targetRole as never, signal.targetName !== undefined ? { name: signal.targetName } : {})
          .waitFor({ state: 'visible', timeout: signal.timeoutMs });
      case 'RESPONSE_RECEIVED':
        return this.page.waitForResponse((response) =>
          response.url().includes(signal.responseUrlPattern) &&
          response.request().method().toUpperCase() === signal.responseMethod.toUpperCase(),
        { timeout: signal.timeoutMs, signal: this.controller.signal }).then(() => undefined);
      case 'STORAGE_KEY_SET':
        return this.page.waitForFunction(({ storageType, storageKey }) => {
          const store = storageType === 'localStorage' ? localStorage : sessionStorage;
          return store.getItem(storageKey) !== null;
        }, { storageType: signal.storageType, storageKey: signal.storageKey }, { timeout: signal.timeoutMs }).then(() => undefined);
      default:
        return assertNever(signal);
    }
  }

  private async waitForCompletionSignal(signal: CompletionSignal): Promise<void> {
    await this.armCompletionSignal(signal);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
