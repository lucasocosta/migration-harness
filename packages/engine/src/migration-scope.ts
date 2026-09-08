import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  canonical, parseMigrationConfig, MigrationPathSchema, MigrationScopeSnapshotSchema,
  type MigrationConfig, type MigrationScopeSnapshot, type ScopeEntry, type ScopeFinding,
} from '@migration-harness/core';

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);
const opaque = (path: string): boolean => !MigrationPathSchema.safeParse(path).success
  || /(?:^|\/)(?:\.npmrc|\.pypirc|[^/]*\.(?:pem|key))$/i.test(path);

export function validateStandardScope(config: MigrationConfig): void {
  if (config.profile !== 'standard') throw new Error('STANDARD_PROFILE_REQUIRED');
  for (const path of config.target.writePaths) {
    if (opaque(path) || path.split('/').includes('node_modules')) throw new Error('UNSAFE_WRITE_SCOPE');
    const full = `${config.target.root}/${path}`;
    if ([...config.scenarios.map(item => item.fixtureRoot), ...(config.criticalContract ? [config.criticalContract.path] : [])]
      .some(item => inside(full, item) || inside(item, full))) throw new Error('EVALUATION_INPUT_IN_WRITE_SCOPE');
  }
}

/** Fingerprint current working-tree bytes, not HEAD. Private entries are opaque metadata and links are never followed. */
export async function snapshotMigrationScope(input: { config: unknown; workspaceRoot: string }): Promise<MigrationScopeSnapshot> {
  const config = parseMigrationConfig(input.config); validateStandardScope(config);
  const workspace = await realpath(resolve(input.workspaceRoot));
  const privateRoot = join(homedir(), '.local/state/migration-harness');
  if (workspace.split('/').includes('.migration-private') || inside(workspace, privateRoot)) throw new Error('PRIVATE_WORKSPACE');
  const result = {} as MigrationScopeSnapshot;
  for (const side of ['source', 'target'] as const) {
    const root = join(workspace, config[side].root);
    if (await realpath(root) !== root) throw new Error('UNSAFE_SCOPE_ROOT');
    const entries: ScopeEntry[] = [];
    const excluded = [...config[side].generatedPaths ?? [], ...(config[side].build ? [config[side].build.outputDir] : [])];
    let totalBytes = 0;
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = join(directory, entry.name);
        if (['.git', 'node_modules'].includes(entry.name) || excluded.some(item => inside(path, item))) continue;
        if (entries.length >= 20000) throw new Error('SCOPE_SIZE_LIMIT');
        const stat = await lstat(absolute);
        if (opaque(path)) {
          entries.push({ kind: 'OPAQUE', opaqueId: digest(path), sha256: digest([stat.mode, stat.size, stat.mtimeMs, stat.ino, stat.nlink]) });
        } else if (stat.isSymbolicLink()) {
          entries.push({ path, kind: 'LINK', sha256: digest(await readlink(absolute)) });
        } else if (stat.isDirectory()) {
          entries.push({ path, kind: 'DIRECTORY', sha256: digest(stat.mode & 0o777) }); await walk(absolute, path);
        } else if (stat.isFile()) {
          if (stat.nlink !== 1) throw new Error('SCOPE_HARD_LINK');
          if (stat.size > 8 * 1024 * 1024 || (totalBytes += stat.size) > 64 * 1024 * 1024) throw new Error('SCOPE_SIZE_LIMIT');
          const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const bytes = Buffer.alloc(stat.size + 1); let used = 0;
            while (used < bytes.length) { const read = await file.read(bytes, used, bytes.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
            const after = await lstat(absolute), opened = await file.stat();
            if (used !== stat.size || opened.ino !== stat.ino || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs
              || after.nlink !== 1 || await realpath(absolute) !== absolute) throw new Error('SCOPE_CHANGED_DURING_READ');
            entries.push({ path, kind: 'FILE', sha256: digest([createHash('sha256').update(bytes.subarray(0, used)).digest('hex'), stat.mode & 0o777]) });
          } finally { await file.close(); }
        } else throw new Error('UNSUPPORTED_SCOPE_ENTRY');
      }
    };
    await walk(root);
    result[side] = { root: config[side].root, entries, hash: digest(entries) };
  }
  return MigrationScopeSnapshotSchema.parse(result);
}

export function compareMigrationScope(config: MigrationConfig, baseline: MigrationScopeSnapshot, current: MigrationScopeSnapshot): ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  const key = (entry: ScopeEntry): string => entry.path ? `path:${entry.path}` : `opaque:${entry.opaqueId}`;
  for (const side of ['source', 'target'] as const) {
    if (baseline[side].root !== config[side].root || current[side].root !== config[side].root) throw new Error('SCOPE_ROOT_MISMATCH');
    const before = new Map(baseline[side].entries.map(entry => [key(entry), entry]));
    const after = new Map(current[side].entries.map(entry => [key(entry), entry]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(id), right = after.get(id), entry = right ?? left!;
      const writable = side === 'target' && !!entry.path && config.target.writePaths.some(path => inside(entry.path!, path)
        || ['DIRECTORY', 'LINK'].includes(entry.kind) && inside(path, entry.path!));
      const changed = canonical(left ?? null) !== canonical(right ?? null);
      const unsafeLink = right?.kind === 'LINK' && (writable || changed);
      if (!changed && !unsafeLink || writable && !unsafeLink) continue;
      findings.push({ side, ...(entry.path ? { path: entry.path } : {}),
        code: unsafeLink ? 'LINK_NOT_ALLOWED' : entry.kind === 'OPAQUE' ? 'PRIVATE_ENTRY_CHANGED' : side === 'source' ? 'SOURCE_CHANGED' : 'OUTSIDE_WRITE_SCOPE',
        change: !left ? 'ADDED' : !right ? 'REMOVED' : 'MODIFIED' });
    }
  }
  return findings;
}
