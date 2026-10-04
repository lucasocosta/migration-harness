import type { CommandHelp, HelpExitCode } from '../help.js';

/**
 * Help registry entries for the six CLI v2 commands (PLAN-V2 §3) — the whole surface after the
 * kill switch retired the compatibility commands. They are the only entries in the registry, so
 * `harness help`, `<command> --help` and `--help --json` project one source for usage, flags,
 * exit codes and examples — and `nextActions` validates its argument names against exactly these
 * flags.
 */
const EXIT_0: HelpExitCode = { code: 0, meaning: 'operation success (doctor/status never approve a migration)' };
const EXIT_1: HelpExitCode = { code: 1, meaning: 'processing error or a refusal outside the session' };
const EXIT_3: HelpExitCode = { code: 3, meaning: 'session refusal/stop; it prevails even over a PASS report' };
const EXIT_4: HelpExitCode = { code: 4, meaning: 'evaluation FAIL with no higher-priority stop' };
const EXIT_5: HelpExitCode = { code: 5, meaning: 'evaluation INCONCLUSIVE with no higher-priority stop' };

const flag = (name: string, required: boolean, description: string, value?: string) =>
  value === undefined ? { name, required, description } : { name, required, description, value };

export const V2_COMMANDS: readonly CommandHelp[] = [
  {
    command: 'init',
    summary: 'Write a schema-valid minimal MigrationConfig and list the fields still to fill — owner decisions (scope, criteria, writePaths, limits) and technical details you may draft (commands, scenarios, bindings). It authorizes nothing and runs nothing.',
    usage: 'init [--out <migration.json>] [--migration-id <id>]',
    flags: [
      flag('--out', false, 'Destination for the generated configuration (exclusive create)', '<migration.json>'),
      flag('--migration-id', false, 'migrationId recorded in the generated configuration', '<id>'),
      flag('--json', false, 'Print one envelope JSON on stdout instead of the text summary'),
    ],
    exitCodes: [EXIT_0, EXIT_1],
    example: 'node packages/cli/dist/index.js init --out migration.json --json',
  },
  {
    command: 'doctor',
    summary: 'Validate configuration schema, permissions, browser, project commands and environment capabilities before any attempt is spent. Never approves a migration.',
    usage: 'doctor --config <migration.json> --workspace-root <dir>',
    flags: [
      flag('--config', true, 'MigrationConfig JSON document', '<migration.json>'),
      flag('--workspace-root', true, 'Directory the project roots are resolved against', '<dir>'),
      flag('--allow-insecure-private-store', false, 'Opt in to DEGRADED privacy when the filesystem cannot enforce 0700/0600 (Windows); aligns every privacy channel'),
      flag('--json', false, 'Print one envelope JSON on stdout instead of the text summary'),
    ],
    exitCodes: [EXIT_0, EXIT_1, EXIT_5],
    example: 'node packages/cli/dist/index.js doctor --config migration.json --workspace-root . --json',
  },
  {
    command: 'prepare',
    summary: 'Establish the versioned reference and open the resumable session in one operation (replaces a separate start). A preparation PASS is not migration success.',
    usage: 'prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir>',
    flags: [
      flag('--config', true, 'MigrationConfig JSON document', '<migration.json>'),
      flag('--workspace-root', true, 'Directory the project roots are resolved against', '<dir>'),
      flag('--artifact-path', true, 'Fresh, exclusive output directory relative to the workspace root', '<new-relative-dir>'),
      flag('--allow-project-commands', false, 'Authorize the declared build/test/reset commands in this local environment'),
      flag('--allow-insecure-private-store', false, 'Opt in to DEGRADED privacy when the filesystem cannot enforce 0700/0600 (Windows); aligns every privacy channel'),
      flag('--json', false, 'Print one envelope JSON on stdout instead of the text summary'),
    ],
    exitCodes: [EXIT_0, EXIT_1, EXIT_4, EXIT_5],
    example: 'node packages/cli/dist/index.js prepare --config migration.json --workspace-root . --artifact-path artifacts/prepared --allow-project-commands --json',
    // PLAN-V2 §11.2 A4: only the first matching refusal is reported, in this order.
    refusalPrecedence: [
      'MISSING_FLAG / UNKNOWN_OPTION (the invocation itself)',
      'INVALID_INPUT (the configuration schema)',
      'INVALID_FLAG (conflicting privacy declarations)',
      'STANDARD_PROFILE_REQUIRED (profile is not standard)',
      'ARTIFACT_NOT_FRESH (this exact request already holds --artifact-path; carries requestKey and replayOf)',
      'SESSION_ALREADY_EXISTS (the session exists and belongs to another request)',
      'EXECUTION_NOT_AUTHORIZED (--allow-project-commands missing)',
      'engine refusals (unsafe paths, an occupied artifact path without a session, suite failures)',
    ],
  },
  {
    command: 'verify',
    summary: 'Verify the candidate against the prepared reference. The session is the only authority for reference, output and budget; each invocation reports one envelope.',
    usage: 'verify --config <migration.json> --workspace-root <dir>',
    flags: [
      flag('--config', true, 'MigrationConfig JSON document with profile standard', '<migration.json>'),
      flag('--workspace-root', true, 'Directory the session is resolved against', '<dir>'),
      flag('--allow-project-commands', false, 'Authorize the declared build/test/reset commands in this local environment'),
      flag('--allow-insecure-private-store', false, 'Opt in to DEGRADED privacy when the filesystem cannot enforce 0700/0600 (Windows); aligns every privacy channel'),
      flag('--json', false, 'Print one envelope JSON on stdout instead of the text summary'),
    ],
    exitCodes: [EXIT_0, EXIT_1, EXIT_3, EXIT_4, EXIT_5],
    example: 'node packages/cli/dist/index.js verify --config migration.json --workspace-root . --allow-project-commands --json',
  },
  {
    command: 'status',
    summary: 'Report session state: disposition, validity of the last result, budget, blocks and the next action. Reading state never spends an attempt.',
    usage: 'status --config <migration.json> --workspace-root <dir>',
    flags: [
      flag('--config', true, 'MigrationConfig JSON document with profile standard', '<migration.json>'),
      flag('--workspace-root', true, 'Directory the session is resolved against', '<dir>'),
      flag('--json', false, 'Print one envelope JSON on stdout instead of the text summary'),
    ],
    exitCodes: [EXIT_0, EXIT_1, EXIT_3],
    example: 'node packages/cli/dist/index.js status --config migration.json --workspace-root . --json',
  },
  {
    command: 'reference',
    summary: 'Controlled reference update for the session: classifies the change (extension, binding adaptation, weakening) and never adopts a weakening without an owner decision.',
    usage: 'reference --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> [--owner-decision <reference>]',
    flags: [
      flag('--config', true, 'MigrationConfig JSON document with profile standard', '<migration.json>'),
      flag('--workspace-root', true, 'Directory the session is resolved against', '<dir>'),
      flag('--artifact-path', true, 'Fresh, exclusive output directory for the updated reference', '<new-relative-dir>'),
      flag('--owner-decision', false, 'Owner approval when the update weakens evaluation criteria', '<reference>'),
      flag('--allow-project-commands', false, 'Authorize the declared build/test/reset commands in this local environment'),
      flag('--allow-insecure-private-store', false, 'Opt in to DEGRADED privacy when the filesystem cannot enforce 0700/0600 (Windows); aligns every privacy channel'),
      flag('--json', false, 'Print one envelope JSON on stdout instead of the text summary'),
    ],
    exitCodes: [EXIT_0, EXIT_1, EXIT_3],
    example: 'node packages/cli/dist/index.js reference --config migration.json --workspace-root . --artifact-path artifacts/reprepared --allow-project-commands --json',
  },
];
