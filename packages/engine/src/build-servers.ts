import { createServer, get, type Server } from 'node:http';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  canonical, parseMigrationConfig, MigrationPathSchema, ServedBuildIdentitySchema,
  type MigrationConfig, type ProjectCheckReport, type ServedBuildIdentity,
} from '@migration-harness/core';
import { preflightProjectChecks, runProjectChecks } from './project-checks.js';

const HEALTH = '/__migration_harness_health__';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 5000;
type Side = 'source' | 'target';
type BuildErrorCode = 'SERVING_CONFIG_MISSING' | 'UNSAFE_BUILD_DIRECTORY' | 'PORT_IN_USE' | 'SERVER_START_FAILED'
  | 'BUILD_CHECK_FAILED' | 'BUILD_OUTPUT_MISSING' | 'BUILD_OUTPUT_UNSAFE' | 'BUILD_OUTPUT_TOO_LARGE'
  | 'BUILD_INPUT_CHANGED' | 'BUILD_DISK_CHANGED' | 'HEALTHCHECK_FAILED' | 'ABORTED' | 'SESSION_TIMEOUT' | 'EXECUTION_NOT_AUTHORIZED';
export class ProjectBuildError extends Error {
  constructor(readonly code: BuildErrorCode, readonly side?: Side) { super(code); this.name = 'ProjectBuildError'; }
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
  for (const segment of `${config[side].root}/${build.outputDir}`.split('/')) {
    current = join(current, segment);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new ProjectBuildError('UNSAFE_BUILD_DIRECTORY', side);
  }
  // The full config schema protects declared code paths; this also protects fixture roots in either app.
  const overlap = (path: string): boolean => path === current || path.startsWith(`${current}/`) || current.startsWith(`${path}/`);
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

/** Builds from clean declared output directories and serves immutable snapshots only for the callback lifetime. */
export async function withProjectBuildServers<T>(input: {
  config: unknown; workspaceRoot: string; allowProjectCommands?: boolean; signal?: AbortSignal;
}, use: (session: BuildServerSession) => Promise<T>): Promise<{
  value: T; builds: { source: ServedBuildIdentity; target: ServedBuildIdentity }; checks: ProjectCheckReport;
}> {
  if (input.allowProjectCommands !== true) throw new ProjectBuildError('EXECUTION_NOT_AUTHORIZED');
  const config = parseMigrationConfig(input.config);
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; abort(); }, config.limits.maxDurationMs);
  const checkAbort = (): void => { if (controller.signal.aborted) throw new ProjectBuildError(timedOut ? 'SESSION_TIMEOUT' : 'ABORTED'); };
  const servers: BuildServer[] = [];
  try {
    checkAbort();
    const preflight = await preflightProjectChecks(input);
    if (preflight.status !== 'PASS') throw new ProjectBuildError('BUILD_INPUT_CHANGED');
    const workspace = await realpath(resolve(input.workspaceRoot));
    const paths = { source: await buildDirectory(workspace, config, 'source'), target: await buildDirectory(workspace, config, 'target') };
    const urls = { source: servingUrl(config.source.baseUrl, 'source'), target: servingUrl(config.target.baseUrl, 'target') };
    for (const side of ['source', 'target'] as const) { checkAbort(); servers.push(await reserveServer(urls[side], side)); }
    // Both ports are now owned. Never reuse an unrelated server or its preexisting output.
    for (const side of ['source', 'target'] as const) { checkAbort(); await buildDirectory(workspace, config, side); await rm(paths[side], { recursive: true, force: true }); }
    const checks = await runProjectChecks({ config, workspaceRoot: workspace, phase: 'candidate', allowProjectCommands: true, signal: controller.signal });
    checkAbort();
    if (checks.status !== 'PASS') throw new ProjectBuildError('BUILD_CHECK_FAILED');
    if (checks.preflight.inputHash !== preflight.inputHash || checks.inputHashAfter !== preflight.inputHash) throw new ProjectBuildError('BUILD_INPUT_CHANGED');
    const builds = {} as { source: ServedBuildIdentity; target: ServedBuildIdentity };
    for (const [index, side] of (['source', 'target'] as const).entries()) {
      await buildDirectory(workspace, config, side);
      const snapshot = await snapshotBuild(paths[side], side, checkAbort);
      builds[side] = ServedBuildIdentitySchema.parse({ kind: 'SERVED_BUILD', version: '1', side, runId: randomUUID(),
        origin: urls[side].origin, configurationHash: checks.configurationHash, inputHash: preflight.inputHash,
        buildHash: snapshot.buildHash, fileCount: snapshot.files.size, totalBytes: snapshot.totalBytes });
      servers[index]!.install(snapshot, builds[side]); await verifyHealth(builds[side]);
    }
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
      await verifyHealth(builds[side]); await buildDirectory(workspace, config, side);
      if ((await snapshotBuild(paths[side], side, checkAbort)).buildHash !== builds[side].buildHash) throw new ProjectBuildError('BUILD_DISK_CHANGED', side);
    }
    const after = await preflightProjectChecks(input);
    if (after.status !== 'PASS' || after.inputHash !== preflight.inputHash) throw new ProjectBuildError('BUILD_INPUT_CHANGED');
    checkAbort();
    return { value, builds, checks };
  } finally {
    clearTimeout(timeout); input.signal?.removeEventListener('abort', abort);
    await Promise.all(servers.map(server => server.close()));
  }
}
