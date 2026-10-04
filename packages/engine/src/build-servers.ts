import { createServer, get, type ClientRequest, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  canonical, parseMigrationConfig, parseProjectCheckReport, MigrationIdSchema, MigrationPathSchema, ServedBuildIdentitySchema,
  isWithin, pathSegments, type MigrationConfig, type ProjectCheckReport, type ServedBuildIdentity,
} from '@migration-harness/core';
import { preflightProjectChecks } from './project-checks.js';
import { killTree, resolveExecutable } from './process-tree.js';
import { PhaseTimer, type TimingDetail } from './timings.js';
import {
  invalidateBuildCacheEntry, planBuildCacheSide, publishBuildCacheSide, restoreBuildCache, runProjectChecksWithCache,
  type BuildCacheSidePlan, type BuildCacheSideReport,
} from './build-cache.js';

const HEALTH = '/__migration_harness_health__';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 3_600_000;
const READY_POLL_INTERVAL_MS = 100;
const READY_ATTEMPT_TIMEOUT_MS = 1000;
const SERVE_KILL_GRACE_MS = 500;
type Side = 'source' | 'target';
type Command = MigrationConfig['source']['commands'][number];
type BuildErrorCode = 'SERVING_CONFIG_MISSING' | 'UNSAFE_BUILD_DIRECTORY' | 'PORT_IN_USE' | 'SERVER_START_FAILED'
  | 'SERVE_CONFIG_INVALID' | 'SERVE_COMMAND_INVALID' | 'SERVER_READY_TIMEOUT' | 'SERVER_EXITED_EARLY'
  | 'BUILD_CHECK_FAILED' | 'BUILD_OUTPUT_MISSING' | 'BUILD_OUTPUT_UNSAFE' | 'BUILD_OUTPUT_TOO_LARGE'
  | 'BUILD_INPUT_CHANGED' | 'BUILD_DISK_CHANGED' | 'HEALTHCHECK_FAILED' | 'ABORTED' | 'SESSION_TIMEOUT' | 'EXECUTION_NOT_AUTHORIZED' | 'BASELINE_MISMATCH';
export class ProjectBuildError extends Error {
  constructor(readonly code: BuildErrorCode, readonly side?: Side, readonly checks?: ProjectCheckReport,
    /** Exit code of a managed serve child that died before readiness; process output is never carried. */
    readonly exitCode?: number | null) { super(code); this.name = 'ProjectBuildError'; }
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
interface Snapshot { files: Map<string, Buffer>; buildHash: string; totalBytes: number; }
interface BuildServer { server: Server; origin: string; install(snapshot: Snapshot, identity: ServedBuildIdentity): void; close(): Promise<void>; }
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

async function buildDirectory(workspace: string, config: MigrationConfig, side: Side): Promise<string> {
  const build = config[side].build;
  if (!build) throw new ProjectBuildError('SERVING_CONFIG_MISSING', side);
  let current = workspace;
  for (const segment of pathSegments(`${config[side].root}/${build.outputDir}`)) {
    current = join(current, segment);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new ProjectBuildError('UNSAFE_BUILD_DIRECTORY', side);
  }
  // The full config schema protects declared code paths; this also protects fixture roots in either app.
  const overlap = (path: string): boolean => path === current || isWithin(current, path) || isWithin(path, current);
  if (config.scenarios.some(item => overlap(resolve(workspace, item.fixtureRoot)))
    || config.criticalContract && overlap(resolve(workspace, config.criticalContract.path))) throw new ProjectBuildError('UNSAFE_BUILD_DIRECTORY', side);
  return current;
}

async function snapshotBuild(root: string, side: Side, checkAbort: () => void): Promise<Snapshot> {
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  let entryCount = 0;
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    checkAbort();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      checkAbort();
      if (++entryCount > MAX_FILES * 2) throw new ProjectBuildError('BUILD_OUTPUT_TOO_LARGE', side);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!MigrationPathSchema.safeParse(path).success || path.startsWith('__migration_harness_health__')
        || /(?:^|\/)[^/]*\.(?:pem|key)$/i.test(path) || entry.isSymbolicLink()) throw new ProjectBuildError('BUILD_OUTPUT_UNSAFE', side);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute, path); continue; }
      if (!entry.isFile()) throw new ProjectBuildError('BUILD_OUTPUT_UNSAFE', side);
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1) throw new ProjectBuildError('BUILD_OUTPUT_UNSAFE', side);
        if (before.size > MAX_FILE_BYTES || files.size >= MAX_FILES || totalBytes + before.size > MAX_BUILD_BYTES) throw new ProjectBuildError('BUILD_OUTPUT_TOO_LARGE', side);
        const bytes = Buffer.alloc(before.size + 1);
        let used = 0;
        while (used < bytes.length) { const read = await file.read(bytes, used, bytes.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
        const after = await file.stat();
        if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || await realpath(absolute) !== absolute) throw new ProjectBuildError('BUILD_DISK_CHANGED', side);
        files.set(path, bytes.subarray(0, used)); totalBytes += used;
      } finally { await file.close(); }
    }
  };
  try { await walk(root); }
  catch (error) {
    if (error instanceof ProjectBuildError) throw error;
    throw new ProjectBuildError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'BUILD_OUTPUT_MISSING' : 'BUILD_OUTPUT_UNSAFE', side);
  }
  if (!files.get('index.html')?.length) throw new ProjectBuildError('BUILD_OUTPUT_MISSING', side);
  const manifest = [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes), bytes: bytes.length }));
  return { files, totalBytes, buildHash: hash(canonical(manifest)) };
}

