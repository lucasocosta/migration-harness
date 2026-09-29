import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  canonical, canonicalize, MigrationIdSchema, MigrationPathSchema, migrationConfigHash, parseMigrationConfig,
  SourceObservationsSchema, type MigrationConfig, type MigrationPreparation, type ScenarioSide,
  type StateCapture, type StateProjection,
} from '@migration-harness/core';
import {
  verifySourceStability, type SourceStabilityInput, type SourceStabilityResult,
} from '@migration-harness/equivalence-validator';
import { safeArtifactPath, type ArtifactStore } from './artifacts.js';
import { assertNotPrivateWorkspace, pathSegments } from './platform-paths.js';
import { killTree, resolveExecutable } from './process-tree.js';

/** Both declared capture checkpoints: the suite phase decides when a capture runs, never the probe. */
export type StateCheckpoint = StateCapture['checkpoint']['kind'];
export type StateSettleStatus = 'SETTLED' | 'NO_BARRIER' | 'TIMED_OUT';
export type StateCompleteness = 'COMPLETE' | 'INCOMPLETE';
/**
 * Stable probe failure codes. A failed probe leaves a code and nothing else: stdout and stderr stay
 * inside this module, raw projections reach the envelope only after sanitization, and no message,
 * diagnostic, CLI or MCP payload ever carries probe bytes.
 */
export type StateCaptureReason =
  | 'PROBE_FAILED' | 'PROBE_TIMEOUT' | 'PROBE_OUTPUT_LIMIT' | 'PROBE_INVALID_OUTPUT'
  | 'PROBE_SPAWN_FAILED' | 'PROBE_ABORTED' | 'PROBE_SETTLE_TIMEOUT' | 'PROBE_SANITIZE_FAILED'
  | 'PROBE_WRITE_FAILED' | 'PROBE_UNAVAILABLE' | 'PROBE_DECLARATION_INVALID';

/** A malformed or unresolved state declaration: a configuration problem, never an observation. */
export class StateDeclarationError extends Error {
  constructor(message: string) { super(message); this.name = 'StateDeclarationError'; }
}

/** The declared probe command of one side; refuses anything that is not `kind: 'probe'`. */
export interface ProbeCommand { id: string; kind: 'probe'; argv: string[]; cwd: string; timeoutMs: number }

/**
 * Versioned evidence envelope, one per (run, scenario, side, checkpoint, captureId). Every identity
 * field, fingerprint and hash here is harness-assigned: probe output contributes the sanitized
 * `projection` and nothing else — never an identity, a hash or a verdict.
 */
export interface StateSnapshotEnvelope {
  kind: 'STATE_SNAPSHOT'; version: '1';
  captureId: string; checkpoint: StateCheckpoint; side: ScenarioSide;
  scenarioId: string; runId: string; runIndex: number;
  probe: { commandId: string; fingerprint: string };
  projectionId: string; projectionFingerprint: string;
  configurationHash: string; buildHash: string;
  settle: { status: StateSettleStatus };
  completeness: StateCompleteness;
  projection: unknown;
  evidenceHash: string;
}

export interface StateCaptureInput {
  config: unknown;
  workspaceRoot: string;
  side: ScenarioSide;
  scenarioId: string;
  captureId: string;
  /** The suite phase being executed; it must equal the capture's declared checkpoint. */
  checkpoint: StateCheckpoint;
  runIndex: number;
  /** Harness-assigned identity of the suite record this snapshot belongs to; never command-supplied. */
  runId: string;
  buildHash: string;
  /** Shared pseudonymization key of the prepared reference (migration-operations `referenceKey` seam). */
  pseudonymizationKey: string;
  configurationHash?: string;
  /** When present the envelope is persisted; the artifact-root-relative path comes back in the result. */
  store?: ArtifactStore;
  signal?: AbortSignal;
}

export interface StateCaptureResult {
  envelope: StateSnapshotEnvelope;
  /** Artifact-root-relative path of the persisted envelope; absent when persistence failed. */
  evidencePath?: string;
  /** Stable failure code; present exactly when the snapshot is INCOMPLETE. */
  reason?: StateCaptureReason;
}

const digestOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
/** One MiB of probe stdout; anything larger is an incomplete observation, never a truncated projection. */
const PROBE_OUTPUT_LIMIT = 1_048_576;
const MAX_SNAPSHOT_FILES = 10000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SNAPSHOT_KEYS = ['kind', 'version', 'captureId', 'checkpoint', 'side', 'scenarioId', 'runId', 'runIndex',
  'probe', 'projectionId', 'projectionFingerprint', 'configurationHash', 'buildHash', 'settle',
  'completeness', 'projection', 'evidenceHash'].sort();

