/**
 * Immutable build cache — docs/PLAN-V2.md §4, "Ordem de alavancas" item 3.
 *
 * Containment: the cache is **opt-in and disabled by default**. Only `MIGRATION_HARNESS_BUILD_CACHE=1`
 * enables it; without that, no probe, restore or publish runs and the cycle is byte-identical to
 * having no cache. `MIGRATION_HARNESS_DISABLE_BUILD_CACHE=1` still forces the no-cache path for A/B
 * comparison and always wins. This is the containment for the identity limits below, not a claim that
 * those limits are gone: a disclosure never turns an incomplete identity into a safe hit.
 *
 * Scope: build **artifacts**. A managed build command is itself a declared `build` check; on a hit
 * that check's row is **recomposed** as PASS from the cached execution (`status: 'PASS'`,
 * `reason: 'COMPLETED'`, recorded output sizes) — so the qualified claim is: the cached command's own
 * check row is satisfied from the entry, while **every other declared check executes on every cycle**,
 * hit or miss. This is a different key domain from any evidence/observation cache (which would also
 * cover policy, scenarios, fixtures/reset, bindings and runner/browser versions) — the two must never
 * share a "reuse" mechanism.
 *
 * Identity (an input that cannot be identified forces a miss, never a hit — the identity is only as
 * strong as the rules below, it is **not** claimed to be complete):
 *   inputs       bytes of every transitive input of the side's project — code, configs, assets,
 *                scripts, untracked-but-relevant files — plus workspace files the project can reach
 *                (lockfiles, shared configuration) and config-declared roots outside the project root
 *   dependencies lockfiles AND the installation in use: state files, the entry inventory, the
 *                installed version/manifest of every declared dependency **and the file content of
 *                every managed entry** (bounded; an install that cannot be read that way is not
 *                cacheable)
 *   execution    argv, logical cwd, effective command environment, runtime/toolchain and flags
 *   platform     OS + architecture, separated per platform
 *   protocol     this file's format and identification-logic version
 *   artifact     complete manifest + output hashes, re-verified when consumed
 *
 * Rules: hidden input, unrecognized network reference, unidentified dependency or oversized
 * installation ⇒ not cacheable (forced miss, byte-identical behavior to having no cache); never
 * publish when inputs change during the build; corrupted or incomplete cache ⇒ miss or error, never
 * success; secret values never enter the key — the effective environment and absolute paths are only
 * ever digested.
 *
 * Storage: `<workspace>/node_modules/.migration-harness/build-cache/<key>/` (entry = complete
 * temporary directory renamed into place). It is outside every project root, which keeps it out of
 * scope snapshots, out of the declared inputs and out of git; a directory holding only this cache
 * is not an installation and never changes the identity it stores. Entries are bounded (newest 64
 * kept).
 *
 * Declared limits (reported, not hidden — opt-in is the containment):
 *   - Only config-declared roots outside the project root (scenario fixture roots, the critical
 *     contract) are fingerprinted. A build that reads an **undeclared** sibling directory
 *     (`../something`) is not observable from the configuration and cannot be distinguished from an
 *     eligible build; it must not be described as covered.
 *   - Network detection is a heuristic: argv classification plus a bounded scan of the build entry
 *     script and its local relative imports for network APIs. A build that reaches the network
 *     through code the scan cannot see is not observable here.
 *   - Installed content is bounded by the shared input caps; installations that exceed them, or that
 *     rely on hard links/symlinks the reader refuses, are not cacheable (fail-closed).
 * A cache hit is therefore only valid under the opt-in containment and these rules; the invalidation
 * suite and the no-cache switch stay close for exactly this reason.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  canonical, coversPosix, MigrationPathSchema, parseMigrationConfig, parseProjectCheckReport, ProjectCheckReportSchema,
  pathSegments, type MigrationConfig, type NativeCheckResult, type ProjectCheckReport, type ProjectPreflight,
} from '@migration-harness/core';
import { collectMigrationReference } from './migration-reference.js';
import { resolveExecutable } from './process-tree.js';
import { parseProjectCheckConfig, runProjectChecks } from './project-checks.js';

type Side = 'source' | 'target';
type Command = MigrationConfig['source']['commands'][number];
type Check = MigrationConfig['checks'][number];

/** Format + identification-logic version. Any change invalidates every entry. */
export const BUILD_CACHE_PROTOCOL = 'migration-harness-build-cache/2';
/**
 * Opt-in switch. The cache is **disabled by default**: only `=1` enables it. Without it no probe,
 * restore or publish happens and the cycle is byte-identical to having no cache.
 */
export const BUILD_CACHE_ENABLE_ENV = 'MIGRATION_HARNESS_BUILD_CACHE';
/** A/B switch: `=1` forces the no-cache path even when opted in, kept available for comparison. */
export const BUILD_CACHE_DISABLE_ENV = 'MIGRATION_HARNESS_DISABLE_BUILD_CACHE';
/**
 * Effective environment of a project command, mirroring the spawn contract of
 * `project-checks.execute`. The digest — never the values — joins the identity, so a secret value
 * can never appear in the public key. `tests/cache-build-contract.test.mjs` fails if the two lists drift.
 */
export const BUILD_CACHE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'] as const;
const ENV_CONSTANTS: Record<string, string> = { CI: '1', NO_COLOR: '1' };

const MAX_INPUT_FILES = 20_000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INSTALL_ROOTS = 8;
const MAX_DECLARED_DEPENDENCIES = 1000;
const MAX_CACHE_ENTRIES = 64;
const MAX_SCAN_FILES = 64;
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const SCRIPT_EXTENSIONS = ['.mjs', '.cjs', '.js', '.mts', '.cts', '.ts', '.tsx', '.jsx'];
/**
 * Network APIs a build entry (or a local script it imports) may use. This is deliberately a bounded
 * heuristic, not a proof of network isolation; anything it cannot see is a declared limit.
 */