function servingUrl(value: string, side: Side): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port || Number(url.port) < 1 || url.pathname !== '/' || url.search || url.hash) throw new ProjectBuildError('SERVING_CONFIG_MISSING', side);
  return url;
}

/** Managed-serve declaration a side may carry; the parallel core lane adds the identical optional field. */
export interface SideServeDeclaration { commandId: string; readyTimeoutMs?: number }
export type ServeDeclarations = Record<Side, SideServeDeclaration | undefined>;
interface ServePlan { command: Command; cwd: string }
interface ManagedServe {
  /** Resolve when any HTTP response arrives; fail closed on spawn error, early exit, readiness timeout or abort. */
  ready(signal: AbortSignal, checkAbort: () => void): Promise<void>;
  /** Kill the whole process tree: SIGTERM grace first, SIGKILL escalation; idempotent. */
  stop(): Promise<void>;
}

/** Read and fail-closed validate each side's optional serve declaration from the raw configuration. */
export function serveDeclarations(config: unknown): ServeDeclarations {
  const declarations: ServeDeclarations = { source: undefined, target: undefined };
  if (!config || typeof config !== 'object') return declarations;
  for (const side of ['source', 'target'] as const) {
    const project = (config as Record<string, unknown>)[side];
    const serve = project && typeof project === 'object' ? (project as Record<string, unknown>).serve : undefined;
    if (serve === undefined) continue;
    if (!serve || typeof serve !== 'object' || Array.isArray(serve)) throw new ProjectBuildError('SERVE_CONFIG_INVALID', side);
    const { commandId, readyTimeoutMs } = serve as Record<string, unknown>;
    const validTimeout = readyTimeoutMs === undefined
      || typeof readyTimeoutMs === 'number' && Number.isInteger(readyTimeoutMs) && readyTimeoutMs >= 1 && readyTimeoutMs <= MAX_READY_TIMEOUT_MS;
    if (Object.keys(serve).some(key => !['commandId', 'readyTimeoutMs'].includes(key)) || typeof commandId !== 'string'
      || !MigrationIdSchema.safeParse(commandId).success || !validTimeout) throw new ProjectBuildError('SERVE_CONFIG_INVALID', side);
    declarations[side] = { commandId, ...(typeof readyTimeoutMs === 'number' ? { readyTimeoutMs } : {}) };
  }
  return declarations;
}

/**
 * Parse a configuration that may carry `serve`. The core schema gains that key in the parallel lane;
 * until then tolerate exactly its unrecognized presence and strip it, while every other rejection fails closed.
 */