/** Declared state captures of one scenario; absent vocabulary means none, never an assumption. */
export function stateCapturesOf(config: MigrationConfig, scenarioId: string): StateCapture[] {
  const scenario = config.scenarios.find(item => item.definition.scenarioId === scenarioId);
  if (!scenario) throw new StateDeclarationError(`Unknown scenario ${scenarioId}`);
  return [...(scenario.stateCaptures ?? [])];
}
/** Declared domain-state projections; each capture names exactly one through its `projectionId`. */
export function stateProjectionsOf(config: MigrationConfig): StateProjection[] {
  return [...(config.stateProjections ?? [])];
}
/** Bundle key of one capture's observations inside a source-stability run. */
export function stateEvidenceKey(capture: Pick<StateCapture, 'id' | 'checkpoint'>): string {
  return `${capture.id}@${capture.checkpoint.kind}`;
}
export function probeCommandFor(config: MigrationConfig, side: ScenarioSide, commandId: string): ProbeCommand {
  const command = config[side].commands.find(item => item.id === commandId);
  if (!command || command.kind !== 'probe') throw new StateDeclarationError(`State capture on ${side} must reference a probe command: ${commandId}`);
  return { id: command.id, kind: 'probe', argv: [...command.argv], cwd: command.cwd, timeoutMs: command.timeoutMs };
}
function projectionFor(config: MigrationConfig, capture: StateCapture): StateProjection {
  const projection = stateProjectionsOf(config).find(item => item.id === capture.projectionId);
  if (!projection) throw new StateDeclarationError(`State capture ${capture.id} references an unknown projection ${capture.projectionId}`);
  return projection;
}

const intOf = (value: unknown, what: string, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new StateDeclarationError(`${what} must be an integer >= ${minimum}`);
  }
  return value;
};
const segment = (value: string): string => {
  if (!MigrationIdSchema.safeParse(value).success) throw new StateDeclarationError('Invalid state evidence identifier');
  return value;
};

/**
 * JSON Pointer segments of a declared state path (RFC 6901 unescaping). `*` survives as a wildcard
 * segment for allowlist matching; privacy paths are validated by the configuration schema already,
 * this is the fail-closed runtime guard for callers that bypass it.
 */
function pointerSegments(path: unknown, what: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new StateDeclarationError(`${what} must be an absolute JSON Pointer`);
  return path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}
/** Barrier paths address one concrete node: a pointer when absolute, otherwise a root-level key. */
function markerSegments(path: unknown, what: string): string[] {
  if (typeof path !== 'string' || path === '') throw new StateDeclarationError(`${what} must be a non-empty path`);
  return path.startsWith('/') ? pointerSegments(path, what) : [path];
}
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function valueAt(root: unknown, segments: string[]): { found: boolean; value: unknown } {
  let node = root;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return { found: false, value: undefined };
      node = node[index];
    } else if (isPlainObject(node)) {
      // No wildcard resolution: a declared completion marker names one concrete location.
      if (!Object.hasOwn(node, segment)) return { found: false, value: undefined };
      node = node[segment];
    } else return { found: false, value: undefined };
  }
  return { found: true, value: node };
}

interface ProbeProcess { argv: string[]; cwd: string; timeoutMs: number }
type ProbeRun = { ok: true; stdout: string } | { ok: false; reason: StateCaptureReason };
type ProbeObservation = { ok: true; projection: unknown } | { ok: false; reason: StateCaptureReason };
interface BarrierOutcome { settle: StateSettleStatus; observation: ProbeObservation }

/** Same scrub as project checks: no credentials, NODE_OPTIONS or arbitrary application variables. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/**
 * Run one probe: argv only (never a shell), cwd under the side root, the declared `command.timeoutMs`,
 * stdout bounded to 1 MiB, stderr not piped at all. Raw bytes stay in this function's scope: on any
 * failure the buffered stdout is dropped before the result leaves the promise.
 */
