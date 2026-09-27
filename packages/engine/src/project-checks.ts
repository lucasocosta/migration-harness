import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  canonical, parseMigrationConfig, migrationConfigHash, ProjectPreflightSchema, ProjectCheckReportSchema,
  parseProjectCheckReport, type MigrationConfig, type NativeCheckResult, type ProjectCheckReport, type ProjectPreflight,
} from '@migration-harness/core';
import { collectMigrationReference } from './migration-reference.js';
import { assertNotPrivateWorkspace, pathSegments, privateBaseDir, probePrivatePermissionMode } from './platform-paths.js';
import { killTree, resolveExecutable, supportsTreeKill } from './process-tree.js';

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const OUTPUT_LIMIT = 1_048_576;
type ProjectSide = 'source' | 'target';
type Command = MigrationConfig['source']['commands'][number];

async function workspacePath(root: string): Promise<string> {
  const path = await realpath(resolve(root));
  assertNotPrivateWorkspace(path, privateBaseDir());
  return path;
}

async function commandCwd(workspace: string, config: MigrationConfig, side: ProjectSide, command: Command): Promise<string> {
  let current = workspace;
  const path = `${config[side].root}${command.cwd === '.' ? '' : `/${command.cwd}`}`;
  for (const segment of pathSegments(path)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Command cwd must be a real project directory');
  }
  return current;
}

/** Hash only declared working-tree inputs; this is not the served-build identity promised by P3. */
async function inputHash(config: MigrationConfig, workspaceRoot: string): Promise<string> {
  const reference = await collectMigrationReference({ config, workspaceRoot });
  return digest({ source: reference.source.files, target: reference.target.files,
    protectedFiles: reference.target.protectedFiles, criteria: reference.criteria });
}

export async function preflightProjectChecks(input: { config: unknown; workspaceRoot: string }): Promise<ProjectPreflight> {
  const config = parseMigrationConfig(input.config);
  const findings: ProjectPreflight['findings'] = [];
  const workspace = await workspacePath(input.workspaceRoot).catch(() => undefined);
  let fingerprint: string | undefined;
  if (!workspace) findings.push({ code: 'INPUT_UNAVAILABLE' });
  else {
    fingerprint = await inputHash(config, workspace).catch(() => { findings.push({ code: 'INPUT_UNAVAILABLE' }); return undefined; });
    for (const check of config.checks) {
      const command = config[check.side].commands.find(item => item.id === check.commandId)!;
      await commandCwd(workspace, config, check.side, command).catch(() => findings.push({ code: 'CWD_UNAVAILABLE', checkId: check.id }));
    }
  }
  // Process-tree cleanup is available on every supported platform (POSIX groups or taskkill /T).
  if (!supportsTreeKill()) findings.push({ code: 'UNSUPPORTED_PLATFORM' });
  const disclosures: NonNullable<ProjectPreflight['disclosures']> = [];
  if (await probePrivatePermissionMode() !== 'STRICT') {
    disclosures.push({ code: 'WEAK_PRIVATE_PERMISSIONS', detailCode: 'PRIVATE_STORE_DEGRADED' });
    disclosures.push({ code: 'DEGRADED_ISOLATION', detailCode: 'PRIVATE_STORE_DEGRADED' });
  }
  return ProjectPreflightSchema.parse({ kind: 'PROJECT_PREFLIGHT', version: '1', migrationId: config.migrationId,
    configurationHash: migrationConfigHash(config), workspaceHash: digest(workspace ?? resolve(input.workspaceRoot)),
    status: findings.length ? 'INCONCLUSIVE' : 'PASS', ...(fingerprint ? { inputHash: fingerprint } : {}),
    findings, ...(disclosures.length ? { disclosures } : {}) });
}

type Outcome = Pick<NativeCheckResult, 'status' | 'reason' | 'exitCode' | 'durationMs' | 'output'>;
export interface ProjectResetResult {
  kind: 'ISOLATED_FIXTURES' | 'COMMANDS';
  side: ProjectSide;
  status: 'PASS' | 'INCONCLUSIVE';
  reason: Outcome['reason'] | 'ISOLATED_CONTEXT' | 'EXECUTION_NOT_AUTHORIZED' | 'INPUT_CHANGED' | 'CWD_UNAVAILABLE';
  commandId?: string;
  outcome?: Outcome;
}

