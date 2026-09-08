import { resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { ArtifactStore, prepareMigration, verifyMigration, summarizeMigration, ReferenceWeakeningError,
  startMigrationSession, inspectMigrationSession, verifyMigrationSession, updateMigrationSessionReference, migrationSessionPath } from '@migration-harness/engine';
import { parseMigrationConfig, parseMigrationPreparation } from '@migration-harness/core';
import { readPublicJson } from './assistant-files.js';

export function migrationHelp(command: string): string {
  if (command === 'update-migration-session') return `update-migration-session --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> [--owner-decision <reference>] --allow-project-commands
Controlled reference update for a standard session: coverage extension or binding adaptation only.
Session identity, attempt history and budgets are preserved; roots and limits must not change. Weakening requires --owner-decision.
Reports from superseded generations stop matching; session resets remain forbidden. Runs a full preparation (project commands).
Exit codes: 0 updated; 1 invalid input/state or refused reference change.`;
  if (command === 'start-migration-session' || command === 'migration-session-status') return `${command} --config <migration.json> --workspace-root <dir>${command === 'start-migration-session' ? ' --preparation <preparation.json>' : ''}
Requires profile: standard. Session storage is deterministic per source/target pair.
Normal writes are checked against target.writePaths. Session state and attempt history are harness-owned.
Attempts: maxRepairAttempts + 1; cumulative verification time: maxDurationMs (editing time excluded).
Repeated identical failed candidate/result stops for no progress. Existing sessions cannot be reset by starting again.
Coverage/binding reference updates keep this session: update-migration-session preserves history and budgets.
Exit codes: 0 started/valid scope; 3 refused scope or exhausted budget; 1 invalid input/state.`;
  return `${command} --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir>
  --allow-project-commands: run declared build/test/reset commands in an authorized local environment
${command === 'prepare-migration'
    ? '  --preflight-only: inspect inputs, output paths, ports and Chromium; no project commands\n  --previous <preparation.json> [--owner-decision <reference>]: explicit versioned reference update'
    : '  --preparation <preparation.json>: required baseline and fixed source reference; always recapture the complete suite'}
Outputs are exclusive. Raw traces are not retained; a private key supports reference comparison.
Exit codes: 0 PASS; 4 FAIL; 5 INCONCLUSIVE; 1 invalid input/output or refused reference change.
Preparation PASS is not migration success. For profile: standard, start-migration-session first;
verify-migration then takes only config/workspace and authorization, with session-owned reference/output/budget.
Executable example: examples/validation-first/README.md`;
}

export async function migrationCommand(command: 'prepare-migration' | 'verify-migration' | 'start-migration-session' | 'migration-session-status' | 'update-migration-session', values: Record<string, unknown>): Promise<void> {
  const sessionCommand = command === 'start-migration-session' || command === 'migration-session-status';
  const updateCommand = command === 'update-migration-session';
  const allowed = new Set(['config', 'workspace-root', 'artifact-path', 'allow-project-commands',
    ...(command === 'prepare-migration' ? ['preflight-only', 'previous', 'owner-decision'] : updateCommand ? ['owner-decision'] : ['preparation'])]);
  if (sessionCommand) { allowed.delete('artifact-path'); allowed.delete('allow-project-commands'); if (command === 'migration-session-status') allowed.delete('preparation'); }
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error('UNSUPPORTED_MIGRATION_OPTION');
  const required = (key: string): string => {
    const value = values[key]; if (typeof value !== 'string' || !value) throw new Error(`MISSING_${key.replace(/-/g, '_').toUpperCase()}`); return value;
  };
  if (values['preflight-only'] && (values['allow-project-commands'] || values.previous || values['owner-decision'])) throw new Error('CONFLICTING_PREFLIGHT_OPTIONS');
  if (values['owner-decision'] && !values.previous && !updateCommand) throw new Error('OWNER_DECISION_REQUIRES_PREVIOUS');
  const workspaceRoot = resolve(required('workspace-root'));
  const artifactPath = typeof values['artifact-path'] === 'string' ? values['artifact-path'] : undefined;
  const store = new ArtifactStore(resolve(workspaceRoot, artifactPath ?? 'artifacts'));
  const config = parseMigrationConfig(await readPublicJson(required('config'), store));
  const controller = new AbortController(), abort = (): void => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const common = { config, workspaceRoot, artifactPath, allowProjectCommands: values['allow-project-commands'] === true, signal: controller.signal };
    if (sessionCommand) {
      if (command === 'start-migration-session') {
        const result = await startMigrationSession({ config, workspaceRoot, preparation: await readPublicJson(required('preparation'), store, 32_000_000) });
        console.log(JSON.stringify(result, null, 2));
      } else {
        const result = await inspectMigrationSession({ config, workspaceRoot });
        console.log(JSON.stringify(result, null, 2)); process.exitCode = result.lastReportMatchesWorkspace || result.scope === 'PASS' && result.referenceStatus === 'VERIFIED' && !result.stop ? 0 : 3;
      }
      return;
    }
    if (updateCommand) {
      const result = await updateMigrationSessionReference({ config, workspaceRoot, artifactPath: required('artifact-path'),
        allowProjectCommands: common.allowProjectCommands, ...(values['owner-decision'] ? { ownerDecisionReference: required('owner-decision') } : {}) });
      console.log(`${result.kind}: generation ${result.generation} (${result.classification}, reference v${result.referenceVersion})\nSession: ${result.sessionPath}; attempts used: ${result.attemptsUsed}; remaining: ${result.attemptsRemaining}`);
      return;
    }
    if (command === 'prepare-migration') {
      const previous = values.previous ? parseMigrationPreparation(await readPublicJson(required('previous'), store, 32_000_000)) : undefined;
      const result = await prepareMigration({ ...common, artifactPath: required('artifact-path'), ...(previous ? { previous } : {}),
        ...(values['owner-decision'] ? { ownerDecisionReference: required('owner-decision') } : {}), preflightOnly: values['preflight-only'] === true });
      console.log(`${result.kind}: ${result.status}\nArtifacts: ${artifactPath}`);
      if (result.kind === 'MIGRATION_PREFLIGHT') for (const diagnostic of result.diagnostics) console.log(`${diagnostic.code}: ${diagnostic.detailCode}`);
      process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 4 : 5;
    } else {
      if (config.profile === 'standard') {
        if (values.preparation || artifactPath) throw new Error('STANDARD_SESSION_OWNS_REFERENCE_AND_OUTPUT');
        const result = await verifyMigrationSession({ config, workspaceRoot, allowProjectCommands: common.allowProjectCommands, signal: controller.signal });
        console.log(`${result.kind}: ${result.decision}\nAttempts: ${result.attemptsUsed}; remaining: ${result.attemptsRemaining}; active time remaining: ${result.remainingMs}ms`);
        if ('report' in result && result.report) console.log(summarizeMigration(result.report));
        if ('findings' in result) for (const finding of result.findings ?? []) console.log(`${finding.code} side=${finding.side}${finding.path ? ` path=${finding.path}` : ''}`);
        process.exitCode = result.decision === 'COMPLETE' ? 0 : ['REFUSED_SCOPE', 'STOP_LIMIT', 'STOP_NO_PROGRESS', 'INTERRUPTED'].includes(result.decision) ? 3
          : 'outcome' in result && result.outcome === 'FAIL' ? 4 : 5;
        return;
      }
      const sessionExists = await lstat(resolve(workspaceRoot, migrationSessionPath(config))).then(() => true,
        (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
      if (sessionExists) throw new Error('STANDARD_SESSION_PROFILE_REQUIRED');
      const preparation = await readPublicJson(required('preparation'), store, 32_000_000);
      const report = await verifyMigration({ ...common, artifactPath: required('artifact-path'), preparation });
      console.log(`${summarizeMigration(report)}\nArtifacts: ${artifactPath}`);
      process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 4 : 5;
    }
  } catch (error) {
    if (error instanceof ReferenceWeakeningError) throw new Error('REFERENCE_CHANGE_REQUIRES_OWNER_DECISION');
    throw new Error(error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'INVALID_MIGRATION_INPUT_OR_OUTPUT');
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