async function runProbe(command: ProbeProcess, signal?: AbortSignal): Promise<ProbeRun> {
  if (signal?.aborted) return { ok: false, reason: 'PROBE_ABORTED' };
  const env = scrubbedEnv();
  let child: ChildProcessByStdio<null, Readable, null>;
  try {
    // Node 22+ refuses spawn() of .cmd shims without a shell, so route those through cmd.exe /c,
    // exactly like project checks; everything else is spawn(argv) with shell: false.
    const exe = resolveExecutable(command.argv[0]!);
    const viaCmd = process.platform === 'win32' && exe.toLowerCase().endsWith('.cmd');
    child = viaCmd
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', exe, ...command.argv.slice(1)],
        { cwd: command.cwd, env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn(exe, command.argv.slice(1),
        { cwd: command.cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { ok: false, reason: 'PROBE_SPAWN_FAILED' };
  }
  return new Promise<ProbeRun>(resolveResult => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let reason: StateCaptureReason | undefined;
    let exitCode: number | null = null;
    let finishing = false;
    let closeResolve: () => void = () => undefined;
    const closed = new Promise<void>(done => { closeResolve = done; });
    const killGroup = (signalName: NodeJS.Signals): void => {
      // The outcome reason already stands; a failed kill cannot change it.
      try { killTree(child, signalName); } catch { /* bounded best effort, as in project checks */ }
    };
    const finish = async (): Promise<void> => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      killGroup('SIGTERM');
      if (child.pid) { await delay(150); killGroup('SIGKILL'); }
      await Promise.race([closed, delay(500)]);
      child.stdout.destroy();
      const failure = reason ?? (exitCode === 0 ? undefined : 'PROBE_FAILED');
      if (failure) { chunks.length = 0; resolveResult({ ok: false, reason: failure }); return; }
      resolveResult({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') });
    };
    const abort = (): void => { reason ??= 'PROBE_ABORTED'; void finish(); };
    const timer = setTimeout(() => { reason ??= 'PROBE_TIMEOUT'; void finish(); }, command.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > PROBE_OUTPUT_LIMIT) { reason ??= 'PROBE_OUTPUT_LIMIT'; void finish(); return; }
      chunks.push(chunk);
    });
    child.once('error', () => { reason ??= 'PROBE_SPAWN_FAILED'; void finish(); });
    child.once('exit', (code: number | null) => { exitCode = code; void finish(); });
    child.once('close', () => closeResolve());
    if (signal?.aborted) abort();
  });
}

/**
 * Parse probe stdout as the projection root. The parse error is deliberately discarded: V8 quotes the
 * offending input, and a probe's bytes must never reach a message, diagnostic or report.
 */
function parseProjection(stdout: string): ProbeObservation {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return { ok: false, reason: 'PROBE_INVALID_OUTPUT' }; }
  if (value === null || typeof value !== 'object') return { ok: false, reason: 'PROBE_INVALID_OUTPUT' };
  return { ok: true, projection: value };
}

async function observeOnce(command: ProbeProcess, signal?: AbortSignal): Promise<BarrierOutcome> {
  const run = await runProbe(command, signal);
  return { settle: 'NO_BARRIER', observation: run.ok ? parseProjection(run.stdout) : run };
}

/**
 * Poll the probe until the declared completion marker appears, within the declared bounds
 * (`maxAttempts` probe invocations, `timeoutMs` wall clock, `pollIntervalMs` between attempts).
 * The marker is a declared "finished" signal, never the expected result: the projection it sits on is
 * never judged here, only matched against the configured completion value.
 */
async function pollBarrier(command: ProbeProcess, settle: NonNullable<StateCapture['settle']>, signal?: AbortSignal): Promise<BarrierOutcome> {
  const deadline = Date.now() + settle.timeoutMs;
  const marker = markerSegments(settle.completedPath, 'settle.completedPath');
  let attempts = 0;
  let sawProjection = false;
  let last: ProbeObservation | undefined;
  while (attempts < settle.maxAttempts && Date.now() < deadline && !signal?.aborted) {
    attempts++;
    const run = await runProbe(command, signal);
    if (!run.ok) {
      last = run;
      // A probe failure does not settle the barrier; the declared bounds still decide the outcome.
      if (run.reason === 'PROBE_ABORTED') break;
      continue;
    }
    const parsed = parseProjection(run.stdout);
    if (!parsed.ok) { last = parsed; continue; }
    sawProjection = true;
    const at = valueAt(parsed.projection, marker);
    if (at.found && canonical(at.value) === canonical(settle.completedValue)) return { settle: 'SETTLED', observation: parsed };
    last = parsed;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || attempts >= settle.maxAttempts) break;
    await delay(Math.min(settle.pollIntervalMs, remaining));
  }
  if (signal?.aborted) return { settle: 'TIMED_OUT', observation: { ok: false, reason: 'PROBE_ABORTED' } };
  const failure: StateCaptureReason = sawProjection || !last || last.ok ? 'PROBE_SETTLE_TIMEOUT' : last.reason;
  return { settle: 'TIMED_OUT', observation: { ok: false, reason: failure } };
}

