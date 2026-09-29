import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, relative } from 'node:path';
import type { Page } from '@playwright/test';
import type { CompletionSignal, RawObservedTrace, ScenarioDefinition, ScenarioInteractionStep, WebSocketFrameDirection } from '@migration-harness/core';
import { parseScenario } from '@migration-harness/core';
import { TemporalTraceRecorder, type TraceRecorderOptions } from '@migration-harness/trace-recorder';
export * from './browser.js';
export * from './api.js';

type StorageSnapshot = { local: Record<string, string>; session: Record<string, string> };

export interface ScenarioRunnerOptions {
  /** Optional managed static build identity checked on the real application navigation, after storage seeding. */
  expectedBuild?: { origin: string; buildHash: string };
  fixtureBaseDir?: string;
  traceRecorder?: TraceRecorderOptions;
  allowedOrigins?: string[];
  locale?: string;
  viewport?: { width: number; height: number };
  /** Optional WebSocket frame sink attached while a run is recording; populated by the capture route for opted-in scenarios. */
  webSocketSink?: WebSocketFrameSink;
  /**
   * Opt-in visual checkpoints alongside ARIA (policy.visual.enabled). Screenshot bytes may be
   * retained only through `retainScreenshot`; the sanitized trace keeps hash + dimensions.
   */
  visualCapture?: boolean;
  retainScreenshot?: (bytes: Buffer) => Promise<void>;
}

export interface WebSocketFrameSink {
  handler?: ((direction: WebSocketFrameDirection, url: string, payload: string | Buffer, connectionId: string) => void) | undefined;
}

export class ScenarioExecutionError extends Error {
  constructor(readonly code: 'STEP_FAILED' | 'COMPLETION_FAILED' | 'BOOT_FAILED' | 'BUILD_IDENTITY_MISMATCH', readonly stepId?: string) {
    super(code === 'BUILD_IDENTITY_MISMATCH' ? 'SERVED_BUILD_MISMATCH' : code); this.name = 'ScenarioExecutionError';
  }
}

/** Resolve a mock fixture inside the allowed base; refuse escapes, symlinks out of root, and private stores. */
export async function resolveMockFixture(fixtureBaseDir: string, fixturePath: string): Promise<string> {
  const fixtureBase = await realpath(resolve(fixtureBaseDir));
  const resolved = await realpath(resolve(fixtureBase, fixturePath));
  const relativePath = relative(fixtureBase, resolved);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolved.split(/[\\/]/).includes('.migration-private')) throw new Error('Mock fixture escapes the allowed fixture directory.');
  return resolved;
}

export class ScenarioRunner {
  private used = false;
  private controller = new AbortController();
  private recorder: TemporalTraceRecorder | null = null;
  constructor(private readonly page: Page, private readonly options: ScenarioRunnerOptions = {}) {}

