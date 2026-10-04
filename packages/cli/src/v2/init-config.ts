import { parseMigrationConfig, type MigrationConfig } from '@migration-harness/core';

/** A decision the operator must make before the configuration is meaningful for this workspace. */
export interface MissingDecision {
  /** Safe field path inside the configuration document. */
  readonly fieldPath: string;
  /** What the owner must decide; static text, never derived from runtime state. */
  readonly decision: string;
}

/**
 * The decisions `init` cannot make: every entry is an owner choice about THIS workspace (roots,
 * commands, behavior, limits). `init` writes a schema-valid skeleton so `doctor` can already read
 * it, and lists these so nothing is silently guessed. Authorizing anything is never part of init.
 */
export const MISSING_DECISIONS: readonly MissingDecision[] = Object.freeze([
  { fieldPath: 'source.root', decision: 'Directory of the application being migrated away from.' },
  { fieldPath: 'source.baseUrl', decision: 'Base URL the source application is served on.' },
  { fieldPath: 'source.commands', decision: 'Build/check/serve/reset commands the source side really runs.' },
  { fieldPath: 'target.root', decision: 'Directory of the migrated application.' },
  { fieldPath: 'target.baseUrl', decision: 'Base URL the migrated application is served on.' },
  { fieldPath: 'target.commands', decision: 'Build/check/serve/reset commands the migrated side really runs.' },
  { fieldPath: 'target.writePaths', decision: 'Exactly which target paths the candidate may write.' },
  { fieldPath: 'target.protectedPaths', decision: 'Target paths that must never be touched.' },
  { fieldPath: 'scenarios', decision: 'Scenarios (steps, bindings, fixtures) describing the behavior to preserve.' },
  { fieldPath: 'checks', decision: 'Required native checks per side; at least one required target check.' },
  { fieldPath: 'requirements', decision: 'Requirements that turn observed behavior into acceptance criteria.' },
  { fieldPath: 'reset', decision: 'How each side returns to a clean state between captures.' },
  { fieldPath: 'limits', decision: 'sourceRuns, maxRepairAttempts and maxDurationMs for this migration.' },
]);

/**
 * Minimal schema-valid configuration (profile standard): enough for `doctor` to parse and for the
 * operator to see where every decision above plugs in. Placeholder URLs, commands and scenario are
 * explicitly TODOs — nothing here authorizes execution or approves any criterion.
 */
export function minimalConfig(migrationId: string): MigrationConfig {
  const source: Record<string, unknown> = {
    root: 'source', baseUrl: 'http://localhost:4200', relevantFiles: ['main.ts'],
    commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60_000 }],
    build: { commandId: 'build', outputDir: 'dist', cleanOutput: true },
  };
  const target: Record<string, unknown> = {
    root: 'target', baseUrl: 'http://localhost:5173', relevantFiles: ['main.tsx'], writePaths: ['src'], protectedPaths: [],
    commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60_000 }],
    build: { commandId: 'build', outputDir: 'dist', cleanOutput: true },
  };
  return parseMigrationConfig({
    kind: 'MIGRATION_CONFIG', version: '1', migrationId, profile: 'standard',
    source, target,
    scenarios: [{
      definition: {
        scenarioId: 'scenario-1', unitId: 'unit-1', name: 'Scenario1',
        description: 'TODO: describe the behavior this migration must preserve.',
        entryUrl: 'http://localhost:4200/', preconditions: {}, testDataProfile: 'standard', steps: [],
      },
      required: true, fixtureRoot: 'fixtures',
      bindings: { source: { entryUrl: 'http://localhost:4200/', steps: [] }, target: { entryUrl: 'http://localhost:5173/', steps: [] } },
    }],
    checks: [
      { id: 'build-source', side: 'source', commandId: 'build', required: true },
      { id: 'build-target', side: 'target', commandId: 'build', required: true },
    ],
    requirements: [], acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'en-US', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 600_000 },
  });
}