function parseServerConfig(config: unknown): { config: MigrationConfig; serve: ServeDeclarations } {
  const serve = serveDeclarations(config);
  try { return { config: parseMigrationConfig(config), serve }; }
  catch (error) {
    if (!(serve.source || serve.target) || !serveOnlyRejection(error)) throw error;
    const stripped = { ...(config as Record<string, unknown>) };
    for (const side of ['source', 'target'] as const) {
      const project = stripped[side];
      if (project && typeof project === 'object') {
        const rest = { ...(project as Record<string, unknown>) };
        delete rest.serve;
        stripped[side] = rest;
      }
    }
    return { config: parseMigrationConfig(stripped), serve };
  }
}

/** Only the not-yet-declared `serve` key on a side may be tolerated; no other schema rejection is ever masked. */
function serveOnlyRejection(error: unknown): boolean {
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) && issues.length > 0 && issues.every((issue: { code?: unknown; keys?: unknown; path?: unknown }) =>
    issue.code === 'unrecognized_keys' && Array.isArray(issue.keys) && issue.keys.length === 1 && issue.keys[0] === 'serve'
    && Array.isArray(issue.path) && issue.path.length === 1 && ['source', 'target'].includes(String(issue.path[0])));
}

/** Resolve a side's declared serve command and the side root it runs from, before any project command executes. */
async function servePlan(workspace: string, config: MigrationConfig, side: Side, declaration: SideServeDeclaration): Promise<ServePlan> {
  const command = config[side].commands.find(item => item.id === declaration.commandId);
  if (!command || command.kind !== 'serve') throw new ProjectBuildError('SERVE_COMMAND_INVALID', side);
  let cwd = workspace, valid = true;
  for (const segment of pathSegments(config[side].root)) {
    cwd = join(cwd, segment);
    const stat = await lstat(cwd).catch(() => undefined);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) { valid = false; break; }
  }
  if (!valid) throw new ProjectBuildError('SERVE_COMMAND_INVALID', side);
  return { command, cwd };
}

/** Launch a side's declared serve command and own its whole process tree for the session lifetime. */
function startManagedServe(input: { side: Side; plan: ServePlan; url: URL; readyTimeoutMs: number }): ManagedServe {
  const { side, plan, url } = input;
  // Same spawn contract as declared commands: scrubbed environment, POSIX process group, Windows cmd.exe shims.
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const exe = resolveExecutable(plan.command.argv[0]!);
  const viaCmd = process.platform === 'win32' && exe.toLowerCase().endsWith('.cmd');
  const child = viaCmd
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', exe, ...plan.command.argv.slice(1)],
      { cwd: plan.cwd, env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(exe, plan.command.argv.slice(1),
      { cwd: plan.cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  // Managed output is drained and discarded: it must never reach traces, evidence or reports.
  child.stdout?.resume(); child.stderr?.resume();
  let spawnFailed = false;
  let exitCode: number | null | undefined;
  let hasClosed = false;
  const closed = new Promise<void>(done => { child.once('close', () => { hasClosed = true; done(); }); });
  child.once('error', () => { spawnFailed = true; });
  child.once('exit', code => { exitCode = code; });
  const deadline = Date.now() + input.readyTimeoutMs;
  let stopping: Promise<void> | undefined;
  return {
    ready: async (signal, checkAbort) => {
      for (;;) {
        checkAbort();
        if (spawnFailed) throw new ProjectBuildError('SERVER_START_FAILED', side);
        if (exitCode !== undefined) throw new ProjectBuildError('SERVER_EXITED_EARLY', side, undefined, exitCode);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ProjectBuildError('SERVER_READY_TIMEOUT', side);
        if (await readyProbe(url, Math.min(READY_ATTEMPT_TIMEOUT_MS, remaining), signal)) return;
        await delay(READY_POLL_INTERVAL_MS);
      }
    },
    stop: () => stopping ??= (async () => {
      if (child.pid) {
        try { killTree(child, 'SIGTERM'); } catch { /* the SIGKILL pass below still runs */ }
        await Promise.race([closed, delay(SERVE_KILL_GRACE_MS)]);
        if (!hasClosed) { try { killTree(child, 'SIGKILL'); } catch { /* already reaped */ } }
        await Promise.race([closed, delay(SERVE_KILL_GRACE_MS)]);
      }
      child.stdout?.destroy(); child.stderr?.destroy();
    })(),
  };
}

/** Any HTTP response, whatever the status, proves the managed side accepts requests on its base URL. */
function readyProbe(url: URL, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>(done => {
    if (signal.aborted) { done(false); return; }
    let settled = false;
    let request: ClientRequest | undefined;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      done(ready);
    };
    const abort = (): void => { request?.destroy(); finish(false); };
    request = get(`${url.origin}/`, { timeout: timeoutMs }, response => { response.resume(); finish(true); });
    request.once('timeout', () => { request?.destroy(); finish(false); });
    request.once('error', () => finish(false));
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function reserveServer(url: URL, side: Side): Promise<BuildServer> {
  let snapshot: Snapshot | undefined;
  let identity: ServedBuildIdentity | undefined;
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (request.headers.host !== url.host) { response.writeHead(421); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return; }
    if (!snapshot || !identity) { response.writeHead(503); response.end(); return; }
    let path: string;
    try { path = decodeURIComponent(new URL(request.url ?? '/', url.origin).pathname); }
    catch { response.writeHead(400); response.end(); return; }
    response.setHeader('x-migration-build', identity.buildHash);
    if (path === HEALTH) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(identity)); return;
    }
    const relative = path.replace(/^\//, '');
    if (relative && !MigrationPathSchema.safeParse(relative.replace(/\/$/, '')).success) { response.writeHead(400); response.end(); return; }
    let file = relative || 'index.html';
    if (!snapshot.files.has(file) && !extname(file) && request.headers.accept?.includes('text/html')) file = 'index.html';
    const bytes = snapshot.files.get(file);
    // Source maps and unknown artifacts are fingerprinted but are not served as public assets.
    const contentType = types[extname(file)];
    if (!bytes || !contentType) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise<void>((done, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(new ProjectBuildError(error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'SERVER_START_FAILED', side)));
    server.listen(Number(url.port), url.hostname === '[::1]' ? '::1' : '127.0.0.1', done);
  });
  let closing: Promise<void> | undefined;
  return {
    server, origin: url.origin,
    install: (build, descriptor) => { snapshot = build; identity = descriptor; },
    close: () => closing ??= new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done()); server.closeAllConnections();
    }),
  };
}

