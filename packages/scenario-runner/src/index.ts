import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { CompletionSignal, RawObservedTrace, ScenarioDefinition, ScenarioInteractionStep } from '@migration-harness/core';
import { TemporalTraceRecorder, type TraceRecorderOptions } from '@migration-harness/trace-recorder';

type StorageSnapshot = { local: Record<string, string>; session: Record<string, string> };

export interface ScenarioRunnerOptions {
  fixtureBaseDir?: string;
  traceRecorder?: TraceRecorderOptions;
}

export class ScenarioRunner {
  constructor(private readonly page: Page, private readonly options: ScenarioRunnerOptions = {}) {}

  async run(scenario: ScenarioDefinition, runIndex: number): Promise<RawObservedTrace> {
    const recorder = new TemporalTraceRecorder(this.page, this.options.traceRecorder);
    await this.installPreconditions(scenario);
    recorder.start();
    try {
      await this.page.goto(scenario.entryUrl);
      const beforeStorage = await recorder.captureStorage();
      await recorder.captureAria('initial_mount');

      for (const step of scenario.steps) await this.executeStep(step, recorder);
      if (scenario.completionSignal) await this.waitForCompletionSignal(scenario.completionSignal);

      const afterStorage = await recorder.captureStorage();
      recorder.recordStorageDeltas(beforeStorage, afterStorage);
      await recorder.captureAria('scenario_completed');
      return await recorder.finish(scenario.scenarioId, runIndex);
    } catch (error) {
      await recorder.abort();
      throw error;
    }
  }

  private async installPreconditions(scenario: ScenarioDefinition): Promise<void> {
    const storage = scenario.preconditions.storageInitialState;
    if (storage) {
      await this.page.addInitScript((initial: StorageSnapshot) => {
        for (const [key, value] of Object.entries(initial.local)) localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(initial.session)) sessionStorage.setItem(key, value);
      }, { local: storage.local ?? {}, session: storage.session ?? {} });
    }

    for (const mock of scenario.preconditions.mockInitialApiResponses ?? []) {
      await this.page.route(mock.urlPattern, async (route) => {
        if (route.request().method().toUpperCase() !== mock.method.toUpperCase()) {
          await route.continue();
          return;
        }
        const fixturePath = isAbsolute(mock.fixturePath)
          ? mock.fixturePath
          : resolve(this.options.fixtureBaseDir ?? process.cwd(), mock.fixturePath);
        const fixture = await readFile(fixturePath, 'utf8');
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
        { timeout: signal.timeoutMs }).then(() => undefined);
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