const NETWORK_INDICATOR = /(?:^|[^\w$.])fetch\s*\(|\bXMLHttpRequest\b|\bEventSource\b|navigator\s*\.\s*sendBeacon|(?:from|require\s*\(\s*)['"](?:node:)?(?:http|https|net|dgram|tls|dns|http2)['"]/;
const LOCAL_IMPORT = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
const MANIFEST_NAME = 'manifest.json';
const ENTRY_FILES_DIR = 'files';
const HEX64 = /^[a-f0-9]{64}$/;
const CACHE_DIRECTORY = '.migration-harness';

/** Lockfiles this identity can pair with an installation it can also inventory. */
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
/** Dependency ecosystems resolved outside the workspace (global stores, remote registries). */
const FOREIGN_MANIFESTS = new Set(['composer.json', 'composer.lock', 'requirements.txt', 'Pipfile', 'Pipfile.lock',
  'pyproject.toml', 'poetry.lock', 'Gemfile', 'Gemfile.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mix.exs',
  'pubspec.yaml', 'Podfile', 'Podfile.lock']);
const FOREIGN_MANIFEST_PATTERN = /\.(?:csproj|fsproj|vbproj|sln|nuspec)$/i;
/** Package-manager state files that describe an installation independently of the lockfile. */
const INSTALL_STATE_FILES = new Set(['.package-lock.json', '.modules.yaml', '.yarn-integrity', '.yarn-state.yml']);
/**
 * Commands that resolve inputs from the network (or from VCS state excluded from the walk).
 * `npm|pnpm|yarn|bun run <script>` stays cacheable: the script's own inputs are workspace files.
 */
const NETWORK_TOOLS = new Set(['curl', 'wget', 'git', 'docker', 'npx', 'pip', 'pip3', 'poetry', 'composer',
  'mvn', 'gradle', 'gradlew', 'cargo', 'go', 'gem', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'nuget']);
/** Package managers: cacheable only through a script invocation, never through an install verb. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const INSTALL_VERBS = new Set(['add', 'ci', 'exec', 'fetch', 'i', 'install', 'pull', 'update', 'upgrade', 'dlx']);

export interface BuildCacheFingerprint { path: string; sha256: string; bytes: number }

export interface BuildCacheToolchain {
  executable: string; path: string; bytes: number; mtimeMs: number; runtime: string;
}

export interface BuildCacheInstallRoot {
  path: string; state: 'ABSENT' | 'MANAGED'; states: BuildCacheFingerprint[];
  entries: string[]; dots: string[]; bin: Array<{ name: string; value: string }>;
  direct: Array<{ name: string; version: string; sha256?: string }>;
  /** Content bytes of every managed entry (bounded); an entry whose content cannot be read is not cacheable. */
  content: BuildCacheFingerprint[];
}

export interface BuildCacheIdentityDocument {
  protocol: string;
  platform: { os: string; arch: string };
  /** Digest of the absolute workspace: path-embedding builds must not be reused across roots. */
  workspace: string;
  side: Side;
  projectRoot: string;
  command: { id: string; kind: string; argv: string[]; cwd: string; timeoutMs: number };
  toolchain: BuildCacheToolchain;
  /** Digest of the effective command environment; values never leave this process. */
  env: string;
  outputs: { dir: string; excluded: string[] };
  inputs: { files: BuildCacheFingerprint[]; shared: BuildCacheFingerprint[]; declaredRoots: BuildCacheFingerprint[]; fileCount: number; totalBytes: number };
  dependencies: { lockfiles: BuildCacheFingerprint[]; declaresDependencies: boolean; install: BuildCacheInstallRoot[] };
}

export interface BuildCacheIdentity { key: string; document: BuildCacheIdentityDocument }

export type BuildCacheAssessment =
  | { cacheable: false; reason: string }
  | { cacheable: true; identity: BuildCacheIdentity; outputDir: string };

export interface BuildCacheManifest {
  kind: 'MIGRATION_BUILD_CACHE_ENTRY'; version: '1'; protocol: string; key: string;
  identity: BuildCacheIdentityDocument;
  output: { buildHash: string; totalBytes: number; files: BuildCacheFingerprint[] };
  recorded: { at: string; durationMs: number; exitCode: number; stdoutBytes: number; stderrBytes: number };
}

export type BuildCacheSidePlan =
  | { status: 'DISABLED' | 'NO_BUILD' | 'NOT_CACHEABLE'; reason?: string }
  | { status: 'MISS'; reason: string; identity: BuildCacheIdentity }
  | { status: 'HIT'; reason?: string; identity: BuildCacheIdentity; entry: string; manifest: BuildCacheManifest };

export interface BuildCacheSideReport {
  status: 'DISABLED' | 'NO_BUILD' | 'NOT_CACHEABLE' | 'MISS' | 'HIT' | 'HIT_NOT_APPLIED';
  reason?: string;
  /** Publication outcome for a miss: `PUBLISHED`, `REUSED`, or why nothing was stored. */
  publish?: string;
}

/** Thrown internally when an input cannot be identified; never escapes `assessBuildCache`. */
class NotCacheableError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'NotCacheableError'; }
}
/** Thrown when a stored artifact does not match its manifest; callers downgrade it to a miss. */
export class BuildCacheRestoreError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'BuildCacheRestoreError'; }
}

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const posix = (path: string): string => path.split(sep).join('/');
const byPath = (left: BuildCacheFingerprint, right: BuildCacheFingerprint): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };

/** Whether this process runs with the no-cache path forced (A/B switch, always available). */
export function buildCacheDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BUILD_CACHE_DISABLE_ENV] === '1';
}

/**
 * Whether the build cache was explicitly opted in. Disabled by default; the A/B force-off always
 * wins. When this is false no probe, restore or publish runs.
 */
export function buildCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !buildCacheDisabled(env) && env[BUILD_CACHE_ENABLE_ENV] === '1';
}

/** The exact environment a project command receives; shared by identity and drift tests. */
export function effectiveCommandEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const effective: Record<string, string> = { ...ENV_CONSTANTS };
  for (const key of BUILD_CACHE_ENV_KEYS) if (env[key] !== undefined) effective[key] = env[key]!;
  return effective;
}

function notCacheable(reason: string): never { throw new NotCacheableError(reason); }

/**
 * Wrap the caller's abort check so that cancellation keeps its own meaning: every guard below is
 * fail-closed (anything unexplainable becomes "not cacheable"), but an error raised by the abort
 * check itself is re-thrown unchanged instead of being downgraded to a cache decision.
 */
function withAbortPropagation(checkAbort?: () => void): { guard?: () => void; escaped: (error: unknown) => boolean } {
  let escaped: unknown;
  const guard = checkAbort ? (): void => {
    try { checkAbort(); } catch (error) { escaped = error; throw error; }
  } : undefined;
  return { ...(guard ? { guard } : {}), escaped: error => escaped !== undefined && error === escaped };
}

/** Hidden or credential-shaped input: never read, never hashed, therefore never cacheable. */
function hiddenInput(path: string): boolean {
  const segments = path.split('/');
  return segments.some(segment => segment === '.migration-private' || segment === '.git')
    || /(?:^|\/)\.env(?:\.|$)/.test(path) || /(?:^|\/)(?:\.npmrc|\.pypirc)$/.test(path)
    || /(?:^|\/)[^/]*\.(?:pem|key)$/i.test(path) || !MigrationPathSchema.safeParse(path).success;
}

interface WalkState {
  files: BuildCacheFingerprint[];
  shared: BuildCacheFingerprint[];
  declaredRoots: BuildCacheFingerprint[];
  lockfiles: BuildCacheFingerprint[];
  installRoots: string[];
  declared: Set<string>;
  declaresDependencies: boolean;
  fileCount: number;
  totalBytes: number;
  checkAbort?: () => void;
}

async function fingerprintFile(absolute: string, logical: string, state: WalkState): Promise<BuildCacheFingerprint> {
  let handle;
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return notCacheable('INPUT_UNREADABLE'); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) notCacheable('UNSUPPORTED_INPUT_ENTRY');
    if (before.nlink !== 1) notCacheable('HARD_LINK_IN_INPUTS');
    if (before.size > MAX_INPUT_FILE_BYTES) notCacheable('INPUT_FILE_TOO_LARGE');
    if (state.fileCount >= MAX_INPUT_FILES || state.totalBytes + before.size > MAX_INPUT_BYTES) notCacheable('INPUT_SIZE_LIMIT');
    const buffer = Buffer.alloc(before.size);
    let used = 0;
    while (used < buffer.length) {
      const read = await handle.read(buffer, used, buffer.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await handle.stat();
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      notCacheable('INPUT_CHANGED_DURING_READ');
    }
    state.fileCount++; state.totalBytes += used;
    return { path: logical, sha256: sha256(buffer.subarray(0, used)), bytes: used };
  } catch (error) {
    if (error instanceof NotCacheableError) throw error;
    throw new NotCacheableError('INPUT_UNREADABLE');
  } finally { await handle.close().catch(() => undefined); }
}