/** A pattern keeps a node when it is on the way to, or inside, an allowed path (`*` spans one segment). */
function related(pattern: string[], path: string[]): boolean {
  const length = Math.min(pattern.length, path.length);
  for (let index = 0; index < length; index++) if (pattern[index] !== '*' && pattern[index] !== path[index]) return false;
  return true;
}
const DROP = Symbol('state-drop');

/**
 * Keep only what `privacy.allowedPaths` matches: undeclared keys and values are dropped together
 * (keys can be PII just as values can), so the projection that leaves this module is minimized first.
 */
function filterNode(node: unknown, path: string[], allowed: string[][]): unknown {
  if (!allowed.some(pattern => related(pattern, path))) return DROP;
  if (Array.isArray(node)) {
    const items: unknown[] = [];
    for (let index = 0; index < node.length; index++) {
      const child = filterNode(node[index], [...path, String(index)], allowed);
      if (child !== DROP) items.push(child);
    }
    return items;
  }
  if (isPlainObject(node)) {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node)) {
      const child = filterNode(value, [...path, name], allowed);
      if (child !== DROP) kept[name] = child;
    }
    return kept;
  }
  return node;
}

type StateField = NonNullable<StateProjection['privacy']['fields']>[number];

/**
 * The stored representation of a KEYED_EQUALITY field value: `typeof`-tagged HMAC-SHA256 under the shared
 * harness key. Exported so the evaluation seam can key declared literals the very same way inside
 * protected processing — never a bare hash of the value.
 */
export function keyedStateValue(value: unknown, domain: string, key: string): string {
  const digest = createHmac('sha256', key).update(`state:${domain}:${canonical(value)}`).digest('hex');
  return `${typeof value}:${digest}`;
}

function fieldValue(field: StateField, value: unknown, key: string): unknown {
  if (field.representation === 'STRUCTURAL') return { type: typeof value }; // literal JavaScript typeof
  return keyedStateValue(value, field.domain ?? field.path, key);
}

interface FieldPattern { field: StateField; segments: string[] }

function applyFields(node: unknown, path: string[], fields: FieldPattern[], key: string): unknown {
  const match = fields.find(candidate => candidate.segments.length === path.length
    && candidate.segments.every((part, index) => part === '*' || part === path[index]));
  if (match) return fieldValue(match.field, node, key);
  if (Array.isArray(node)) return node.map((child, index) => applyFields(child, [...path, String(index)], fields, key));
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node)) out[name] = applyFields(value, [...path, name], fields, key);
    return out;
  }
  return node;
}

/** Allowlist first, then the declared per-field representations, then canonical key order. */
function sanitizeProjection(raw: unknown, privacy: StateProjection['privacy'], key: string): unknown {
  const allowed = privacy.allowedPaths.map(path => pointerSegments(path, 'privacy.allowedPaths'));
  if (!allowed.length) throw new StateDeclarationError('privacy.allowedPaths must declare at least one path');
  const filtered = filterNode(raw, [], allowed);
  if (filtered === DROP) throw new StateDeclarationError('privacy.allowedPaths rejected the projection root');
  const fields: FieldPattern[] = (privacy.fields ?? []).map(field => ({ field, segments: pointerSegments(field.path, 'privacy.fields') }));
  return canonicalize(fields.length ? applyFields(filtered, [], fields, key) : filtered);
}

/**
 * Run one declared state capture and (when a store is supplied) persist its STATE_SNAPSHOT envelope
 * alongside the traces of the same run. Probe failures, unparsable or oversized output, settle
 * timeouts, sanitization failures and persistence failures all come back as an INCOMPLETE envelope
 * carrying `projection: null` and a stable `reason` — this function reports observations, never
 * verdicts, and never throws for anything the probe did.
 */
