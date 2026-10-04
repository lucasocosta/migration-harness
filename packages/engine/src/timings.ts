import { performance } from 'node:perf_hooks';
import type { ArtifactStore } from './artifacts.js';

/**
 * Phase instrumentation (F0): observation only.
 *
 * A `PhaseTimer` accumulates wall-clock spans for one operation (`prepare` or
 * `verify`) and is persisted as `timings.json` next to the operation report. Records
 * carry phase names, durations and declared ids/counts only — never trace content, evidence
 * values or private paths. Timing never influences decisions, statuses, diagnostics, exit codes
 * or the order of operations: every helper returns the callback's value or failure unchanged.
 */
export type TimingDetail = Record<string, string | number | boolean>;

export interface TimingPhase {
  name: string;
  ms: number;
  detail?: TimingDetail;
}

export interface OperationTimings {
  schemaVersion: '1';
  /** CLI-style operation name: `prepare` or `verify`. */
  operation: string;
  totalMs: number;
  phases: TimingPhase[];
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

export class PhaseTimer {
  private readonly phases: TimingPhase[] = [];
  private readonly startedAt = performance.now();

  private record(name: string, ms: number, detail?: TimingDetail): void {
    this.phases.push({ name, ms: round(ms), ...(detail && Object.keys(detail).length ? { detail } : {}) });
  }

  /** Time an awaited phase. The callback's resolved value or rejection is rethrown unchanged. */
  async phase<T>(name: string, run: () => T | Promise<T>, detail?: TimingDetail): Promise<T> {
    const started = performance.now();
    try { return await run(); }
    finally { this.record(name, performance.now() - started, detail); }
  }

  /** Time a synchronous phase without yielding to the event loop (byte-identical ordering). */
  phaseSync<T>(name: string, run: () => T, detail?: TimingDetail): T {
    const started = performance.now();
    try { return run(); }
    finally { this.record(name, performance.now() - started, detail); }
  }

  /**
   * Open a manual span for a block that cannot be wrapped in a callback. The returned ender
   * records once and ignores repeated calls, so a `finally` can safely call it too.
   */
  span(name: string, detail?: TimingDetail): () => void {
    const started = performance.now();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.record(name, performance.now() - started, detail);
    };
  }

  snapshot(operation: string): OperationTimings {
    return { schemaVersion: '1', operation, totalMs: round(performance.now() - this.startedAt), phases: [...this.phases] };
  }
}

/**
 * Persist `timings.json` in the operation's run artifact store. Pure observation: a failed or
 * refused write is swallowed so instrumentation can never change the operation outcome.
 */
export async function persistTimings(store: ArtifactStore, timer: PhaseTimer, operation: string): Promise<void> {
  try { await store.write('timings.json', timer.snapshot(operation)); }
  catch { /* observation only: the operation result stands, timing evidence is best-effort */ }
}