/** Parse a walked package manifest and record what the project declares as dependencies. */
async function readDeclaredDependencies(absolute: string, state: WalkState): Promise<void> {
  let raw: string;
  try { raw = await readFile(absolute, 'utf8'); } catch { return notCacheable('DEPENDENCY_MANIFEST_UNKNOWN'); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return notCacheable('DEPENDENCY_MANIFEST_UNKNOWN'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) notCacheable('DEPENDENCY_MANIFEST_UNKNOWN');
  const manifest = parsed as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const table = manifest[field];
    if (table === undefined) continue;
    if (!table || typeof table !== 'object' || Array.isArray(table)) notCacheable('DEPENDENCY_MANIFEST_UNKNOWN');
    for (const [name, range] of Object.entries(table as Record<string, unknown>)) {
      if (typeof range !== 'string') notCacheable('DEPENDENCY_MANIFEST_UNKNOWN');
      if (!name) notCacheable('DEPENDENCY_MANIFEST_UNKNOWN');
      state.declared.add(name);
      state.declaresDependencies = true;
      // Only registry-resolved ranges are fixed by the lockfile + installation. Anything else
      // (workspace:, link:, file:, git+, URLs, patches) points outside that identity.
      if (!/^(?:npm:)?(?:[\^~]?\d|\*|latest|next)/.test(range.trim())) notCacheable('DEPENDENCY_NOT_IDENTIFIABLE');
    }
  }
}

async function walkProject(sideRoot: string, excludes: string[], state: WalkState): Promise<void> {
  const visit = async (directory: string, prefix: string): Promise<void> => {
    state.checkAbort?.();
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      state.checkAbort?.();
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === '.git' && entry.isDirectory()) continue;
      // Both spellings are declared POSIX-relative (walk prefix + exclusionPrefixes), so the
      // shared coversPosix decides membership instead of a hardcoded separator literal.
      if (excludes.some(item => coversPosix(item, path))) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory() && entry.name === 'node_modules') {
        if (state.installRoots.length >= MAX_INSTALL_ROOTS) notCacheable('INSTALL_ROOTS_LIMIT');
        state.installRoots.push(absolute);
        continue;
      }
      if (hiddenInput(path)) notCacheable('HIDDEN_INPUT');
      if (entry.isSymbolicLink()) notCacheable('LINK_IN_INPUTS');
      if (entry.isDirectory()) { await visit(absolute, path); continue; }
      if (!entry.isFile()) notCacheable('UNSUPPORTED_INPUT_ENTRY');
      const fingerprint = await fingerprintFile(absolute, path, state);
      state.files.push(fingerprint);
      if (LOCKFILES.has(entry.name)) state.lockfiles.push(fingerprint);
      else if (entry.name === 'package.json') await readDeclaredDependencies(absolute, state);
      else if (FOREIGN_MANIFESTS.has(entry.name) || FOREIGN_MANIFEST_PATTERN.test(entry.name)) notCacheable('DEPENDENCY_MANIFEST_UNKNOWN');
    }
  };
  await visit(sideRoot, '');
}

/**
 * Workspace files the project can reach but that live above its root: lockfiles and shared
 * configuration of a monorepo. Only files at these levels are fingerprinted — sibling directories
 * (the other application, harness artifacts, evaluation fixtures) are deliberately out of scope,
 * so harness output never destabilizes the key.
 */
async function walkShared(sideRoot: string, workspace: string, state: WalkState): Promise<void> {
  let current = sideRoot;
  while (current !== workspace) {
    const parent = dirname(current);
    if (parent !== workspace && !inside(workspace, parent)) break;
    state.checkAbort?.();
    const entries = (await readdir(parent, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(parent, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          if (state.installRoots.length >= MAX_INSTALL_ROOTS) notCacheable('INSTALL_ROOTS_LIMIT');
          state.installRoots.push(absolute);
        }
        continue;
      }
      const path = posix(relative(workspace, absolute));
      if (entry.isSymbolicLink()) notCacheable('LINK_IN_INPUTS');
      if (hiddenInput(path)) notCacheable('HIDDEN_INPUT');
      if (!entry.isFile()) notCacheable('UNSUPPORTED_INPUT_ENTRY');
      const fingerprint = await fingerprintFile(absolute, path, state);
      state.shared.push(fingerprint);
      if (LOCKFILES.has(entry.name)) state.lockfiles.push(fingerprint);
      else if (entry.name === 'package.json') await readDeclaredDependencies(absolute, state);
      else if (FOREIGN_MANIFESTS.has(entry.name) || FOREIGN_MANIFEST_PATTERN.test(entry.name)) notCacheable('DEPENDENCY_MANIFEST_UNKNOWN');
    }
    if (parent === workspace) break;
    current = parent;
  }
}

/**
 * Config-declared roots that live **outside** the side's project root (a sibling fixture root or the
 * critical contract). The project walk excludes them by design, so a build that reads one would be
 * invisible; fingerprinting them here is conservative — an extra miss is safe, a false hit is not.
 * Only declared roots are covered: an undeclared sibling read cannot be seen from the configuration
 * and stays a reported limit (the cache is opt-in for exactly this reason).
 */
async function walkDeclaredRoots(config: MigrationConfig, side: Side, workspace: string, sideRoot: string, state: WalkState): Promise<void> {
  const roots = new Map<string, string>();
  const consider = (workspaceRelative: string): void => {
    const absolute = resolve(workspace, workspaceRelative);
    if (absolute !== sideRoot && !inside(sideRoot, absolute)) roots.set(absolute, workspaceRelative);
  };
  for (const scenario of config.scenarios) consider(scenario.fixtureRoot);
  if (config.criticalContract) consider(config.criticalContract.path);

  const visit = async (absolute: string, prefix: string): Promise<void> => {
    state.checkAbort?.();
    const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : notCacheable('INPUT_UNREADABLE'));
    if (!stat) return;
    if (stat.isSymbolicLink()) notCacheable('LINK_IN_INPUTS');
    if (hiddenInput(prefix)) notCacheable('HIDDEN_INPUT');
    if (stat.isFile()) { state.declaredRoots.push(await fingerprintFile(absolute, prefix, state)); return; }
    if (!stat.isDirectory()) notCacheable('UNSUPPORTED_INPUT_ENTRY');
    const entries = (await readdir(absolute, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      state.checkAbort?.();
      const childAbsolute = join(absolute, entry.name);
      const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === '.git' && entry.isDirectory()) continue;
      if (entry.isDirectory() && entry.name === 'node_modules') {
        if (state.installRoots.length >= MAX_INSTALL_ROOTS) notCacheable('INSTALL_ROOTS_LIMIT');
        state.installRoots.push(childAbsolute);
        continue;
      }
      if (hiddenInput(childPath)) notCacheable('HIDDEN_INPUT');
      if (entry.isSymbolicLink()) notCacheable('LINK_IN_INPUTS');
      if (entry.isDirectory()) { await visit(childAbsolute, childPath); continue; }
      if (!entry.isFile()) notCacheable('UNSUPPORTED_INPUT_ENTRY');
      state.declaredRoots.push(await fingerprintFile(childAbsolute, childPath, state));
    }
  };
  for (const [absolute, prefix] of [...roots].sort((left, right) => left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)) {
    await visit(absolute, prefix);
  }
}

