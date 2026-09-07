import { resolve } from 'node:path';
import { ArtifactStore, prepareMigration, verifyMigration, summarizeMigration, ReferenceWeakeningError } from '@migration-harness/engine';
import { parseMigrationConfig, parseMigrationPreparation } from '@migration-harness/core';
import { readPublicJson } from './assistant-files.js';

export function migrationHelp(command: string): string {
  return `${command} --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir>
  --allow-project-commands: run declared build/test/reset commands in an authorized local environment
${command === 'prepare-migration'
    ? '  --preflight-only: inspect inputs, output paths, ports and Chromium; no project commands\n  --previous <preparation.json> [--owner-decision <reference>]: explicit versioned reference update'
    : '  --preparation <preparation.json>: required baseline and fixed source reference; always recapture the complete suite'}
Outputs are exclusive. Raw traces are not retained; a private key supports reference comparison.
Exit codes: 0 PASS; 4 FAIL; 5 INCONCLUSIVE; 1 invalid input/output or refused reference change.
Preparation PASS is not migration success. Normal agent edits/budgets remain P4; restricted commands are unchanged.
Executable example: examples/validation-first/README.md`;
}

export async function migrationCommand(command: 'prepare-migration' | 'verify-migration', values: Record<string, unknown>): Promise<void> {
  const allowed = new Set(['config', 'workspace-root', 'artifact-path', 'allow-project-commands',
    ...(command === 'prepare-migration' ? ['preflight-only', 'previous', 'owner-decision'] : ['preparation'])]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error('UNSUPPORTED_MIGRATION_OPTION');
  const required = (key: string): string => {
    const value = values[key]; if (typeof value !== 'string' || !value) throw new Error(`MISSING_${key.replace(/-/g, '_').toUpperCase()}`); return value;
  };
  if (values['preflight-only'] && (values['allow-project-commands'] || values.previous || values['owner-decision'])) throw new Error('CONFLICTING_PREFLIGHT_OPTIONS');
  if (values['owner-decision'] && !values.previous) throw new Error('OWNER_DECISION_REQUIRES_PREVIOUS');
  const workspaceRoot = resolve(required('workspace-root'));
  const artifactPath = required('artifact-path'), store = new ArtifactStore(resolve(workspaceRoot, artifactPath));
  const config = parseMigrationConfig(await readPublicJson(required('config'), store));
  const controller = new AbortController(), abort = (): void => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const common = { config, workspaceRoot, artifactPath, allowProjectCommands: values['allow-project-commands'] === true, signal: controller.signal };
    if (command === 'prepare-migration') {
      const previous = values.previous ? parseMigrationPreparation(await readPublicJson(required('previous'), store, 32_000_000)) : undefined;
      const result = await prepareMigration({ ...common, ...(previous ? { previous } : {}),
        ...(values['owner-decision'] ? { ownerDecisionReference: required('owner-decision') } : {}), preflightOnly: values['preflight-only'] === true });
      console.log(`${result.kind}: ${result.status}\nArtifacts: ${artifactPath}`);
      if (result.kind === 'MIGRATION_PREFLIGHT') for (const diagnostic of result.diagnostics) console.log(`${diagnostic.code}: ${diagnostic.detailCode}`);
      process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 4 : 5;
    } else {
      const preparation = await readPublicJson(required('preparation'), store, 32_000_000);
      const report = await verifyMigration({ ...common, preparation });
      console.log(`${summarizeMigration(report)}\nArtifacts: ${artifactPath}`);
      process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 4 : 5;
    }
  } catch (error) {
    if (error instanceof ReferenceWeakeningError) throw new Error('REFERENCE_CHANGE_REQUIRES_OWNER_DECISION');
    throw new Error(error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'INVALID_MIGRATION_INPUT_OR_OUTPUT');
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