async function verifyHealth(expected: ServedBuildIdentity): Promise<void> {
  const url = new URL(expected.origin);
  await new Promise<void>((done, reject) => {
    const failure = (): void => reject(new ProjectBuildError('HEALTHCHECK_FAILED', expected.side));
    const request = get({ hostname: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port: url.port,
      path: HEALTH, headers: { host: url.host }, timeout: 2000 }, response => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); if (body.length > 4096) request.destroy(); });
      response.on('error', failure);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200 || canonical(ServedBuildIdentitySchema.parse(JSON.parse(body))) !== canonical(expected)) { failure(); return; }
          done();
        } catch { failure(); }
      });
    });
    request.on('timeout', () => request.destroy()); request.on('error', failure);
  });
}

export interface BuildServerSession {
  source: ServedBuildIdentity;
  target: ServedBuildIdentity;
  signal: AbortSignal;
}

/** Probe declared static output paths and managed serve declarations, and reserve/release ports without cleaning or running project commands. */
export async function preflightBuildServers(input: { config: unknown; workspaceRoot: string }): Promise<void> {
  const { config, serve } = parseServerConfig(input.config);
  if ((await preflightProjectChecks({ ...input, config })).status !== 'PASS') throw new ProjectBuildError('BUILD_INPUT_CHANGED');
  const workspace = await realpath(resolve(input.workspaceRoot));
  const servers: BuildServer[] = [];
  try {
    for (const side of ['source', 'target'] as const) {
      // A managed side replaces the static output probe, but its base URL port must still be free for the child.
      const declaration = serve[side];
      if (declaration) await servePlan(workspace, config, side, declaration);
      else await buildDirectory(workspace, config, side);
      servers.push(await reserveServer(servingUrl(config[side].baseUrl, side), side));
    }
  } finally { await Promise.all(servers.map(server => server.close())); }
}

/** Builds from clean declared output directories and serves immutable snapshots only for the callback lifetime;
 * a side that declares `serve` is launched and readiness-gated as a managed child process instead. */