export async function captureStateSnapshot(input: StateCaptureInput): Promise<StateCaptureResult> {
  const config = parseMigrationConfig(input.config);
  if (input.side !== 'source' && input.side !== 'target') throw new StateDeclarationError('Invalid state capture side');
  const scenario = config.scenarios.find(item => item.definition.scenarioId === input.scenarioId);
  if (!scenario) throw new StateDeclarationError(`Unknown scenario ${input.scenarioId}`);
  const capture = stateCapturesOf(config, input.scenarioId).find(item => item.id === input.captureId);
  if (!capture) throw new StateDeclarationError(`Unknown state capture ${input.captureId}`);
  if (capture.checkpoint.kind !== input.checkpoint) {
    throw new StateDeclarationError(`State capture ${input.captureId} belongs to checkpoint ${capture.checkpoint.kind}`);
  }
  const runIndex = intOf(input.runIndex, 'runIndex', 0);
  if (runIndex > 9999) throw new StateDeclarationError('runIndex exceeds the evidence bound');
  if (typeof input.runId !== 'string' || !UUID.test(input.runId)) throw new StateDeclarationError('runId must be a harness-assigned UUID');
  if (typeof input.buildHash !== 'string' || !HASH.test(input.buildHash)) throw new StateDeclarationError('buildHash must be a sha256 digest');
  if (typeof input.pseudonymizationKey !== 'string' || input.pseudonymizationKey.length < 32) throw new Error('INVALID_PSEUDONYMIZATION_KEY');
  const projection = projectionFor(config, capture);
  const command = probeCommandFor(config, input.side, capture.bindings[input.side].commandId);
  const cwdKey = `${config[input.side].root}${command.cwd === '.' ? '' : `/${command.cwd}`}`;
  const probe = { commandId: command.id, fingerprint: digestOf({ argv: command.argv, cwd: cwdKey }) };
  const configurationHash = input.configurationHash ?? migrationConfigHash(config);
  const projectionFingerprint = digestOf({ privacy: projection.privacy, comparison: projection.comparison });
  const evidencePath = `artifacts/units/${segment(scenario.definition.unitId)}/${segment(input.scenarioId)}`
    + `/${input.side}/state/${runIndex}.${segment(input.captureId)}.${input.checkpoint}.state.json`;

  const workspace = await realpath(resolve(input.workspaceRoot))
    .then(path => { assertNotPrivateWorkspace(path); return path; }, () => undefined);
  const cwd = workspace === undefined ? undefined : await probeCwd(workspace, config, input.side, command).catch(() => undefined);

  let completeness: StateCompleteness = 'INCOMPLETE';
  let reason: StateCaptureReason | undefined;
  let sanitized: unknown = null;
  // No declared barrier: the capture records NO_BARRIER, disclosing the synchronous-commit assumption
  // instead of implying the probe waited for anything.
  let settleStatus: StateSettleStatus = 'NO_BARRIER';

  if (cwd === undefined) reason = 'PROBE_UNAVAILABLE';
  else if (input.signal?.aborted) reason = 'PROBE_ABORTED';
  else {
    const probeProcess: ProbeProcess = { argv: command.argv, cwd, timeoutMs: command.timeoutMs };
    const observed = capture.settle
      ? await pollBarrier(probeProcess, capture.settle, input.signal)
      : await observeOnce(probeProcess, input.signal);
    settleStatus = observed.settle;
    if (!observed.observation.ok) reason = observed.observation.reason;
    else {
      try {
        sanitized = sanitizeProjection(observed.observation.projection, projection.privacy, input.pseudonymizationKey);
        completeness = 'COMPLETE';
      } catch { sanitized = null; reason = 'PROBE_SANITIZE_FAILED'; }
    }
  }

  let evidencePathResult: string | undefined;
  const build = (): StateSnapshotEnvelope => {
    const body = {
      kind: 'STATE_SNAPSHOT' as const, version: '1' as const,
      captureId: input.captureId, checkpoint: input.checkpoint, side: input.side,
      scenarioId: input.scenarioId, runId: input.runId, runIndex,
      probe, projectionId: projection.id, projectionFingerprint, configurationHash, buildHash: input.buildHash,
      settle: { status: settleStatus }, completeness, projection: sanitized,
    };
    return { ...body, evidenceHash: digestOf(body) };
  };
  let envelope = build();
  if (input.store) {
    try {
      await input.store.write(evidencePath, envelope);
      evidencePathResult = evidencePath;
    } catch {
      // An observation without a persisted artifact is not evidence.
      if (completeness === 'COMPLETE') {
        completeness = 'INCOMPLETE'; sanitized = null; reason = 'PROBE_WRITE_FAILED';
        envelope = build();
      }
    }
  }
  return { envelope, ...(evidencePathResult ? { evidencePath: evidencePathResult } : {}), ...(reason ? { reason } : {}) };
}