/**
 * Content of one managed install entry. The entry inventory alone does not detect a post-install edit
 * that leaves every manifest/state file untouched, so the actual bytes are fingerprinted (bounded by
 * the shared input caps; anything unreadable fails closed). Symlinked entries are resolved inside the
 * install root first, the same boundary `inventoryInstall` already enforces for declared dependencies.
 */
async function fingerprintInstalledTree(absolute: string, logical: string, state: WalkState, out: BuildCacheFingerprint[]): Promise<void> {
  state.checkAbort?.();
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : notCacheable('INSTALL_UNIDENTIFIABLE'));
  if (!stat) return;
  if (stat.isSymbolicLink()) notCacheable('LINK_IN_INPUTS');
  if (hiddenInput(logical)) notCacheable('HIDDEN_INPUT');
  if (stat.isFile()) { out.push(await fingerprintFile(absolute, logical, state)); return; }
  if (!stat.isDirectory()) notCacheable('INSTALL_ENTRY_UNKNOWN');
  const entries = (await readdir(absolute, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    state.checkAbort?.();
    const childAbsolute = join(absolute, entry.name);
    const childLogical = `${logical}/${entry.name}`;
    if (hiddenInput(childLogical)) notCacheable('HIDDEN_INPUT');
    if (entry.isSymbolicLink()) notCacheable('LINK_IN_INPUTS');
    if (entry.isDirectory()) { await fingerprintInstalledTree(childAbsolute, childLogical, state, out); continue; }
    if (!entry.isFile()) notCacheable('UNSUPPORTED_INPUT_ENTRY');
    out.push(await fingerprintFile(childAbsolute, childLogical, state));
  }
}

/** Resolve one local relative import the way Node would for the script extensions we scan. */
async function resolveLocalImport(base: string, specifier: string): Promise<string | undefined> {
  const target = resolve(base, specifier);
  for (const candidate of [target, ...SCRIPT_EXTENSIONS.map(extension => `${target}${extension}`),
    ...SCRIPT_EXTENSIONS.map(extension => join(target, `index${extension}`))]) {
    const stat = await lstat(candidate).catch(() => undefined);
    if (stat?.isFile()) return candidate;
  }
  return undefined;
}

/**
 * Conservative network eligibility: a build entry (or a local script it imports) that names a network
 * API cannot be proven to have only workspace inputs, so it is not cacheable. Bounded and best-effort
 * — see the module doc-comment for the declared limit.
 */
async function scriptReachesNetwork(entry: string, seen: Set<string>): Promise<boolean> {
  if (seen.size >= MAX_SCAN_FILES) return false;
  const absolute = await realpath(entry).catch(() => undefined);
  if (!absolute || seen.has(absolute)) return false;
  seen.add(absolute);
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat?.isFile() || stat.size > MAX_SCAN_FILE_BYTES) return false;
  const text = await readFile(absolute, 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  if (NETWORK_INDICATOR.test(text)) return true;
  const base = dirname(absolute);
  for (const match of text.matchAll(LOCAL_IMPORT)) {
    const resolved = await resolveLocalImport(base, match[1]!);
    if (resolved && await scriptReachesNetwork(resolved, seen)) return true;
  }
  return false;
}

/** Whether any script the build command starts (a script file, not the toolchain) reaches the network. */
async function networkInCommand(command: Command, cwd: string): Promise<boolean> {
  const seen = new Set<string>();
  for (const token of command.argv.slice(1)) {
    if (token.startsWith('-') || /^[a-z]+:\/\//i.test(token)) continue;
    if (!SCRIPT_EXTENSIONS.some(extension => token.endsWith(extension))) continue;
    const absolute = isAbsolute(token) ? token : resolve(cwd, token);
    if (await scriptReachesNetwork(absolute, seen)) return true;
  }
  return false;
}

async function resolveProjectDir(workspace: string, segments: string[], allowMissingTail: boolean): Promise<string> {
  let current = workspace;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : notCacheable('INPUT_UNREADABLE'));
    if (!stat) {
      if (allowMissingTail && index === segments.length - 1) return current;
      notCacheable('CWD_UNAVAILABLE');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) notCacheable('CWD_UNAVAILABLE');
  }
  return current;
}

/**
 * Fingerprint the installation a project actually uses: the package manager's own state, the
 * installed entry inventory and the installed version of every declared dependency. This — not the
 * lockfile alone — is what detects a node_modules that diverged from its lockfile.
 *
 * A directory holding nothing but this harness' own cache is not an installation and is omitted,
 * so creating the cache never changes the identity it is stored under.
 */
async function inventoryInstall(absolute: string, workspace: string, declared: Set<string>, state: WalkState): Promise<BuildCacheInstallRoot | undefined> {
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) notCacheable('INSTALL_UNIDENTIFIABLE');
  const names = await readdir(absolute);
  if (!names.some(name => name !== CACHE_DIRECTORY)) return undefined;
  const entries = names.filter(name => name !== CACHE_DIRECTORY && !name.startsWith('.')).sort();
  const dots = names.filter(name => name !== CACHE_DIRECTORY && name.startsWith('.')).sort();
  const root: BuildCacheInstallRoot = { path: posix(relative(workspace, absolute)), state: entries.length ? 'MANAGED' : 'ABSENT', states: [], entries, dots, bin: [], direct: [], content: [] };
  for (const name of dots) {
    if (!INSTALL_STATE_FILES.has(name)) continue;
    root.states.push(await fingerprintFile(join(absolute, name), `${root.path}/${name}`, state));
  }
  if (entries.length && !root.states.length) notCacheable('INSTALL_STATE_MISSING');
  if (dots.includes('.bin')) {
    const bin = join(absolute, '.bin');
    for (const name of (await readdir(bin)).sort()) {
      const target = join(bin, name);
      const link = await lstat(target).catch(() => undefined);
      if (!link) continue;
      root.bin.push(link.isSymbolicLink()
        ? { name, value: `link:${await readlink(target)}` }
        : { name, value: `sha256:${await fingerprintFile(target, `${root.path}/.bin/${name}`, state).then(item => item.sha256)}` });
    }
  }
  // The entry inventory plus per-dependency manifests do not see a post-install edit that leaves
  // every manifest/state file untouched; the entry content does. Symlinked entries (pnpm/workspace
  // layouts) are resolved inside this root first, mirroring the declared-dependency boundary below.
  const content: BuildCacheFingerprint[] = [];
  for (const name of entries) {
    const target = join(absolute, ...name.split('/'));
    const installed = await lstat(target).catch(() => undefined);
    if (!installed) continue;
    if (installed.isSymbolicLink()) {
      const store = await realpath(absolute).catch(() => undefined);
      const resolved = await realpath(target).catch(() => undefined);
      if (!store || !resolved || !inside(store, resolved)) notCacheable('INSTALL_UNIDENTIFIABLE');
      await fingerprintInstalledTree(resolved, `${root.path}/${name}`, state, content);
    } else {
      await fingerprintInstalledTree(target, `${root.path}/${name}`, state, content);
    }
  }
  root.content = [...content].sort(byPath);
  for (const name of [...declared].sort()) {
    const target = join(absolute, ...name.split('/'));
    const installed = await lstat(target).catch(() => undefined);
    if (!installed) { root.direct.push({ name, version: 'ABSENT' }); continue; }
    let manifestPath = join(target, 'package.json');
    if (installed.isSymbolicLink()) {
      // pnpm and workspace layouts link installed entries; the content must stay inside this root.
      const store = await realpath(absolute).catch(() => undefined);
      const resolved = await realpath(target).catch(() => undefined);
      if (!store || !resolved || !inside(store, resolved)) notCacheable('INSTALL_UNIDENTIFIABLE');
      manifestPath = join(resolved, 'package.json');
    } else if (!installed.isDirectory()) notCacheable('INSTALL_ENTRY_UNKNOWN');
    let raw: string;
    try { raw = await readFile(manifestPath, 'utf8'); } catch { notCacheable('INSTALL_ENTRY_UNKNOWN'); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { notCacheable('INSTALL_ENTRY_UNKNOWN'); }
    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version !== 'string' || !version) notCacheable('INSTALL_ENTRY_UNKNOWN');
    root.direct.push({ name, version, sha256: sha256(raw) });
  }
  return root;
}