export async function withProjectBuildServers<T>(input: {
  config: unknown; workspaceRoot: string; allowProjectCommands?: boolean; signal?: AbortSignal;
  phase?: 'baseline' | 'candidate'; baseline?: unknown;
  /** Optional operation-level phase recorder; observation only, never influences build decisions. */
  timings?: PhaseTimer;
}, use: (session: BuildServerSession) => Promise<T>): Promise<{
  value: T; builds: { source: ServedBuildIdentity; target: ServedBuildIdentity }; checks: ProjectCheckReport;
  /** Immutable build-cache outcome per side (PLAN-V2 §4.3): observation only, never a decision input. */
  cache: Record<Side, BuildCacheSideReport>;
}> {
  if (input.allowProjectCommands !== true) throw new ProjectBuildError('EXECUTION_NOT_AUTHORIZED');
  // Local timer keeps standalone callers measurable; operation runs share the caller's recorder.
  const timer = input.timings ?? new PhaseTimer();
  const { config, serve } = parseServerConfig(input.config);
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; abort(); }, config.limits.maxDurationMs);
  const checkAbort = (): void => { if (controller.signal.aborted) throw new ProjectBuildError(timedOut ? 'SESSION_TIMEOUT' : 'ABORTED'); };
  const servers = new Map<Side, BuildServer>();
  const managed: ManagedServe[] = [];
  try {
    checkAbort();
    const preflight = await timer.phase('project-checks', () => preflightProjectChecks({ ...input, config }), { step: 'suite-preflight' });
    if (preflight.status !== 'PASS') throw new ProjectBuildError('BUILD_INPUT_CHANGED');
    const baseline = input.baseline === undefined ? undefined : parseProjectCheckReport(input.baseline);
    if (baseline && (input.phase === 'baseline' || baseline.phase !== 'baseline' || baseline.configurationHash !== preflight.configurationHash
      || baseline.workspaceHash !== preflight.workspaceHash || baseline.preflight.status !== 'PASS'
      || baseline.inputHashAfter !== baseline.preflight.inputHash || baseline.findings.length)) throw new ProjectBuildError('BASELINE_MISMATCH');
    const workspace = await realpath(resolve(input.workspaceRoot));
    const paths: Record<Side, string | undefined> = { source: undefined, target: undefined };
    for (const side of ['source', 'target'] as const) if (!serve[side] || config[side].build) paths[side] = await buildDirectory(workspace, config, side);
    const urls = { source: servingUrl(config.source.baseUrl, 'source'), target: servingUrl(config.target.baseUrl, 'target') };
    const plans: Record<Side, ServePlan | undefined> = { source: undefined, target: undefined };
    for (const side of ['source', 'target'] as const) {
      const declaration = serve[side];
      if (declaration) plans[side] = await servePlan(workspace, config, side, declaration);
    }
    // `serve` = port reservation, managed-serve spawn/readiness and teardown — served-app hosting,
    // deliberately distinct from the capture container `boot` (browser launch, navigation, steps, close).
    for (const side of ['source', 'target'] as const) {
      checkAbort();
      if (!serve[side]) servers.set(side, await timer.phase('serve', () => reserveServer(urls[side], side), { step: 'reserve-port', side }));
    }
    // Static ports are now owned; managed sides bind their own port only when their declared serve command starts.
    for (const side of ['source', 'target'] as const) {
      checkAbort();
      const path = paths[side];
      if (path) await timer.phase('builds', async () => {
        await buildDirectory(workspace, config, side); await rm(path, { recursive: true, force: true });
      }, { step: 'clean-output', side });
    }
    // Immutable build cache: assess identity and restore verified artifacts before any command
    // runs, so a hit never executes the managed build. Every other declared check always runs.
    // PhaseTimer stores each detail object by reference, so results recorded after the span are
    // part of timings.json.
    const cachePlans: Record<Side, BuildCacheSidePlan> = { source: { status: 'NO_BUILD' }, target: { status: 'NO_BUILD' } };
    for (const side of ['source', 'target'] as const) {
      if (!paths[side] || !config[side].build) continue;
      checkAbort();
      const detail: TimingDetail = { step: 'cache-probe', side, result: 'pending' };
      const plan = await timer.phase('builds', () => planBuildCacheSide({ config, workspaceRoot: workspace, side, checkAbort }), detail);
      cachePlans[side] = plan; detail.result = plan.reason ?? plan.status;
    }
    for (const side of ['source', 'target'] as const) {
      const plan = cachePlans[side];
      if (plan.status !== 'HIT') continue;
      checkAbort();
      const detail: TimingDetail = { step: 'cache-restore', side, result: 'pending' };
      try {
        await timer.phase('builds', () => restoreBuildCache(plan, paths[side]!), detail);
        detail.result = 'RESTORED';
      } catch (error) {
        detail.result = 'FAILED';
        // A cache that cannot be restored behaves exactly like a miss: clean again and build.
        await rm(paths[side]!, { recursive: true, force: true });
        cachePlans[side] = { status: 'MISS', reason: 'RESTORE_FAILED', identity: plan.identity };
        if (error instanceof ProjectBuildError) throw error;
      }
    }
    const runDetail: TimingDetail = { step: 'run-commands', checks: config.checks.length,
      checkPhase: input.phase ?? 'candidate', satisfiedChecks: 0, executedChecks: config.checks.length };
    const run = await timer.phase('builds', () => runProjectChecksWithCache({ config, workspaceRoot: workspace,
      phase: input.phase ?? 'candidate', ...(baseline ? { baseline } : {}), allowProjectCommands: true,
      signal: controller.signal, preflight, plans: cachePlans }), runDetail);
    runDetail.satisfiedChecks = run.satisfiedChecks; runDetail.executedChecks = run.executedChecks;
    const checks = run.report;
    checkAbort();
    if (checks.preflight.inputHash !== preflight.inputHash || checks.inputHashAfter !== preflight.inputHash) throw new ProjectBuildError('BUILD_INPUT_CHANGED', undefined, checks);
    if (checks.findings.length || (['source', 'target'] as const).some(side => config[side].build
      && checks.checks.some(check => check.side === side && check.commandId === config[side].build!.commandId && check.status !== 'PASS'))) {
      throw new ProjectBuildError('BUILD_CHECK_FAILED', undefined, checks);
    }
    const builds = {} as { source: ServedBuildIdentity; target: ServedBuildIdentity };
    const snapshots: Partial<Record<Side, Snapshot>> = {};
    const diverged: Partial<Record<Side, boolean>> = {};
    for (const side of ['source', 'target'] as const) {
      const declaration = serve[side];
      if (declaration) {
        checkAbort();
        const plan = plans[side]!;
        const server = timer.phaseSync('serve', () => {
          const started = startManagedServe({ side, plan, url: urls[side], readyTimeoutMs: declaration.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS });
          // Registered before readiness so every failure path still tears the child down.
          managed.push(started);
          return started;
        }, { step: 'serve-spawn', side });
        await timer.phase('serve', () => server.ready(controller.signal, checkAbort), { step: 'serve-ready', side });
        // Managed bytes belong to the application: identity covers the declared launch, never a harness snapshot.
        const served = canonical({ kind: 'MANAGED_SERVE', side, origin: urls[side].origin,
          commandId: declaration.commandId, argv: plan.command.argv, cwd: plan.command.cwd });
        builds[side] = ServedBuildIdentitySchema.parse({ kind: 'SERVED_BUILD', version: '1', side, runId: randomUUID(),
          origin: urls[side].origin, configurationHash: checks.configurationHash, inputHash: preflight.inputHash,
          buildHash: hash(served), fileCount: 1, totalBytes: Buffer.byteLength(served) });
        continue;
      }
      await buildDirectory(workspace, config, side);
      const snapshot = await timer.phase('builds', () => snapshotBuild(paths[side]!, side, checkAbort), { step: 'snapshot', side });
      const plan = cachePlans[side];
      if (plan.status === 'HIT' && snapshot.buildHash !== plan.manifest.output.buildHash) {
        // Restored bytes must be the attested artifact; anything else is a corrupt cache and never
        // a success. When the build actually ran (report fallback), the entry contradicts its own
        // identity: keep this cycle's real bytes and drop the unusable entry.
        if (run.applied) throw new ProjectBuildError('BUILD_OUTPUT_UNSAFE', side);
        diverged[side] = true;
        await invalidateBuildCacheEntry(plan.identity, workspace);
      }
      snapshots[side] = snapshot;
      builds[side] = ServedBuildIdentitySchema.parse({ kind: 'SERVED_BUILD', version: '1', side, runId: randomUUID(),
        origin: urls[side].origin, configurationHash: checks.configurationHash, inputHash: preflight.inputHash,
        buildHash: snapshot.buildHash, fileCount: snapshot.files.size, totalBytes: snapshot.totalBytes });
      servers.get(side)!.install(snapshot, builds[side]);
      await timer.phase('serve', () => verifyHealth(builds[side]), { step: 'health', side });
    }
    // Publish only after the build check passed and the output was snapshotted; the publication
    // itself re-assesses the identity, so nothing is stored when an input moved during the build.
    const published: Partial<Record<Side, string>> = {};
    for (const side of ['source', 'target'] as const) {
      const plan = cachePlans[side];
      const snapshot = snapshots[side];
      if (plan.status !== 'MISS' || !snapshot) continue;
      const row = checks.checks.find(item => item.side === side && item.commandId === config[side].build!.commandId);
      if (!row || row.status !== 'PASS') continue;
      const detail: TimingDetail = { step: 'cache-publish', side, result: 'pending' };
      const outcome = await timer.phase('builds', () => publishBuildCacheSide({ config, workspaceRoot: workspace, side,
        identity: plan.identity, output: snapshot,
        recorded: { at: new Date().toISOString(), durationMs: row.durationMs, exitCode: row.exitCode ?? 0,
          stdoutBytes: row.output.stdoutBytes, stderrBytes: row.output.stderrBytes } }), detail);
      detail.result = outcome.status;
      if (outcome.status === 'SKIPPED' || outcome.status === 'FAILED') published[side] = `${outcome.status}:${outcome.reason}`;
      else published[side] = outcome.status;
    }
    const cacheReport = (side: Side): BuildCacheSideReport => {
      const plan = cachePlans[side];
      if (plan.status === 'MISS') return { status: 'MISS', reason: plan.reason, ...(published[side] ? { publish: published[side] } : {}) };
      if (plan.status !== 'HIT') return { status: plan.status, ...(plan.reason ? { reason: plan.reason } : {}) };
      if (diverged[side]) return { status: 'HIT_NOT_APPLIED', reason: 'OUTPUT_DIVERGED' };
      return run.applied ? { status: 'HIT' } : { status: 'HIT_NOT_APPLIED', reason: 'REPORT_NOT_APPLICABLE' };
    };
    const cache: Record<Side, BuildCacheSideReport> = { source: cacheReport('source'), target: cacheReport('target') };
    checkAbort();
    let onAbort: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProjectBuildError(timedOut ? 'SESSION_TIMEOUT' : 'ABORTED'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let value: T;
    try { value = await Promise.race([use({ ...structuredClone(builds), signal: controller.signal }), aborted]); }
    finally { controller.signal.removeEventListener('abort', onAbort!); }
    checkAbort();
    for (const side of ['source', 'target'] as const) {
      // Managed sides serve their own live bytes; snapshot health and disk-changed guards do not apply.
      if (serve[side]) continue;
      await timer.phase('builds', async () => {
        await verifyHealth(builds[side]); await buildDirectory(workspace, config, side);
        if ((await snapshotBuild(paths[side]!, side, checkAbort)).buildHash !== builds[side].buildHash) throw new ProjectBuildError('BUILD_DISK_CHANGED', side);
      }, { step: 'post-verify', side });
    }
    const after = await timer.phase('project-checks', () => preflightProjectChecks({ ...input, config }), { step: 'suite-postcheck' });
    if (after.status !== 'PASS' || after.inputHash !== preflight.inputHash) throw new ProjectBuildError('BUILD_INPUT_CHANGED');
    checkAbort();
    return { value, builds, checks, cache };
  } finally {
    clearTimeout(timeout); input.signal?.removeEventListener('abort', abort);
    // Every teardown runs to completion before the session settles, whatever any single close reports.
    const results = await timer.phase('serve', () => Promise.allSettled([...servers.values()].map(server => server.close())
      .concat(managed.map(server => server.stop()))), { step: 'teardown' });
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