/** The side's root plus the command's declared cwd, resolved with the same guards as project checks. */
async function probeCwd(workspace: string, config: MigrationConfig, side: ScenarioSide, command: ProbeCommand): Promise<string> {
  let current = workspace;
  const path = `${config[side].root}${command.cwd === '.' ? '' : `/${command.cwd}`}`;
  for (const part of pathSegments(path)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateDeclarationError('Probe cwd must be a real project directory');
  }
  return current;
}

/** Validate one envelope read back from evidence: exact fields, enums, hashes and its own integrity. */
export function parseStateSnapshot(value: unknown): StateSnapshotEnvelope {
  const object = ((): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StateDeclarationError('STATE_SNAPSHOT evidence must be an object');
    return value as Record<string, unknown>;
  })();
  const fail = (what: string): never => { throw new Error(`Invalid STATE_SNAPSHOT evidence (${what})`); };
  const keys = Object.keys(object).sort();
  if (keys.length !== SNAPSHOT_KEYS.length || keys.some((key, index) => key !== SNAPSHOT_KEYS[index])) fail('fields');
  if (object.kind !== 'STATE_SNAPSHOT') fail('kind');
  if (object.version !== '1') fail('version');
  if (!MigrationIdSchema.safeParse(object.captureId).success) fail('captureId');
  if (object.checkpoint !== 'AFTER_RESET' && object.checkpoint !== 'SCENARIO_END') fail('checkpoint');
  if (object.side !== 'source' && object.side !== 'target') fail('side');
  if (!MigrationIdSchema.safeParse(object.scenarioId).success) fail('scenarioId');
  if (typeof object.runId !== 'string' || !UUID.test(object.runId)) fail('runId');
  if (typeof object.runIndex !== 'number' || !Number.isSafeInteger(object.runIndex) || object.runIndex < 0) fail('runIndex');
  const probe = object.probe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) fail('probe');
  const commandId = (probe as Record<string, unknown>).commandId, fingerprint = (probe as Record<string, unknown>).fingerprint;
  if (!MigrationIdSchema.safeParse(commandId).success) fail('probe.commandId');
  if (typeof fingerprint !== 'string' || !HASH.test(fingerprint)) fail('probe.fingerprint');
  if (!MigrationIdSchema.safeParse(object.projectionId).success) fail('projectionId');
  if (typeof object.projectionFingerprint !== 'string' || !HASH.test(object.projectionFingerprint)) fail('projectionFingerprint');
  if (typeof object.configurationHash !== 'string' || !HASH.test(object.configurationHash)) fail('configurationHash');
  if (typeof object.buildHash !== 'string' || !HASH.test(object.buildHash)) fail('buildHash');
  const settle = object.settle;
  if (!settle || typeof settle !== 'object' || Array.isArray(settle)) fail('settle');
  const status = (settle as Record<string, unknown>).status;
  if (status !== 'SETTLED' && status !== 'NO_BARRIER' && status !== 'TIMED_OUT') fail('settle.status');
  if (object.completeness !== 'COMPLETE' && object.completeness !== 'INCOMPLETE') fail('completeness');
  // Fail closed: an incomplete observation carries no partial projection.
  if (object.completeness === 'INCOMPLETE' && object.projection !== null) fail('projection');
  if (typeof object.evidenceHash !== 'string' || !HASH.test(object.evidenceHash)) fail('evidenceHash');
  const { evidenceHash, ...body } = object;
  if (digestOf(body) !== evidenceHash) fail('evidenceHash mismatch');
  return value as unknown as StateSnapshotEnvelope;
}

async function parseSnapshotFile(target: string): Promise<StateSnapshotEnvelope> {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SNAPSHOT_BYTES) throw new Error('State snapshot evidence is unavailable.');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(target, 'utf8')); } catch { throw new Error('State snapshot evidence is not valid JSON.'); }
  return parseStateSnapshot(parsed);
}

/**
 * Read one persisted STATE_SNAPSHOT by its artifact-root-relative path (symlink-free, size-bounded,
 * integrity-checked through `parseStateSnapshot`). This is how verification re-reads both the pinned
 * prepared evidence and the freshly captured evidence before comparing them.
 */
export async function readStateSnapshot(root: string, path: string): Promise<StateSnapshotEnvelope> {
  const target = await safeArtifactPath(root, MigrationPathSchema.parse(path));
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SNAPSHOT_BYTES) throw new Error('State snapshot evidence is unavailable.');
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = await file.read(buffer, used, buffer.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used !== stat.size) throw new Error('State snapshot evidence changed while reading.');
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.subarray(0, used).toString('utf8')); } catch { throw new Error('State snapshot evidence is not valid JSON.'); }
    return parseStateSnapshot(parsed);
  } finally { await file.close(); }
}