/** Fingerprint argv[0] the way spawn resolves it; an unresolvable toolchain is not cacheable. */
async function toolchainOf(argv0: string, cwd: string): Promise<BuildCacheToolchain> {
  const executable = resolveExecutable(argv0);
  const candidates: string[] = [];
  const names = process.platform === 'win32' && !/\.[a-z]{1,5}$/i.test(executable)
    ? [executable, ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(ext => `${executable}${ext}`)]
    : [executable];
  if (isAbsolute(executable)) candidates.push(executable);
  else if (/[/\\]/.test(executable)) candidates.push(resolve(cwd, executable));
  else for (const directory of (process.env.PATH ?? '').split(delimiter)) if (directory) for (const name of names) candidates.push(join(directory, name));
  for (const candidate of candidates) {
    const stat = await lstat(candidate).catch(() => undefined);
    if (stat?.isFile()) return { executable: argv0, path: sha256(posix(candidate)), bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), runtime: process.version };
  }
  return notCacheable('TOOLCHAIN_UNRESOLVED');
}

/** Commands whose inputs are not confined to this workspace: network or excluded VCS state. */
function networkReference(argv: string[]): string | undefined {
  if (argv.some(value => /^https?:\/\//i.test(value))) return 'NETWORK_REFERENCE';
  const tool = (argv[0] ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.(?:cmd|exe|bat)$/i, '');
  if (!tool) return 'NETWORK_REFERENCE';
  if (PACKAGE_MANAGERS.has(tool)) {
    // `npm run build` / `yarn build` execute a script whose inputs are workspace files;
    // `npm` alone, `npm ci`, `pnpm dlx` resolve from the network.
    if (argv.length < 2) return 'NETWORK_REFERENCE';
    return argv.slice(1).some(value => INSTALL_VERBS.has(value)) ? 'NETWORK_REFERENCE' : undefined;
  }
  return NETWORK_TOOLS.has(tool) ? 'NETWORK_REFERENCE' : undefined;
}

/** Excluded subtrees: generated output, declared generated paths and evaluation fixtures. */
function exclusionPrefixes(config: MigrationConfig, side: Side, workspace: string): string[] {
  const project = config[side];
  const prefixes = new Set<string>();
  if (project.build) prefixes.add(posix(project.build.outputDir));
  for (const generated of project.generatedPaths ?? []) prefixes.add(posix(generated));
  const sideRoot = join(workspace, ...pathSegments(project.root));
  const add = (workspaceRelative: string): void => {
    const absolute = join(workspace, ...pathSegments(workspaceRelative));
    if (absolute === sideRoot) return;
    const rel = relative(sideRoot, absolute);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) prefixes.add(posix(rel));
  };
  for (const scenario of config.scenarios) add(scenario.fixtureRoot);
  if (config.criticalContract) add(config.criticalContract.path);
  return [...prefixes].sort();
}

/**
 * Compute the full identity of one side's managed build, or explain why it is not cacheable.
 * Read-only: this function never writes. Failures of any kind resolve to `cacheable: false`,
 * which callers treat exactly like having no cache at all.
 */
export async function assessBuildCache(input: {
  config: unknown; workspaceRoot: string; side: Side;
  platform?: { os: string; arch: string };
  /** Effective command environment; defaults to the spawn contract of `project-checks.execute`. */
  env?: Record<string, string>;
  /** Executable fingerprint; defaults to how spawn would resolve argv[0] from the command cwd. */
  toolchain?: BuildCacheToolchain;
  checkAbort?: () => void;
}): Promise<BuildCacheAssessment> {
  const abort = withAbortPropagation(input.checkAbort);
  try {
    const config = parseMigrationConfig(input.config);
    const build = config[input.side].build;
    if (!build) notCacheable('NO_BUILD');
    const workspace = await realpath(resolve(input.workspaceRoot));
    const project = config[input.side];
    const command = project.commands.find(item => item.id === build.commandId);
    if (!command || command.kind !== 'build') notCacheable('NO_BUILD');
    const network = networkReference(command.argv);
    if (network) notCacheable(network);

    const sideRoot = await resolveProjectDir(workspace, pathSegments(project.root), false);
    const cwdSegments = [...pathSegments(project.root), ...(command.cwd === '.' ? [] : pathSegments(command.cwd))];
    const cwd = await resolveProjectDir(workspace, cwdSegments, false);
    const outputDir = await resolveProjectDir(workspace, [...pathSegments(project.root), ...pathSegments(build.outputDir)], true);

    // argv naming a network tool is already refused above; this additionally refuses a build entry
    // (or a local script it imports) that reaches the network through code argv cannot show.
    if (await networkInCommand(command, cwd)) notCacheable('NETWORK_REFERENCE');

    const state: WalkState = { files: [], shared: [], declaredRoots: [], lockfiles: [], installRoots: [], declared: new Set(),
      declaresDependencies: false, fileCount: 0, totalBytes: 0,
      ...(abort.guard ? { checkAbort: abort.guard } : {}) };
    const excludes = exclusionPrefixes(config, input.side, workspace);
    await walkProject(sideRoot, excludes, state);
    await walkShared(sideRoot, workspace, state);
    await walkDeclaredRoots(config, input.side, workspace, sideRoot, state);
    if (state.fileCount >= MAX_INPUT_FILES || state.totalBytes > MAX_INPUT_BYTES) notCacheable('INPUT_SIZE_LIMIT');
    if (state.declared.size > MAX_DECLARED_DEPENDENCIES) notCacheable('DEPENDENCY_LIMIT');
    if (state.declaresDependencies && !state.lockfiles.length) notCacheable('LOCKFILE_MISSING');
    const install: BuildCacheInstallRoot[] = [];
    for (const root of [...state.installRoots].sort()) {
      const inventoried = await inventoryInstall(root, workspace, state.declared, state);
      if (inventoried) install.push(inventoried);
    }
    if (state.declaresDependencies && !install.some(root => root.state === 'MANAGED')) notCacheable('INSTALL_MISSING');

    const toolchain = input.toolchain ?? await toolchainOf(command.argv[0]!, cwd);
    const document: BuildCacheIdentityDocument = {
      protocol: BUILD_CACHE_PROTOCOL,
      platform: input.platform ?? { os: process.platform, arch: process.arch },
      workspace: sha256(workspace),
      side: input.side,
      projectRoot: project.root,
      command: { id: command.id, kind: command.kind, argv: [...command.argv],
        cwd: cwdSegments.join('/'), timeoutMs: command.timeoutMs },
      toolchain,
      env: digest(input.env ?? effectiveCommandEnv()),
      outputs: { dir: build.outputDir, excluded: excludes },
      inputs: { files: [...state.files].sort(byPath), shared: [...state.shared].sort(byPath),
        declaredRoots: [...state.declaredRoots].sort(byPath), fileCount: state.fileCount, totalBytes: state.totalBytes },
      dependencies: { lockfiles: [...state.lockfiles].sort(byPath), declaresDependencies: state.declaresDependencies, install },
    };
    return { cacheable: true, identity: { key: digest(document), document }, outputDir };
  } catch (error) {
    if (error instanceof NotCacheableError) return { cacheable: false, reason: error.reason };
    if (abort.escaped(error)) throw error;
    return { cacheable: false, reason: 'IDENTITY_UNAVAILABLE' };
  }
}

/** `<workspace>/node_modules/.migration-harness/build-cache` — invisible to scope snapshots and git. */
export function buildCacheRoot(workspace: string): string {
  return join(workspace, 'node_modules', CACHE_DIRECTORY, 'build-cache');
}

/** Create (or validate) the cache root; anything unsafe or unwritable resolves to `undefined`. */
async function ensureCacheRoot(workspace: string): Promise<string | undefined> {
  try {
    const base = join(workspace, 'node_modules');
    const existing = await lstat(base).catch(() => undefined);
    if (existing?.isSymbolicLink()) return undefined;
    const root = buildCacheRoot(workspace);
    await mkdir(root, { recursive: true });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return root;
  } catch { return undefined; }
}

function parseManifest(value: unknown, key: string): BuildCacheManifest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const manifest = value as Partial<BuildCacheManifest>;
  if (manifest.kind !== 'MIGRATION_BUILD_CACHE_ENTRY' || manifest.version !== '1') return undefined;
  if (manifest.protocol !== BUILD_CACHE_PROTOCOL || typeof manifest.key !== 'string' || manifest.key !== key) return undefined;
  if (!manifest.identity || typeof manifest.identity !== 'object') return undefined;
  const output = manifest.output;
  if (!output || typeof output.buildHash !== 'string' || !HEX64.test(output.buildHash)
    || !Number.isInteger(output.totalBytes) || (output.totalBytes as number) < 0 || !Array.isArray(output.files) || !output.files.length) return undefined;
  for (const file of output.files) {
    if (!file || typeof file.path !== 'string' || !MigrationPathSchema.safeParse(file.path).success
      || typeof file.sha256 !== 'string' || !HEX64.test(file.sha256)
      || !Number.isInteger(file.bytes) || (file.bytes as number) < 0) return undefined;
  }
  if (digest(output.files) !== output.buildHash) return undefined;
  const recorded = manifest.recorded;
  if (!recorded || typeof recorded.at !== 'string' || !Number.isInteger(recorded.durationMs) || (recorded.durationMs as number) < 0
    || !Number.isInteger(recorded.exitCode) || !Number.isInteger(recorded.stdoutBytes) || (recorded.stdoutBytes as number) < 0
    || !Number.isInteger(recorded.stderrBytes) || (recorded.stderrBytes as number) < 0) return undefined;
  return manifest as BuildCacheManifest;
}