/** Run the declared reset, with the same authorization, process bounds and input checks as native checks. */
export async function runProjectReset(input: {
  config: unknown; workspaceRoot: string; side: ProjectSide; allowProjectCommands?: boolean; signal?: AbortSignal;
}): Promise<ProjectResetResult> {
  const config = parseMigrationConfig(input.config);
  if (!['source', 'target'].includes(input.side)) throw new Error('Invalid reset side');
  const base = { kind: config.reset.kind, side: input.side };
  if (input.allowProjectCommands !== true) return { ...base, status: 'INCONCLUSIVE', reason: 'EXECUTION_NOT_AUTHORIZED' };
  if (input.signal?.aborted) return { ...base, status: 'INCONCLUSIVE', reason: 'ABORTED' };
  if (config.reset.kind === 'ISOLATED_FIXTURES') return { ...base, status: 'PASS', reason: 'ISOLATED_CONTEXT' };
  const preflight = await preflightProjectChecks(input);
  if (preflight.status !== 'PASS') return { ...base, status: 'INCONCLUSIVE', reason: 'INPUT_CHANGED' };
  const commandId = config.reset[`${input.side}CommandId`];
  const command = config[input.side].commands.find(item => item.id === commandId)!;
  const workspace = await workspacePath(input.workspaceRoot);
  const cwd = await commandCwd(workspace, config, input.side, command).catch(() => undefined);
  if (!cwd) return { ...base, commandId, status: 'INCONCLUSIVE', reason: 'CWD_UNAVAILABLE' };
  const outcome = await execute(command, cwd, Math.min(command.timeoutMs, config.limits.maxDurationMs), input.signal);
  const after = await preflightProjectChecks(input);
  if (after.status !== 'PASS' || after.inputHash !== preflight.inputHash) return { ...base, commandId, outcome, status: 'INCONCLUSIVE', reason: 'INPUT_CHANGED' };
  return { ...base, commandId, outcome, status: outcome.status === 'PASS' ? 'PASS' : 'INCONCLUSIVE', reason: outcome.reason };
}
const notRun = (): Outcome => ({ status: 'INCONCLUSIVE', reason: 'NOT_RUN', exitCode: null, durationMs: 0,
  output: { omitted: true, stdoutBytes: 0, stderrBytes: 0 } });

