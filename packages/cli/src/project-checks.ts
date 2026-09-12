import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { MigrationPathSchema, parseMigrationConfig } from '@migration-harness/core';
import { ArtifactStore, preflightProjectChecks, runProjectChecks, safeArtifactPath } from '@migration-harness/engine';
import { publicPath, readPublicJson } from './assistant-files.js';

/** Deliberately separate from run/brief: a project check is not behavioral equivalence. */
export async function projectChecksCommand(values: Record<string, unknown>): Promise<void> {
  const allowed = new Set(['config', 'workspace-root', 'artifact-root', 'out', 'phase', 'baseline', 'allow-project-commands', 'preflight-only']);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`Unsupported check-projects option: ${key}`);
  const required = (name: string): string => {
    const value = values[name];
    if (typeof value !== 'string' || !value) throw new Error(`Required flag --${name} is missing.`);
    return value;
  };
  const workspaceRoot = await realpath(resolve(required('workspace-root')));
  const store = new ArtifactStore(resolve(required('artifact-root')));
  const configPath = await publicPath(required('config'), store);
  const config = parseMigrationConfig(await readPublicJson(configPath, store));
  const preflightOnly = values['preflight-only'] === true;
  const phase = values.phase ?? 'baseline';
  if (phase !== 'baseline' && phase !== 'candidate') throw new Error('Phase must be baseline or candidate.');
  if (preflightOnly && (values.phase || values.baseline || values['allow-project-commands'])) throw new Error('Preflight-only does not accept execution options.');
  const baseline = values.baseline === undefined ? undefined : await readPublicJson(required('baseline'), store);
  const output = await publicPath(resolve(store.root, MigrationPathSchema.parse(required('out'))), store);
  const contains = (base: string, path: string): boolean => {
    const rel = relative(resolve(base), path);
    return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
  };
  if (output === configPath || values.baseline && output === resolve(required('baseline'))
    || [config.source.root, config.target.root, ...config.scenarios.map(item => item.fixtureRoot)]
      .some(path => contains(resolve(workspaceRoot, path), output))
    || config.criticalContract && output === resolve(workspaceRoot, config.criticalContract.path)) {
    throw new Error('Check output overlaps protected project inputs.');
  }
  // Reserve an exclusive output before starting commands, so persistence errors do not surprise after execution.
  await mkdir(dirname(output), { recursive: true });
  await safeArtifactPath(store.root, required('out'));
  const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const report = preflightOnly ? await preflightProjectChecks({ config, workspaceRoot })
      : await runProjectChecks({ config, workspaceRoot, phase, allowProjectCommands: values['allow-project-commands'] === true,
        ...(baseline === undefined ? {} : { baseline }), signal: controller.signal });
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.kind}: ${report.status}`);
    process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 4 : 5;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await file.close();
  }
}
