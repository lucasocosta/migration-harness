import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { migrationSessionPath, startMigrationSession } from '../packages/engine/dist/migration-session.js';
import { ERROR_CATALOG } from '../packages/cli/dist/errors.js';
import { findCommand } from '../packages/cli/dist/help.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';
import { digest, journal } from './helpers/session.mjs';

// PLAN-V2 §11.2 A3 / A4 / A9 — acceptance polish of the v2 envelope:
//  A3 every recommended command is literally executable (required flags spelled out, v2 preferred);
//  A4 an existing session splits ARTIFACT_NOT_FRESH (replay of this request) from SESSION_ALREADY_EXISTS
//     (another request), and `prepare --help --json` publishes that precedence;
//  A9 sessionId appears only when the session exists, and an exit-3 stop never ships empty diagnostics.
const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');

async function run(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { timeout: 180_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
const json = result => JSON.parse(result.stdout);

/** Standard-profile workspace with a started session, without running any capture. */
async function syntheticSession(t) {
  const { root, config } = await buildWorkspace();
  config.profile = 'standard';
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { config, workspaceRoot: root };
  const reference = await collectMigrationReference({ ...input,
    sourceObservations: { status: 'STABLE', runs: 2, executionHashes: [digest('source'), digest('source')] } });
  const baseline = await runProjectChecks({ ...input, phase: 'baseline', allowProjectCommands: true });
  const preparation = { kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS', reference,
    referenceHash: migrationReferenceHash(reference), artifactPath: 'artifacts/prepared', keyId: digest('dummy'),
    sourceEvidence: [], baseline,
    sourceBuild: { kind: 'SERVED_BUILD', version: '1', side: 'source', runId: randomUUID(), origin: config.source.baseUrl,
      configurationHash: migrationConfigHash(config), inputHash: digest('input'), buildHash: digest('build'), fileCount: 1, totalBytes: 1 } };
  const sessionPath = migrationSessionPath(config);
  await startMigrationSession({ ...input, preparation });
  await write(root, 'migration.json', JSON.stringify(config));
  return { root, config, sessionPath, prepareArgs: ['prepare', '--config', join(root, 'migration.json'),
    '--workspace-root', root, '--artifact-path', 'artifacts/prepared', '--allow-project-commands', '--json'] };
}

const RETIRED_COMMANDS = ['prepare-migration', 'verify-migration', 'start-migration-session', 'migration-session-status',
  'update-migration-session', 'check-projects', 'brief', 'apply-patch', 'run', 'transform', 'sanitize-trace',
  'review-contract', 'approve-contract', 'verify-contract', 'compare', 'discover', 'plan', 'trace', 'synthesize',
  'import-openapi', 'import-har', 'import-test-evidence', 'purge-raw', 'rotate-raw-key', 'anchor-audit'];
const V2_COMMANDS = ['init', 'doctor', 'prepare', 'verify', 'status', 'reference'];
const mentions = (text, command) => new RegExp(`(?<![\\w-])${command}(?![\\w-])`).test(text);
/** An actual invocation — the command name directly followed by flags — not the English word. */
const invokes = (text, command) => new RegExp(`(?<![\\w-])${command}(?=\\s+--)`).test(text);
/**
 * Retired names are matched as words, except the single-word commands that are also ordinary
 * English ("run", "plan", "trace"): those only count when the action actually invokes them.
 */
const recommendsRetired = (text, command) => command.includes('-')
  ? mentions(text, command) : (mentions(text, command) && invokes(text, command));
const requiredFlagsOf = command => findCommand(command).flags.filter(flag => flag.required).map(flag => flag.name);

test('catalog actions recommend executable commands and never a retired one (A3)', () => {
  const failures = [];
  for (const [code, row] of Object.entries(ERROR_CATALOG)) {
    // The catalog was pruned with the kill switch: no action may point an operator at a command
    // that no longer exists, whatever else it says.
    const retired = RETIRED_COMMANDS.filter(command => recommendsRetired(row.action, command));
    for (const command of retired) failures.push(`${code} recommends the retired \`${command}\`: ${row.action}`);
    // And every recommendation that does invoke a v2 command spells out all of its required flags.
    for (const command of V2_COMMANDS.filter(candidate => invokes(row.action, candidate))) {
      for (const name of requiredFlagsOf(command)) {
        if (!row.action.includes(name)) failures.push(`${code} invokes \`${command}\` without its required ${name}: ${row.action}`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  // The A3 finding itself: the preflight hint points at doctor, not at a half-spelled legacy call.
  assert.ok(mentions(ERROR_CATALOG.SUITE_PREFLIGHT_FAILED.action, 'doctor'));
  assert.ok(mentions(ERROR_CATALOG.EXECUTION_NOT_AUTHORIZED.action, 'doctor'), 'the bare --preflight-only hint is gone');
});

test('every nextAction carries the required flags of the operation it recommends (A3)', async t => {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'migration.json', JSON.stringify(config)); // no profile: standard
  const configPath = join(root, 'migration.json');
  const assertExecutable = (envelope, label) => {
    for (const action of envelope.nextActions) {
      assert.ok(findCommand(action.operation), `${label}: ${action.operation} is a registered command`);
      for (const name of requiredFlagsOf(action.operation)) {
        assert.ok(Object.hasOwn(action.args, name), `${label}: ${action.operation} recommends without required ${name}`);
      }
    }
  };

  // Refusals outside profile standard recommend nothing at all (the handover is retired), while the
  // recommendations the envelope does print must be runnable as printed.
  const prepare = json(await run(['prepare', '--config', configPath, '--workspace-root', root,
    '--artifact-path', 'artifacts/prepared', '--allow-project-commands', '--json']));
  assert.equal(prepare.diagnostics[0].code, 'STANDARD_PROFILE_REQUIRED');
  assert.deepEqual(prepare.nextActions, [], 'no handover to a retired command');
  assertExecutable(prepare, 'prepare refusal');
  const reference = json(await run(['reference', '--config', configPath, '--workspace-root', root,
    '--artifact-path', 'artifacts/re', '--allow-project-commands', '--json']));
  assert.deepEqual(reference.nextActions, [], 'no handover to a retired command');
  assertExecutable(reference, 'reference refusal');
  const doctor = json(await run(['doctor', '--config', configPath, '--workspace-root', root, '--json']));
  assertExecutable(doctor, 'doctor');
  // Standard profile, no session, no authorization flag: the refusal hands back a runnable prepare.
  await write(root, 'standard.json', JSON.stringify({ ...config, profile: 'standard' }));
  const unauthorized = json(await run(['prepare', '--config', join(root, 'standard.json'), '--workspace-root', root,
    '--artifact-path', 'artifacts/fresh', '--json']));
  assert.equal(unauthorized.diagnostics[0].code, 'EXECUTION_NOT_AUTHORIZED');
  assertExecutable(unauthorized, 'authorization refusal');
});

test('an existing session separates a replay of this request from a foreign conflict (A4)', async t => {
  const f = await syntheticSession(t);
  const configurationHash = migrationConfigHash(f.config);
  await mkdir(join(f.root, 'artifacts/prepared'), { recursive: true });

  // Same requestKey (operation + configurationHash + workspace + artifact path): a recorded result.
  await write(f.root, 'artifacts/prepared/started.json',
    JSON.stringify({ kind: 'MIGRATION_OPERATION_STARTED', configurationHash, completed: true }));
  await write(f.root, 'artifacts/prepared/preparation.json', JSON.stringify({ kind: 'MIGRATION_PREPARATION' }));
  const replay = await run(f.prepareArgs);
  assert.equal(replay.code, 1, `a replay is a structured refusal, exit 1: ${replay.stderr}`);
  const replayed = json(replay);
  assert.equal(replayed.operationStatus, 'refused');
  assert.equal(replayed.diagnostics[0].code, 'ARTIFACT_NOT_FRESH', 'A4: never SESSION_ALREADY_EXISTS for the same request');
  assert.equal(replayed.diagnostics[0].fieldPath, '--artifact-path');
  assert.match(replayed.diagnostics[0].cause, /recorded result/);
  assert.equal(replayed.requestKey.length, 64);
  assert.equal(replayed.replayOf, replayed.requestKey, 'replayOf == requestKey, the pattern reference already follows');
  assert.equal(replayed.sessionId, f.sessionPath, 'the session exists, so §4 keeps it present');
  assert.equal(replayed.nextActions[0].operation, 'status', 'inspect the recorded state first');
  assert.equal(replayed.nextActions[1].operation, 'reference', 'a live session is updated, never re-prepared');
  assert.equal(replayed.nextActions[1].args['--artifact-path'], 'artifacts/prepared-retry');

  // Same path, another request (different configuration): a distinct structured conflict, not a replay.
  await write(f.root, 'artifacts/prepared/started.json',
    JSON.stringify({ kind: 'MIGRATION_OPERATION_STARTED', configurationHash: digest('other-config'), completed: true }));
  const foreign = await run(f.prepareArgs);
  assert.equal(foreign.code, 1);
  const conflicted = json(foreign);
  assert.equal(conflicted.diagnostics[0].code, 'SESSION_ALREADY_EXISTS', 'a different request conflicts, it never replays');
  assert.equal(conflicted.requestKey.length, 64, 'the refusal still names this request');
  assert.equal('replayOf' in conflicted, false, 'a foreign occupant is never claimed as this request');
  assert.equal(conflicted.sessionId, f.sessionPath);

  // A different artifact path is a different requestKey: same distinct conflict.
  const elsewhere = await run(['prepare', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root,
    '--artifact-path', 'artifacts/elsewhere', '--allow-project-commands', '--json']);
  assert.equal(elsewhere.code, 1);
  const other = json(elsewhere);
  assert.equal(other.diagnostics[0].code, 'SESSION_ALREADY_EXISTS');
  assert.equal('replayOf' in other, false);
  assert.notEqual(other.requestKey, replayed.requestKey, 'the request key tracks the artifact path');
});

test('prepare publishes its refusal precedence in --help --json (A4)', async () => {
  const text = await run(['prepare', '--help']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Refusal precedence:/);
  const help = json(await run(['prepare', '--help', '--json']));
  assert.ok(Array.isArray(help.refusalPrecedence) && help.refusalPrecedence.length >= 5, JSON.stringify(help.refusalPrecedence));
  const order = code => {
    const index = help.refusalPrecedence.findIndex(entry => entry.includes(code));
    assert.ok(index >= 0, `${code} is documented in refusalPrecedence`);
    return index;
  };
  assert.ok(order('MISSING_FLAG') < order('INVALID_INPUT'));
  assert.ok(order('INVALID_INPUT') < order('STANDARD_PROFILE_REQUIRED'));
  assert.ok(order('STANDARD_PROFILE_REQUIRED') < order('ARTIFACT_NOT_FRESH'));
  assert.ok(order('ARTIFACT_NOT_FRESH') < order('SESSION_ALREADY_EXISTS'));
  assert.ok(order('SESSION_ALREADY_EXISTS') < order('EXECUTION_NOT_AUTHORIZED'));
  // Commands without a published precedence keep the projection stable.
  assert.equal('refusalPrecedence' in json(await run(['status', '--help', '--json'])), false);
});

test('a refusal for a session that does not exist carries no sessionId (A9)', async t => {
  const f = await syntheticSession(t);
  const bare = { ...f.config, migrationId: 'no-session-yet',
    source: { ...f.config.source, root: `${f.config.source.root}-bare` },
    target: { ...f.config.target, root: `${f.config.target.root}-bare` } };
  await write(f.root, 'bare.json', JSON.stringify(bare));
  const configPath = join(f.root, 'bare.json');
  for (const [command, extra] of [
    ['status', []],
    ['verify', ['--allow-project-commands']],
    ['reference', ['--artifact-path', 'artifacts/re', '--allow-project-commands']],
  ]) {
    const result = await run([command, '--config', configPath, '--workspace-root', f.root, ...extra, '--json']);
    assert.equal(result.code, 1, command);
    const envelope = json(result);
    assert.equal(envelope.operationStatus, 'refused', command);
    assert.equal(envelope.diagnostics[0].code, 'STANDARD_SESSION_REQUIRED', command);
    assert.equal('sessionId' in envelope, false, `${command}: §4 "present only when they exist"`);
  }

  // The very same commands against an existing session still name it.
  const existing = json(await run(['status', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root, '--json']));
  assert.equal(existing.sessionId, f.sessionPath);
});

test('an exit-3 stop always carries its catalog diagnostic, never diagnostics: [] (A9)', async t => {
  for (const [label, durations, repeated, interrupted, decision, code] of [
    ['attempt count', [1, 1, 1, 1], false, false, 'STOP_LIMIT', 'BUDGET_EXHAUSTED'],
    ['active time', [15000], false, false, 'STOP_LIMIT', 'BUDGET_EXHAUSTED'],
    ['no progress', [1, 1], true, false, 'STOP_NO_PROGRESS', 'NO_PROGRESS_STOP'],
    ['interrupted reservation', [1], false, true, 'INTERRUPTED', 'SESSION_ATTEMPT_OPEN'],
  ]) {
    const f = await syntheticSession(t);
    await journal(f, durations, repeated, interrupted);
    const status = await run(['status', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root, '--json']);
    assert.equal(status.code, 3, `${label}: every stop maps to exit 3`);
    const envelope = json(status);
    assert.equal(envelope.decision, decision);
    assert.ok(envelope.diagnostics.length > 0, `${label}: a stop never ships empty diagnostics`);
    const diagnostic = envelope.diagnostics[0];
    assert.equal(diagnostic.code, code, label);
    assert.equal(typeof diagnostic.category, 'string');
    assert.ok(diagnostic.cause.length > 0, label);
    assert.ok(diagnostic.action.length > 0, label);
    assert.equal(typeof diagnostic.retryable, 'boolean');
  }
});

test('a scope refusal and a refused verification explain themselves on the envelope (A9)', async t => {
  const f = await syntheticSession(t);
  await write(f.root, 'target/user.txt', 'unrelated destination work');

  const status = await run(['status', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root, '--json']);
  assert.equal(status.code, 3);
  const reported = json(status);
  assert.equal(reported.decision, 'REFUSED_SCOPE');
  assert.equal(reported.diagnostics[0].code, 'OUTSIDE_WRITE_SCOPE');
  assert.equal(reported.sessionId, f.sessionPath, 'the session exists');
  assert.equal(await readFile(join(f.root, 'target/user.txt'), 'utf8'), 'unrelated destination work', 'user work is preserved');

  const verify = await run(['verify', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root,
    '--allow-project-commands', '--json']);
  assert.equal(verify.code, 3, 'a session refusal outranks everything');
  const refused = json(verify);
  assert.equal(refused.operationStatus, 'refused');
  assert.equal(refused.decision, 'REFUSED_SCOPE');
  assert.ok(refused.diagnostics.length > 0, 'the refused verification is not silent either');
  assert.equal(refused.diagnostics[0].code, 'OUTSIDE_WRITE_SCOPE');
});

test('a budget stop refuses verify with a catalogued diagnostic and exit 3 (A9)', async t => {
  const f = await syntheticSession(t);
  await journal(f, [1, 1, 1, 1]);
  const verify = await run(['verify', '--config', join(f.root, 'migration.json'), '--workspace-root', f.root,
    '--allow-project-commands', '--json']);
  assert.equal(verify.code, 3, 'STOP_LIMIT maps to exit 3');
  const envelope = json(verify);
  assert.equal(envelope.operationStatus, 'refused');
  assert.equal(envelope.decision, 'STOP_LIMIT');
  assert.equal('outcome' in envelope, false, 'nothing was evaluated');
  const diagnostic = envelope.diagnostics[0];
  assert.equal(diagnostic.code, 'BUDGET_EXHAUSTED');
  assert.equal(diagnostic.category, 'EXECUTION');
  assert.match(diagnostic.cause, /budget is exhausted/);
  assert.match(diagnostic.action, /human decision/);
  assert.equal(diagnostic.retryable, false);
  assert.deepEqual(envelope.nextActions, [], 'budgets and history are immutable: nothing is auto-recommended');
});