export type BuildCacheProbe = { status: 'HIT'; entry: string; manifest: BuildCacheManifest } | { status: 'MISS'; reason: string };

/**
 * Look up an entry for an identity. Only the manifest is verified here; output bytes are
 * verified while they are consumed (restore) and again before a publication is accepted,
 * so a corrupt entry can never produce a hit that serves wrong bytes.
 */
export async function probeBuildCache(identity: BuildCacheIdentity, workspace: string): Promise<BuildCacheProbe> {
  const root = await ensureCacheRoot(workspace);
  if (!root) return { status: 'MISS', reason: 'CACHE_ROOT_UNAVAILABLE' };
  const entry = join(root, identity.key);
  let raw: string;
  try { raw = await readFile(join(entry, MANIFEST_NAME), 'utf8'); }
  catch { return { status: 'MISS', reason: 'ABSENT' }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: 'MISS', reason: 'MANIFEST_CORRUPTED' }; }
  const manifest = parseManifest(parsed, identity.key);
  if (!manifest) return { status: 'MISS', reason: 'MANIFEST_CORRUPTED' };
  if (canonical(manifest.identity) !== canonical(identity.document)) return { status: 'MISS', reason: 'IDENTITY_MISMATCH' };
  return { status: 'HIT', entry, manifest };
}

/**
 * Read every byte an entry claims and verify it against the manifest. Shared by consumption
 * (restore) and by publication (an entry that fails here is replaced, never reused), so a
 * corrupt or incomplete entry can never produce a hit and never survives a new publication.
 */
async function readVerifiedEntries(proof: { entry: string; manifest: BuildCacheManifest }): Promise<Array<{ path: string; bytes: Buffer }>> {
  const staged: Array<{ path: string; bytes: Buffer }> = [];
  for (const file of proof.manifest.output.files) {
    if (!MigrationPathSchema.safeParse(file.path).success) throw new BuildCacheRestoreError('OUTPUT_PATH_UNSAFE');
    const absolute = join(proof.entry, ENTRY_FILES_DIR, ...file.path.split('/'));
    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat?.isFile() || stat.size !== file.bytes) throw new BuildCacheRestoreError('OUTPUT_CORRUPTED');
    const bytes = await readFile(absolute).catch(() => undefined);
    if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new BuildCacheRestoreError('OUTPUT_CORRUPTED');
    staged.push({ path: file.path, bytes });
  }
  if (digest(proof.manifest.output.files) !== proof.manifest.output.buildHash) throw new BuildCacheRestoreError('OUTPUT_CORRUPTED');
  return staged;
}

/**
 * Materialize a cached artifact into the freshly cleaned output directory. Every byte is read,
 * size- and hash-checked against the manifest before anything is written, so an incomplete or
 * tampered entry fails here (the caller then rebuilds) instead of serving unattested bytes.
 */
export async function restoreBuildCache(proof: { entry: string; manifest: BuildCacheManifest }, outputDir: string): Promise<void> {
  const staged = await readVerifiedEntries(proof);
  try { await mkdir(outputDir, { recursive: true }); } catch { throw new BuildCacheRestoreError('OUTPUT_UNWRITABLE'); }
  for (const file of staged) {
    const target = join(outputDir, ...file.path.split('/'));
    try {
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, file.bytes);
    } catch { throw new BuildCacheRestoreError('OUTPUT_UNWRITABLE'); }
  }
}

export type BuildCachePublishResult = { status: 'PUBLISHED' | 'REUSED' } | { status: 'SKIPPED' | 'FAILED'; reason: string };

/**
 * Publish one build artifact atomically: a complete temporary directory is renamed into place, so
 * concurrent producers either win the rename or reuse the entry the winner published — a reader
 * only ever observes a complete entry, never a half-written one.
 */