async function execute(command: Command, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Outcome> {
  const started = Date.now();
  if (signal?.aborted) return { ...notRun(), reason: 'ABORTED' };
  // Do not inherit credentials, NODE_OPTIONS or arbitrary application variables.
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return new Promise(resolveOutcome => {
    // detached gives POSIX its own process group; on Windows it would open a new console and break pipes.
    // Node 22+ refuses spawn() of .cmd shims without a shell, so route those through cmd.exe /c.
    const exe = resolveExecutable(command.argv[0]!);
    const viaCmd = process.platform === 'win32' && exe.toLowerCase().endsWith('.cmd');
    const child = viaCmd
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', exe, ...command.argv.slice(1)], { cwd, env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(exe, command.argv.slice(1), { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { omitted: true as const, stdoutBytes: 0, stderrBytes: 0 };
    let reason: Outcome['reason'] | undefined;
    let exitCode: number | null = null;
    let finishing = false;
    let closed = false;
    let closeResolve: () => void;
    const close = new Promise<void>(done => { closeResolve = done; });
    const killGroup = (signal: NodeJS.Signals): void => {
      try { killTree(child, signal); }
      catch { reason = 'CLEANUP_FAILED'; }
    };
    const finish = async (): Promise<void> => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      killGroup('SIGTERM');
      if (child.pid) { await delay(150); killGroup('SIGKILL'); }
      await Promise.race([close, delay(500)]);
      if (!closed) reason = 'CLEANUP_FAILED';
      child.stdout.destroy(); child.stderr.destroy();
      const finalReason = reason ?? (exitCode === 0 ? 'COMPLETED' : exitCode === null ? 'CLEANUP_FAILED' : 'EXIT_NONZERO');
      resolveOutcome({ status: finalReason === 'COMPLETED' ? 'PASS' : finalReason === 'EXIT_NONZERO' ? 'FAIL' : 'INCONCLUSIVE',
        reason: finalReason, exitCode, durationMs: Date.now() - started, output });
    };
    const abort = (): void => { reason = 'ABORTED'; void finish(); };
    const timer = setTimeout(() => { reason = 'TIMEOUT'; void finish(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, key] of [[child.stdout, 'stdoutBytes'], [child.stderr, 'stderrBytes']] as const) stream.on('data', (chunk: Buffer) => {
      output[key] += chunk.byteLength;
      if (output.stdoutBytes + output.stderrBytes > OUTPUT_LIMIT && !reason) { reason = 'OUTPUT_LIMIT'; void finish(); }
    });
    child.once('error', () => { reason = 'SPAWN_FAILED'; void finish(); });
    child.once('exit', code => { exitCode = code; void finish(); });
    child.once('close', () => { closed = true; closeResolve(); });
    if (signal?.aborted) abort();
  });
}

export async function runProjectChecks(input: {
  config: unknown; workspaceRoot: string; phase: 'baseline' | 'candidate'; allowProjectCommands?: boolean;
  baseline?: unknown; signal?: AbortSignal;
}): Promise<ProjectCheckReport> {
  const started = Date.now();
  const config = parseMigrationConfig(input.config);
  if (!['baseline', 'candidate'].includes(input.phase)) throw new Error('Invalid check phase');
  const preflight = await preflightProjectChecks(input);
  const findings: ProjectCheckReport['findings'] = [];
  const baseline = input.baseline === undefined ? undefined : parseProjectCheckReport(input.baseline);
  if (baseline && (input.phase !== 'candidate' || baseline.phase !== 'baseline'
    || baseline.configurationHash !== preflight.configurationHash || baseline.workspaceHash !== preflight.workspaceHash
    || baseline.migrationId !== config.migrationId || baseline.preflight.status !== 'PASS'
    || baseline.inputHashAfter !== baseline.preflight.inputHash || baseline.findings.length)) findings.push({ code: 'BASELINE_MISMATCH' });
  if (input.allowProjectCommands !== true) findings.push({ code: 'EXECUTION_NOT_AUTHORIZED' });
  const checks: NativeCheckResult[] = [];
  for (const check of config.checks) {
    const command = config[check.side].commands.find(item => item.id === check.commandId)!;
    const commandHash = digest(command);
    let outcome = notRun();
    if (preflight.status === 'PASS' && !findings.length) {
      const remaining = config.limits.maxDurationMs - (Date.now() - started);
      if (remaining <= 0) outcome.reason = 'TIMEOUT';
      else {
        try {
          const workspace = await workspacePath(input.workspaceRoot);
          const cwd = await commandCwd(workspace, config, check.side, command);
          outcome = await execute(command, cwd, Math.min(command.timeoutMs, remaining), input.signal);
        } catch { findings.push({ code: 'CWD_UNAVAILABLE', checkId: check.id }); }
      }
    }
    const before = baseline?.checks.find(item => item.checkId === check.id && item.commandHash === commandHash && item.side === check.side);
    const baselineComparison = input.phase === 'baseline' ? 'BASELINE'
      : !before || before.status === 'INCONCLUSIVE' || outcome.status === 'INCONCLUSIVE' ? 'NOT_COMPARED'
      : outcome.status === 'FAIL' ? before.status === 'FAIL' ? 'BASELINE_CHECK_FAILED' : 'NEW_CHECK_FAILURE'
      : before.status === 'FAIL' ? 'RESOLVED' : 'UNCHANGED';
    checks.push({ checkId: check.id, side: check.side, required: check.required, commandId: check.commandId,
      commandHash, ...outcome, baselineComparison });
  }
  const after = preflight.status === 'PASS' ? await inputHash(config, input.workspaceRoot).catch(() => undefined) : undefined;
  if (preflight.status === 'PASS' && after !== preflight.inputHash) findings.push({ code: 'INPUT_CHANGED' });
  const required = checks.filter(check => check.required);
  const status = preflight.status !== 'PASS' || findings.length || required.some(check => check.status === 'INCONCLUSIVE') ? 'INCONCLUSIVE'
    : required.some(check => check.status === 'FAIL') ? 'FAIL' : 'PASS';
  return ProjectCheckReportSchema.parse({ kind: 'PROJECT_CHECK_REPORT', version: '1', migrationId: config.migrationId,
    configurationHash: preflight.configurationHash, workspaceHash: preflight.workspaceHash, phase: input.phase,
    evaluatedAt: new Date().toISOString(), status, preflight, ...(after ? { inputHashAfter: after } : {}), findings, checks });
}