/**
 * Read every persisted STATE_SNAPSHOT under a capture artifact root (`<root>/artifacts/units/...`).
 * This is the reader other lanes consume; it refuses symlinks, oversized files and envelopes whose
 * integrity does not check out, so a consumer never sees unvalidated state evidence.
 */
export async function readStateSnapshots(root: string): Promise<StateSnapshotEnvelope[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('State evidence must not contain symlinks.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.state.json')) {
        files.push(path);
        if (files.length > MAX_SNAPSHOT_FILES) throw new Error('State evidence exceeds the file cap.');
      }
    }
  };
  await walk(join(root, 'artifacts', 'units'));
  const snapshots: StateSnapshotEnvelope[] = [];
  for (const path of files.sort()) snapshots.push(await parseSnapshotFile(path));
  return snapshots;
}

/** Fresh state evidence of one source run as recorded by the capture suite (structural on purpose). */
export interface FreshStateEvidence {
  captureId: string; checkpoint: StateCheckpoint; completeness: StateCompleteness;
  evidencePath?: string; evidenceHash?: string; projectionFingerprint?: string;
}
/** One STATE_SNAPSHOT identity exactly as pinned inside `MigrationPreparation.sourceEvidence[].state`. */
export type PinnedStateEvidence = NonNullable<MigrationPreparation['sourceEvidence'][number]['state']>[number];
export interface StateEvidencePins { pins: PinnedStateEvidence[]; incomplete: boolean }

/**
 * Build the pins a preparation records for one source capture record. Entries without a persisted
 * envelope (or with INCOMPLETE completeness) cannot become evidence: they are dropped from the pins
 * and reported through `incomplete`, which fails the preparation closed.
 * `path` mirrors the trace entries: relative to the preparation artifact root, under `capture/`.
 */
export function stateEvidencePins(entries?: readonly FreshStateEvidence[]): StateEvidencePins {
  if (!entries?.length) return { pins: [], incomplete: false };
  const pins: PinnedStateEvidence[] = [];
  let incomplete = false;
  for (const entry of entries) {
    if (entry.completeness !== 'COMPLETE' || !entry.evidenceHash || !entry.projectionFingerprint || !entry.evidencePath) {
      incomplete = true;
      continue;
    }
    pins.push({ captureId: entry.captureId, checkpoint: entry.checkpoint, evidenceHash: entry.evidenceHash,
      projectionFingerprint: entry.projectionFingerprint, completeness: entry.completeness,
      path: `capture/${entry.evidencePath}` });
  }
  return { pins, incomplete };
}

export interface StateEvidenceCheck {
  /** Pinned and fresh state disagree (or a declared capture has never been pinned): source state is stale. */
  stale: boolean;
  /** Fresh state evidence is missing, unreadable or INCOMPLETE: the scenario must never end PASS. */
  incomplete: boolean;
}

/**
 * Verify-time re-check of source STATE_SNAPSHOT evidence, mirroring the trace revalidation: every
 * declared capture of every source run must have a COMPLETE fresh snapshot whose identity matches its
 * record, and its sanitized projection must equal the pinned prepared projection byte for byte.
 * Comparison uses the `projection` only — envelope run ids differ between independent captures by
 * design, so equality is over what the source actually produced.
 */