export async function publishBuildCacheSide(input: {
  config: unknown; workspaceRoot: string; side: Side; identity: BuildCacheIdentity;
  output: { files: ReadonlyMap<string, Buffer>; buildHash: string; totalBytes: number };
  recorded: BuildCacheManifest['recorded'];
}): Promise<BuildCachePublishResult> {
  try {
    // Containment: nothing is ever written to the store without an explicit opt-in.
    if (!buildCacheEnabled()) return { status: 'SKIPPED', reason: buildCacheDisabled() ? 'ENV_FLAG' : 'OPT_IN_REQUIRED' };
    const workspace = await realpath(resolve(input.workspaceRoot));
    // Refuse to publish when the build itself moved an input: the artifact no longer matches the
    // identity that requested it.
    const fresh = await assessBuildCache({ config: input.config, workspaceRoot: workspace, side: input.side });
    if (!fresh.cacheable) return { status: 'SKIPPED', reason: `INPUTS_UNIDENTIFIABLE:${fresh.reason}` };
    if (fresh.identity.key !== input.identity.key) return { status: 'SKIPPED', reason: 'INPUTS_CHANGED_DURING_BUILD' };
    const files: BuildCacheFingerprint[] = [...input.output.files].map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length }));
    if (digest(files) !== input.output.buildHash) return { status: 'SKIPPED', reason: 'SNAPSHOT_INCONSISTENT' };
    const root = await ensureCacheRoot(workspace);
    if (!root) return { status: 'FAILED', reason: 'CACHE_ROOT_UNAVAILABLE' };
    const manifest: BuildCacheManifest = { kind: 'MIGRATION_BUILD_CACHE_ENTRY', version: '1',
      protocol: BUILD_CACHE_PROTOCOL, key: input.identity.key, identity: input.identity.document,
      output: { buildHash: input.output.buildHash, totalBytes: input.output.totalBytes, files },
      recorded: input.recorded };
    const entry = join(root, input.identity.key);
    const existing = await probeBuildCache(input.identity, workspace);
    if (existing.status === 'HIT') {
      // Reuse a complete entry; replace one whose bytes disagree with its own manifest.
      const healthy = await readVerifiedEntries(existing).then(() => true, () => false);
      if (healthy) return { status: 'REUSED' };
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
    }
    const temporary = join(root, `tmp-${randomUUID()}`);
    try {
      await mkdir(join(temporary, ENTRY_FILES_DIR), { recursive: true });
      for (const file of files) {
        const target = join(temporary, ENTRY_FILES_DIR, ...file.path.split('/'));
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, input.output.files.get(file.path)!);
      }
      await writeFile(join(temporary, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    } catch {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      return { status: 'FAILED', reason: 'PUBLISH_FAILED' };
    }
    try {
      await rename(temporary, entry);
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      const raced = ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY', 'EACCES'].includes(code);
      if (!raced) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        return { status: 'FAILED', reason: 'PUBLISH_FAILED' };
      }
      // Another producer won the rename between our probe and now: keep its entry when it is
      // complete, otherwise replace it. Neither producer ever leaves a partial entry behind.
      const rival = await probeBuildCache(input.identity, workspace);
      if (rival.status === 'HIT') {
        const healthy = await readVerifiedEntries(rival).then(() => true, () => false);
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        if (healthy) return { status: 'REUSED' };
      }
      await rm(entry, { recursive: true, force: true }).catch(() => undefined);
      let promoted = false;
      try { await rename(temporary, entry); promoted = true; }
      catch { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
      if (!promoted) return { status: 'FAILED', reason: 'PUBLISH_RACE_LOST' };
    }
    await evictOldEntries(root);
    return { status: 'PUBLISHED' };
  } catch { return { status: 'FAILED', reason: 'PUBLISH_FAILED' }; }
}