  async run(scenario: ScenarioDefinition, runIndex: number): Promise<RawObservedTrace> {
    scenario = parseScenario(scenario);
    if (scenario.steps.some(step => step.action === 'request')) throw new Error('Request steps are executed by the API capture driver, not the browser runner.');
    if (this.used) throw new Error('Use a fresh BrowserContext and ScenarioRunner for each run.');
    this.used = true;
    const recorder = this.recorder = new TemporalTraceRecorder(this.page, { ...this.options.traceRecorder, validateServiceWorkerProxy: scenario.serviceWorkers === 'allow' });
    if (this.options.webSocketSink) this.options.webSocketSink.handler = (direction, url, payload, connectionId) => recorder.recordWebSocketFrame(direction, url, payload, connectionId);
    await this.installPreconditions(scenario);
    recorder.start();
    const responseCompletion = scenario.completionSignal?.type === 'RESPONSE_RECEIVED' ? this.armCompletionSignal(scenario.completionSignal) : undefined;
    void responseCompletion?.catch(() => undefined);
    let activeStep: string | undefined;
    let stage: 'BOOT_FAILED' | 'STEP_FAILED' | 'COMPLETION_FAILED' = 'BOOT_FAILED';
    try {
      const navigation = await this.page.goto(scenario.entryUrl);
      if (this.options.expectedBuild && (!navigation || navigation.status() !== 200 || navigation.fromServiceWorker()
        || new URL(navigation.url()).origin !== this.options.expectedBuild.origin
        || navigation.headers()['x-migration-build'] !== this.options.expectedBuild.buildHash)) {
        throw new ScenarioExecutionError('BUILD_IDENTITY_MISMATCH');
      }
      let beforeStorage = await recorder.captureStorage();
      await recorder.captureAria('initial_mount');
      const captureVisual = async (triggerEventId: string): Promise<void> => {
        if (this.options.visualCapture !== true) return;
        await recorder.captureVisual(triggerEventId, this.options.retainScreenshot ? { retainBytes: this.options.retainScreenshot } : {});
      };
      await captureVisual('initial_mount');

      for (const step of scenario.steps) {
        stage = 'STEP_FAILED'; activeStep = step.stepId;
        await this.executeStep(step, recorder, scenario.captureStepCheckpoints);
        const afterStep = await recorder.captureStorage();
        recorder.recordStorageDeltas(beforeStorage, afterStep);
        beforeStorage = afterStep;
        if (scenario.captureStepCheckpoints === true) await captureVisual(step.stepId);
      }
      stage = 'COMPLETION_FAILED'; activeStep = undefined;
      if (responseCompletion) await responseCompletion;
      else if (scenario.completionSignal) await this.waitForCompletionSignal(scenario.completionSignal);

      const afterStorage = await recorder.captureStorage();
      recorder.recordStorageDeltas(beforeStorage, afterStorage);
      await recorder.captureAria('scenario_completed');
      await captureVisual('scenario_completed');
      return { ...await recorder.finish(scenario.scenarioId, runIndex), completion: { status: 'COMPLETED', completedStepIds: scenario.steps.map(step => step.stepId) } };
    } catch (error) {
      await recorder.abort();
      throw error instanceof ScenarioExecutionError || !this.options.expectedBuild ? error : new ScenarioExecutionError(stage, activeStep);
    } finally {
      this.controller.abort();
      if (this.options.webSocketSink) this.options.webSocketSink.handler = undefined;
      this.recorder = null;
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
      const responses = await Promise.all([mock, ...(mock.sequence ?? [])].map(async response => ({ ...response,
        fixture: await readFile(await resolveMockFixture(this.options.fixtureBaseDir ?? process.cwd(), response.fixturePath), 'utf8'),
      })));
      let responseIndex = 0;
      const origins = new Set(this.options.allowedOrigins ?? [new URL(scenario.entryUrl).origin]);
      const router = scenario.serviceWorkers === 'allow' ? this.page.context() : this.page;
      await router.route(mock.urlPattern, async (route) => {
        if (!origins.has(new URL(route.request().url()).origin)) { await route.abort('blockedbyclient'); return; }
        if (route.request().method().toUpperCase() !== mock.method.toUpperCase()) {
          await route.fallback();
          return;
        }
        const response = responses[Math.min(responseIndex++, responses.length - 1)]!;
        if (response.delayMs) await new Promise<void>(resolve => {
          const done = (): void => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, response.delayMs);
          this.controller.signal.addEventListener('abort', done, { once: true });
          if (this.controller.signal.aborted) done();
        });
        if (!this.controller.signal.aborted) await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.fixture });
      });
    }
  }

  private async executeStep(step: ScenarioInteractionStep, recorder: TemporalTraceRecorder, captureCheckpoint = false): Promise<void> {
    if (step.action === 'request') throw new Error('Request steps are executed by the API capture driver, not the browser runner.');
    const interaction = recorder.recordUserInteraction({
      stepId: step.stepId,
      action: step.action,
      ...(step.targetRole !== undefined ? { targetAriaRole: step.targetRole } : {}),
      ...(step.targetName !== undefined ? { targetAriaName: step.targetName } : {}),
      ...(step.inputValue !== undefined ? { inputValue: step.inputValue } : {}),
    });

    const signalPromise = step.completionSignal ? this.armCompletionSignal(step.completionSignal) : undefined;
    void signalPromise?.catch(() => undefined);
    const target = step.targetLabel !== undefined ? this.page.getByLabel(step.targetLabel, { exact: true })
      : this.page.getByRole(step.targetRole as never, step.targetName !== undefined ? { name: step.targetName } : {});

    switch (step.action) {
      case 'click': await target.click(); break;
      case 'fill': await target.fill(step.inputValue ?? ''); break;
      case 'select': await target.selectOption(step.inputValue ?? ''); break;
      case 'press': await target.press(step.inputValue ?? 'Enter'); break;
      case 'focus': await target.focus(); break;
      default: assertNever(step.action);
    }
    await signalPromise;
    if (captureCheckpoint) await recorder.captureAria(interaction.eventId);
  }

  private armCompletionSignal(signal: CompletionSignal): Promise<void> {
    switch (signal.type) {
      case 'LOCATOR_VISIBLE':
        return this.page.getByRole(signal.targetRole as never, signal.targetName !== undefined ? { name: signal.targetName } : {}).filter(signal.text !== undefined ? { hasText: signal.text } : {})
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
      case 'WEBSOCKET_FRAME': {
        const recorder = this.recorder;
        if (!recorder) throw new Error('WebSocket completion requires an active recorder.');
        return recorder.waitForWebSocketFrame({ urlPattern: signal.urlPattern, direction: signal.direction, payloadShape: signal.payloadShape, timeoutMs: signal.timeoutMs });
      }
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