export async function compareSourceStateEvidence(input: {
  config: unknown;
  scenarioId: string;
  /** Original snapshots re-read from the prepared artifact and identity-validated against the pins. */
  pinned: readonly { runIndex: number; envelope: StateSnapshotEnvelope }[];
  /** Fresh source records of this scenario from the current suite. */
  freshRecords: readonly { runIndex: number; state?: FreshStateEvidence[] }[];
  /** Root of the fresh capture artifact (the directory holding `artifacts/units/...`). */
  captureRoot: string;
}): Promise<StateEvidenceCheck> {
  const config = parseMigrationConfig(input.config);
  const check: StateEvidenceCheck = { stale: false, incomplete: false };
  for (const capture of stateCapturesOf(config, input.scenarioId)) {
    for (let runIndex = 0; runIndex < config.limits.sourceRuns; runIndex++) {
      const fresh = input.freshRecords.find(record => record.runIndex === runIndex)?.state
        ?.find(entry => entry.captureId === capture.id && entry.checkpoint === capture.checkpoint.kind);
      if (!fresh || fresh.completeness !== 'COMPLETE' || !fresh.evidencePath || !fresh.evidenceHash || !fresh.projectionFingerprint) {
        check.incomplete = true;
        continue;
      }
      let envelope: StateSnapshotEnvelope;
      try { envelope = await readStateSnapshot(input.captureRoot, fresh.evidencePath); }
      catch { check.incomplete = true; continue; }
      if (envelope.side !== 'source' || envelope.scenarioId !== input.scenarioId || envelope.runIndex !== runIndex
        || envelope.captureId !== capture.id || envelope.checkpoint !== capture.checkpoint.kind
        || envelope.completeness !== 'COMPLETE' || envelope.evidenceHash !== fresh.evidenceHash
        || envelope.projectionFingerprint !== fresh.projectionFingerprint) { check.incomplete = true; continue; }
      const original = input.pinned.find(item => item.runIndex === runIndex && item.envelope.captureId === capture.id
        && item.envelope.checkpoint === capture.checkpoint.kind);
      if (!original) { check.stale = true; continue; }
      if (original.envelope.completeness !== 'COMPLETE'
        || original.envelope.projectionFingerprint !== envelope.projectionFingerprint
        || canonical(original.envelope.projection) !== canonical(envelope.projection)) check.stale = true;
    }
  }
  return check;
}

export interface StateSourceStabilityInput extends SourceStabilityInput {
  /** Declared captures of the scenario; empty means the configuration declares no state vocabulary. */
  captures: readonly StateCapture[];
  /** Sanitized projections per observed source run, aligned with `runs` (`stateEvidenceKey` → projection). */
  stateRuns: Array<Record<string, unknown> | undefined>;
}

/**
 * Source stability with declared state evidence folded in, because `verifySourceStability` only sees
 * traces. Fail-closed rules for required captures: no snapshot → NOT_COLLECTED, an INCOMPLETE snapshot
 * → UNSTABLE, and projections that differ between independent runs → UNSTABLE, exactly like a trace
 * divergence. Optional captures join the comparison when they produced a COMPLETE projection and are
 * otherwise advisory (their record entry still discloses the outcome). The per-run execution hash is
 * recomputed over the trace hash plus the sanitized projections only — envelope identity, run ids and
 * timing never participate, so identical state keeps the hash equal and a state change moves it.
 */
export function verifyStateSourceStability(input: StateSourceStabilityInput): SourceStabilityResult {
  const base = verifySourceStability({ runs: input.runs, requiredRuns: input.requiredRuns, reset: input.reset,
    ...(input.policy ? { policy: input.policy } : {}) });
  if (!input.captures.length) return base;
  const bundles = input.runs.map((_, index): Record<string, unknown> => input.stateRuns[index] ?? {});
  const declared = input.captures.map(stateEvidenceKey);
  const required = input.captures.filter(capture => capture.required).map(stateEvidenceKey);
  const unstableCodes = new Set(base.unstableCodes);
  const reviewPaths = new Set(base.reviewPaths);
  const missing = required.filter(key => bundles.some(bundle => !(key in bundle)));
  const incomplete = required.filter(key => bundles.some(bundle => bundle[key] === null));
  const diverged = declared.filter(key => {
    const values = bundles.map(bundle => bundle[key]).filter(value => value !== undefined && value !== null);
    return values.length > 1 && new Set(values.map(canonical)).size > 1;
  });
  for (const [code, keys] of [['STATE_EVIDENCE_MISSING', missing], ['STATE_EVIDENCE_INCOMPLETE', incomplete],
    ['STATE_PROJECTION_DIVERGED', diverged]] as const) {
    if (keys.length) { unstableCodes.add(code); for (const key of keys) reviewPaths.add(key); }
  }
  let status = base.observations.status;
  if (missing.length) status = 'NOT_COLLECTED';
  else if ((incomplete.length || diverged.length) && status === 'STABLE') status = 'UNSTABLE';
  const observations = status === 'NOT_COLLECTED'
    ? SourceObservationsSchema.parse({ status: 'NOT_COLLECTED', runs: 0 })
    : SourceObservationsSchema.parse({ status, runs: base.observations.runs,
        executionHashes: (base.observations.status === 'NOT_COLLECTED' ? [] : base.observations.executionHashes)
          .map((execution, index) => digestOf({ execution, state: input.stateRuns[index] ?? null })) });
  return { ...base, observations, unstableCodes: [...unstableCodes].sort(), reviewPaths: [...reviewPaths].sort() };
}