/** Bound the workspace cache: keep the newest entries, never fail a publication on cleanup. */
async function evictOldEntries(root: string): Promise<void> {
  try {
    const names = await readdir(root, { withFileTypes: true });
    const entries = names.filter(item => item.isDirectory() && HEX64.test(item.name));
    if (entries.length <= MAX_CACHE_ENTRIES) return;
    const stamped = await Promise.all(entries.map(async item => ({
      name: item.name,
      at: await lstat(join(root, item.name)).then(stat => stat.mtimeMs, () => 0),
    })));
    stamped.sort((left, right) => left.at - right.at);
    for (const item of stamped.slice(0, stamped.length - MAX_CACHE_ENTRIES)) {
      await rm(join(root, item.name), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch { /* best effort */ }
}

/** Drop an entry whose build produced different bytes than the entry attests (identity gap). */
export async function invalidateBuildCacheEntry(identity: BuildCacheIdentity, workspace: string): Promise<boolean> {
  try {
    const root = await ensureCacheRoot(workspace);
    if (!root) return false;
    await rm(join(root, identity.key), { recursive: true, force: true });
    return true;
  } catch { return false; }
}

/** Probe (assess + lookup) one side for the current cycle. Read-only except for the cache root. */
export async function planBuildCacheSide(input: {
  config: unknown; workspaceRoot: string; side: Side; checkAbort?: () => void;
}): Promise<BuildCacheSidePlan> {
  // Opt-in by default-off: no probe without `MIGRATION_HARNESS_BUILD_CACHE=1`. The A/B force-off
  // keeps its own reason so callers can tell a deliberate no-cache run from a missing opt-in.
  if (!buildCacheEnabled()) return { status: 'DISABLED', reason: buildCacheDisabled() ? 'ENV_FLAG' : 'OPT_IN_REQUIRED' };
  const abort = withAbortPropagation(input.checkAbort);
  try {
    const assessment = await assessBuildCache({ ...input, ...(abort.guard ? { checkAbort: abort.guard } : {}) });
    if (!assessment.cacheable) return { status: 'NOT_CACHEABLE', reason: assessment.reason };
    const probe = await probeBuildCache(assessment.identity, await realpath(resolve(input.workspaceRoot)));
    return probe.status === 'HIT'
      ? { status: 'HIT', identity: assessment.identity, entry: probe.entry, manifest: probe.manifest }
      : { status: 'MISS', reason: probe.reason, identity: assessment.identity };
  } catch (error) {
    // Fail closed: anything the probe cannot explain is a forced miss, never a hit.
    if (abort.escaped(error)) throw error;
    return { status: 'NOT_CACHEABLE', reason: 'CACHE_UNAVAILABLE' };
  }
}

/* -------------------------------------------------------------------------------------------
 * Report assembly. Cached build rows replace the execution of the managed build command only;
 * every other check still runs through `runProjectChecks`, the single owner of command execution.
 * ----------------------------------------------------------------------------------------- */

/**
 * Preflight input hash over the full configuration, used to close the report of a cache hit.
 * It must stay byte-identical to the private `inputHash` of `project-checks`; the drift check is
 * `tests/cache-build-contract.test.mjs`, which compares it against a real `preflightProjectChecks`.
 */
export async function projectInputHash(config: unknown, workspaceRoot: string): Promise<string> {
  const reference = await collectMigrationReference({ config: parseMigrationConfig(config), workspaceRoot });
  return digest({ source: reference.source.files, target: reference.target.files,
    protectedFiles: reference.target.protectedFiles, criteria: reference.criteria });
}

/** Byte-for-byte mirror of the baseline comparison in `project-checks.runProjectChecks`. */
function baselineComparison(row: NativeCheckResult, baseline: ProjectCheckReport | undefined, phase: 'baseline' | 'candidate'): NativeCheckResult['baselineComparison'] {
  const before = baseline?.checks.find(item => item.checkId === row.checkId && item.commandHash === row.commandHash && item.side === row.side);
  return phase === 'baseline' ? 'BASELINE'
    : !before || before.status === 'INCONCLUSIVE' || row.status === 'INCONCLUSIVE' ? 'NOT_COMPARED'
    : row.status === 'FAIL' ? before.status === 'FAIL' ? 'BASELINE_CHECK_FAILED' : 'NEW_CHECK_FAILURE'
    : before.status === 'FAIL' ? 'RESOLVED' : 'UNCHANGED';
}

export interface BuildCacheCheckRun {
  report: ProjectCheckReport;
  /** True when cached build rows replaced build-command execution for this cycle. */
  applied: boolean;
  satisfiedChecks: number;
  executedChecks: number;
}

/**
 * Run the declared checks, satisfying managed build commands from verified cache entries when the
 * plan says HIT. The report is always assembled for the full configuration: every declared check
 * keeps exactly one row, the preflight is the full-configuration one, and the input hash after the
 * run is recomputed over the full configuration. A hit **recomposes each satisfied build command's
 * own check row** as `status: 'PASS'`, `reason: 'COMPLETED'` with the recorded output sizes instead
 * of executing it, so the qualified guarantee is: every **other** declared check still runs, and the
 * report's shape/preflight/hash stay full-config — not that every row was freshly executed. Any
 * inconsistency falls back to a plain full run; the single exception is the view-schema rule a
 * satisfied build check can vacate (a side left with no required check), which
 * `parseProjectCheckConfig` permits for this view alone — the real configuration schema is never relaxed.
 */
export async function runProjectChecksWithCache(input: {
  config: unknown; workspaceRoot: string; phase: 'baseline' | 'candidate';
  allowProjectCommands?: boolean; baseline?: unknown; signal?: AbortSignal;
  preflight: ProjectPreflight;
  plans: Record<Side, BuildCacheSidePlan>;
}): Promise<BuildCacheCheckRun> {
  const config = parseMigrationConfig(input.config);
  const forward = (candidate: MigrationConfig, withBaseline: boolean, satisfiedView?: { configuration: unknown }): Promise<ProjectCheckReport> => runProjectChecks({
    config: candidate, workspaceRoot: input.workspaceRoot, phase: input.phase,
    ...(satisfiedView ? { satisfiedView } : {}),
    ...(input.allowProjectCommands === undefined ? {} : { allowProjectCommands: input.allowProjectCommands }),
    ...(withBaseline && input.baseline !== undefined ? { baseline: input.baseline } : {}),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const fallback = async (): Promise<BuildCacheCheckRun> =>
    ({ report: await forward(config, true), applied: false, satisfiedChecks: 0, executedChecks: config.checks.length });

  const satisfied = new Map<Check, { command: Command; recorded: BuildCacheManifest['recorded'] }>();
  for (const side of ['source', 'target'] as const) {
    const plan = input.plans[side];
    if (plan.status !== 'HIT') continue;
    const build = config[side].build;
    if (!build) continue;
    const command = config[side].commands.find(item => item.id === build.commandId);
    if (!command) return fallback();
    for (const check of config.checks) if (check.side === side && check.commandId === build.commandId) {
      satisfied.set(check, { command, recorded: plan.manifest.recorded });
    }
  }
  if (!satisfied.size) return fallback();

  const baseline = input.baseline === undefined ? undefined : parseProjectCheckReport(input.baseline);
  const baselineUsable = baseline === undefined || (input.phase === 'candidate' && baseline.phase === 'baseline'
    && baseline.configurationHash === input.preflight.configurationHash && baseline.workspaceHash === input.preflight.workspaceHash
    && baseline.migrationId === config.migrationId && baseline.preflight.status === 'PASS'
    && baseline.inputHashAfter === baseline.preflight.inputHash && !baseline.findings.length);
  if (!baselineUsable) return fallback();

  const remaining = config.checks.filter(check => !satisfied.has(check));
  const rows = new Map<string, NativeCheckResult>();
  let evaluatedAt = new Date().toISOString();
  if (remaining.length) {
    // A view of the configuration without the satisfied build commands: `runProjectChecks` stays
    // the only executor. The view may legitimately empty the required checks of a side (its build
    // check was the only one and it is satisfied from cache) — `parseProjectCheckConfig` grants
    // exactly that permission, and the view carries its full origin (`configuration`) so every
    // hash of the inner run stays a full-configuration hash. Any other schema refusal, and any
    // inconsistency of the run itself, still falls back to a plain full run.
    const stripped = structuredClone(config) as unknown as Record<string, unknown>;
    for (const side of ['source', 'target'] as const) {
      const build = config[side].build;
      if (build && config.checks.some(check => check.side === side && check.commandId === build.commandId && satisfied.has(check))) {
        delete (stripped[side] as Record<string, unknown>).build;
      }
    }
    stripped.checks = config.checks.filter(check => !satisfied.has(check));
    let view: MigrationConfig;
    try { view = parseProjectCheckConfig(stripped, true); } catch { return fallback(); }
    const run = await forward(view, false, { configuration: config });
    if (run.findings.length || run.preflight.status !== 'PASS' || run.checks.length !== remaining.length) return fallback();
    evaluatedAt = run.evaluatedAt;
    for (const row of run.checks) rows.set(row.checkId, row);
  }

  const findings: ProjectCheckReport['findings'] = [];
  if (input.allowProjectCommands !== true) findings.push({ code: 'EXECUTION_NOT_AUTHORIZED' });
  const after = input.preflight.status === 'PASS' ? await projectInputHash(config, input.workspaceRoot).catch(() => undefined) : undefined;
  if (input.preflight.status === 'PASS' && after !== input.preflight.inputHash) findings.push({ code: 'INPUT_CHANGED' });

  const checks: NativeCheckResult[] = [];
  for (const check of config.checks) {
    const cached = satisfied.get(check);
    const row: NativeCheckResult | undefined = cached
      ? { checkId: check.id, side: check.side, required: check.required, commandId: check.commandId,
          commandHash: digest(cached.command), status: 'PASS', reason: 'COMPLETED', exitCode: 0,
          durationMs: cached.recorded.durationMs,
          output: { omitted: true, stdoutBytes: cached.recorded.stdoutBytes, stderrBytes: cached.recorded.stderrBytes },
          baselineComparison: 'NOT_COMPARED' }
      : rows.get(check.id);
    if (!row) return fallback();
    checks.push({ ...row, baselineComparison: baselineComparison(row, baseline, input.phase) });
  }
  const required = checks.filter(row => row.required);
  const status: ProjectCheckReport['status'] = input.preflight.status !== 'PASS' || findings.length
    || required.some(row => row.status === 'INCONCLUSIVE') ? 'INCONCLUSIVE'
    : required.some(row => row.status === 'FAIL') ? 'FAIL' : 'PASS';
  try {
    const report = ProjectCheckReportSchema.parse({ kind: 'PROJECT_CHECK_REPORT', version: '1',
      migrationId: config.migrationId, configurationHash: input.preflight.configurationHash,
      workspaceHash: input.preflight.workspaceHash, phase: input.phase, evaluatedAt, status,
      preflight: input.preflight, ...(after ? { inputHashAfter: after } : {}), findings, checks });
    return { report, applied: true, satisfiedChecks: satisfied.size, executedChecks: config.checks.length - satisfied.size };
  } catch { return fallback(); }
}
