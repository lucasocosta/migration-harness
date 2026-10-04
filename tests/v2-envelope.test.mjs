import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMBINATION_TABLE, ENVELOPE_SCHEMA_VERSION, buildEnvelope, envelopeExitCode, exitCodeFor, findCombination,
} from '../packages/cli/dist/v2/envelope.js';
import { buildNextAction, buildNextActions, REQUIRES_APPROVAL } from '../packages/cli/dist/v2/next-actions.js';

// PLAN-V2 §3.1 contract freeze: the {operationStatus, decision, outcome} table is the single source
// of truth for the CLI v2 envelope and its (immutable) exit codes. These tests run before any
// command code is exercised: the table itself is the specification, not a byproduct of behavior.
//
// Exit-code contract: 0 = operation success (doctor/status never approve a migration), 1 = processing
// error (including non-session refusals), 3 = session refusal/stop — it prevails even over a PASS
// report — 4/5 = FAIL/INCONCLUSIVE evaluation and only when no higher-priority stop applies.
const EXPECTED_TABLE = [
  // [operationStatus, decision, outcome, exitCode]
  ['processed', null, null, 0],
  ['processed', null, 'PASS', 0],
  ['processed', null, 'FAIL', 4],
  ['processed', null, 'INCONCLUSIVE', 5],
  ['processed', 'READY', null, 0],
  ['processed', 'READY', 'PASS', 0],
  ['processed', 'COMPLETE', null, 0],
  ['processed', 'COMPLETE', 'PASS', 0],
  ['processed', 'REPAIR_IMPLEMENTATION', null, 0],
  ['processed', 'REPAIR_IMPLEMENTATION', 'FAIL', 4],
  ['processed', 'REPAIR_IMPLEMENTATION', 'INCONCLUSIVE', 5],
  ['processed', 'FIX_ENVIRONMENT', null, 0],
  ['processed', 'FIX_ENVIRONMENT', 'INCONCLUSIVE', 5],
  ['processed', 'REVIEW_REFERENCE', null, 0],
  ['processed', 'REVIEW_REFERENCE', 'FAIL', 4],
  ['processed', 'REVIEW_REFERENCE', 'INCONCLUSIVE', 5],
  ['processed', 'REFUSED_SCOPE', null, 3],
  ['processed', 'STOP_LIMIT', null, 3],
  ['processed', 'STOP_LIMIT', 'PASS', 3],
  ['processed', 'STOP_LIMIT', 'FAIL', 3],
  ['processed', 'STOP_LIMIT', 'INCONCLUSIVE', 3],
  ['processed', 'STOP_NO_PROGRESS', null, 3],
  ['processed', 'STOP_NO_PROGRESS', 'PASS', 3],
  ['processed', 'STOP_NO_PROGRESS', 'FAIL', 3],
  ['processed', 'STOP_NO_PROGRESS', 'INCONCLUSIVE', 3],
  ['processed', 'INTERRUPTED', null, 3],
  ['refused', null, null, 1],
  ['refused', 'REFUSED_SCOPE', null, 3],
  ['refused', 'STOP_LIMIT', null, 3],
  ['refused', 'STOP_NO_PROGRESS', null, 3],
  ['refused', 'INTERRUPTED', null, 3],
  ['failed', null, null, 1],
];

test('the envelope combination table is exactly the documented set of valid trios', () => {
  const actual = COMBINATION_TABLE.map(row => [row.operationStatus, row.decision, row.outcome, row.exitCode]);
  assert.deepEqual(actual, EXPECTED_TABLE, 'every allowed trio and its exit code is pinned here and in envelope.ts');
  const keys = COMBINATION_TABLE.map(row => `${row.operationStatus}|${row.decision}|${row.outcome}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate trio');
  for (const row of COMBINATION_TABLE) assert.ok([0, 1, 3, 4, 5].includes(row.exitCode), `immutable exit code: ${row.exitCode}`);
});

test('exit codes follow the documented priority: processing error < session stop < evaluation < success', () => {
  // 1: processing failure or a refusal outside the session.
  assert.equal(exitCodeFor('failed', null, null), 1);
  assert.equal(exitCodeFor('refused', null, null), 1);
  // 3: a session stop/ refusal prevails over every evaluation, PASS included (PLAN-V2 §3.1).
  for (const decision of ['REFUSED_SCOPE', 'STOP_LIMIT', 'STOP_NO_PROGRESS', 'INTERRUPTED']) {
    assert.equal(exitCodeFor('processed', decision, null), 3, decision);
    assert.equal(exitCodeFor('refused', decision, null), 3, decision);
  }
  assert.equal(exitCodeFor('processed', 'STOP_LIMIT', 'PASS'), 3, 'stop prevails over a PASS report');
  assert.equal(exitCodeFor('processed', 'STOP_NO_PROGRESS', 'FAIL'), 3, 'stop prevails over a FAIL report');
  // 4/5: the evaluation decides only when no stop applies — the decision alone never picks the code.
  assert.equal(exitCodeFor('processed', null, 'FAIL'), 4);
  assert.equal(exitCodeFor('processed', null, 'INCONCLUSIVE'), 5);
  assert.equal(exitCodeFor('processed', 'REPAIR_IMPLEMENTATION', 'FAIL'), 4);
  assert.equal(exitCodeFor('processed', 'REPAIR_IMPLEMENTATION', 'INCONCLUSIVE'), 5,
    'REPAIR_IMPLEMENTATION + INCONCLUSIVE exits 5: exit codes follow the outcome, not the decision');
  assert.equal(exitCodeFor('processed', 'REVIEW_REFERENCE', 'FAIL'), 4);
  // 0: operation success, whether or not the migration is approved.
  assert.equal(exitCodeFor('processed', null, null), 0);
  assert.equal(exitCodeFor('processed', null, 'PASS'), 0);
  assert.equal(exitCodeFor('processed', 'READY', null), 0);
  assert.equal(exitCodeFor('processed', 'COMPLETE', 'PASS'), 0);
  assert.equal(exitCodeFor('processed', 'COMPLETE', null), 0);
  assert.equal(exitCodeFor('processed', 'REPAIR_IMPLEMENTATION', null), 0,
    'status reports a session disposition without evaluating: the operation itself succeeded');
});

test('trios outside the table are refused instead of silently accepted', () => {
  const invalid = [
    ['failed', 'COMPLETE', 'PASS'],
    ['failed', null, 'FAIL'],
    ['failed', 'STOP_LIMIT', null],
    ['refused', null, 'PASS'],
    ['refused', 'COMPLETE', null],
    ['refused', 'READY', null],
    ['refused', 'STOP_LIMIT', 'INCONCLUSIVE'],
    ['processed', 'COMPLETE', 'FAIL'],
    ['processed', 'COMPLETE', 'INCONCLUSIVE'],
    ['processed', 'REPAIR_IMPLEMENTATION', 'PASS'],
    ['processed', 'FIX_ENVIRONMENT', 'FAIL'],
    ['processed', 'REVIEW_REFERENCE', 'PASS'],
    ['processed', 'INTERRUPTED', 'FAIL'],
    ['processed', 'UNKNOWN_DECISION', null],
    ['processed', null, 'SKIPPED'],
    ['nonsense', null, null],
  ];
  for (const [operationStatus, decision, outcome] of invalid) {
    assert.equal(findCombination(operationStatus, decision, outcome), undefined, `${operationStatus}/${decision}/${outcome}`);
    assert.throws(() => exitCodeFor(operationStatus, decision, outcome), /INVALID_ENVELOPE_COMBINATION/,
      `${operationStatus}/${decision}/${outcome} must not resolve to an exit code`);
  }
});

test('buildEnvelope validates the trio, defaults the open fields and derives its exit code', () => {
  const envelope = buildEnvelope({ operation: 'status', operationStatus: 'processed', decision: 'READY' });
  assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.schemaVersion, '1');
  assert.equal(envelope.operation, 'status');
  assert.equal(envelope.operationStatus, 'processed');
  assert.equal(envelope.decision, 'READY');
  assert.equal('outcome' in envelope, false, 'no evaluation means no outcome key');
  assert.deepEqual(envelope.diagnostics, []);
  assert.deepEqual(envelope.nextActions, []);
  assert.match(envelope.runId, /^[0-9a-f-]{36}$/, 'every envelope names its own run');
  assert.equal(envelopeExitCode(envelope), 0);

  const evaluated = buildEnvelope({ operation: 'verify', operationStatus: 'processed', decision: 'REPAIR_IMPLEMENTATION', outcome: 'FAIL', report: { kind: 'MIGRATION_SESSION_RESULT' } });
  assert.equal(envelopeExitCode(evaluated), 4);
  assert.deepEqual(evaluated.report, { kind: 'MIGRATION_SESSION_RESULT' });

  const stopped = buildEnvelope({ operation: 'verify', operationStatus: 'processed', decision: 'STOP_LIMIT', outcome: 'PASS', report: { kind: 'MIGRATION_SESSION_RESULT', status: 'PASS' } });
  assert.equal(envelopeExitCode(stopped), 3, 'a session stop prevails over the report even inside a built envelope');

  assert.throws(() => buildEnvelope({ operation: 'verify', operationStatus: 'failed', decision: 'COMPLETE', outcome: 'PASS' }),
    /INVALID_ENVELOPE_COMBINATION/);
  assert.throws(() => buildEnvelope({ operation: 'verify', operationStatus: 'refused', outcome: 'PASS' }),
    /INVALID_ENVELOPE_COMBINATION/, 'a refusal never carries an evaluation');
  assert.throws(() => buildEnvelope({ operation: 'verify', operationStatus: 'failed', decision: 'STOP_LIMIT' }),
    /INVALID_ENVELOPE_COMBINATION/, 'a processing failure never carries a session decision');
});

test('nextActions only name registered operations with registered flags and structured values', () => {
  const action = buildNextAction({
    operation: 'verify',
    args: { '--config': 'migration.json', '--workspace-root': '.', '--allow-project-commands': true },
    preconditions: ['SESSION_EXISTS'],
    requiresApproval: 'requires_authorization',
  });
  assert.deepEqual(action, {
    operation: 'verify',
    args: { '--config': 'migration.json', '--workspace-root': '.', '--allow-project-commands': true },
    preconditions: ['SESSION_EXISTS'],
    requiresApproval: 'requires_authorization',
  });

  // Never a shell: operations come from the migration-flow allowlist, never from runtime strings.
  assert.throws(() => buildNextAction({ operation: 'rm -rf /', requiresApproval: 'automatic', preconditions: ['X'] }), /INVALID_NEXT_ACTION/);
  // The registry lost every retired compatibility command with the kill switch (PLAN-V2 §8.2):
  // none of them can ever be recommended again, whether or not it still exists as a name.
  for (const retired of ['purge-raw', 'check-projects', 'prepare-migration', 'verify-migration',
    'start-migration-session', 'migration-session-status', 'update-migration-session', 'brief', 'apply-patch']) {
    assert.throws(() => buildNextAction({ operation: retired, requiresApproval: 'automatic', preconditions: ['X'] }),
      /INVALID_NEXT_ACTION/, `${retired} is retired and never recommended`);
  }
  // Never an unregistered flag on a registered operation.
  assert.throws(() => buildNextAction({ operation: 'prepare', args: { '--artifact-path': 'a', '--drop-history': true }, preconditions: ['X'], requiresApproval: 'automatic' }), /INVALID_NEXT_ACTION/);
  // Never a shell string smuggled through an argument value.
  assert.throws(() => buildNextAction({ operation: 'prepare', args: { '--config': 'a.json; cat secrets' }, preconditions: ['X'], requiresApproval: 'automatic' }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextAction({ operation: 'prepare', args: { '--config': 'a$(id)' }, preconditions: ['X'], requiresApproval: 'automatic' }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextAction({ operation: 'prepare', args: { '--config': 'a\nb' }, preconditions: ['X'], requiresApproval: 'automatic' }), /INVALID_NEXT_ACTION/);
  // Approval is one of exactly three explicit values; preconditions are structured codes.
  assert.throws(() => buildNextAction({ operation: 'status', requiresApproval: 'yes', preconditions: ['X'] }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextAction({ operation: 'status', requiresApproval: 'automatic', preconditions: [] }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextAction({ operation: 'status', requiresApproval: 'automatic', preconditions: ['run me now'] }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextAction({ operation: 'status', requiresApproval: 'automatic', preconditions: ['X'], args: { '--config': false } }), /INVALID_NEXT_ACTION/,
    'boolean flags are only ever recommended as enabled');
  assert.deepEqual([...REQUIRES_APPROVAL], ['automatic', 'after_correction', 'requires_authorization']);
});

test('REVIEW_REFERENCE and an unverified reference never authorize reference adoption', () => {
  const adopt = {
    operation: 'reference',
    args: { '--config': 'migration.json', '--workspace-root': '.', '--artifact-path': 'artifacts/re', '--owner-decision': 'owner-2026-1', '--allow-project-commands': true },
    preconditions: ['SESSION_EXISTS'],
    requiresApproval: 'requires_authorization',
  };
  // Proposing a reference update stays recommendable while review is pending...
  const propose = { ...adopt, args: { ...adopt.args } };
  delete propose.args['--owner-decision'];
  assert.equal(buildNextActions([propose], { decision: 'REVIEW_REFERENCE' }).length, 1);
  assert.equal(buildNextActions([adopt], { decision: 'COMPLETE' }).length, 1, 'adoption with an owner decision is allowed once the reference is healthy');
  // ...but adoption is refused under REVIEW_REFERENCE or any reference that is not VERIFIED.
  assert.throws(() => buildNextActions([adopt], { decision: 'REVIEW_REFERENCE' }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextActions([adopt], { referenceStatus: 'STALE' }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextActions([adopt], { referenceStatus: 'UNVERIFIABLE' }), /INVALID_NEXT_ACTION/);
  // Adoption always carries an explicit owner authorization, never an automatic one.
  assert.throws(() => buildNextActions([{ ...adopt, requiresApproval: 'automatic' }], { decision: 'COMPLETE' }), /INVALID_NEXT_ACTION/);
  assert.throws(() => buildNextActions([{ ...adopt, requiresApproval: 'after_correction' }], { decision: 'COMPLETE' }), /INVALID_NEXT_ACTION/);
});

test('nextActions never propose candidate edits: repair stays agent work between verifications', () => {
  const operations = ['init', 'doctor', 'prepare', 'verify', 'status', 'reference'];
  for (const operation of operations) {
    const action = buildNextAction({ operation, preconditions: ['CONFIG_VALID'], requiresApproval: 'automatic' });
    assert.ok(!/edit|write|patch|repair/i.test(action.operation), action.operation);
  }
  assert.throws(() => buildNextAction({ operation: 'repair', preconditions: ['X'], requiresApproval: 'automatic' }), /INVALID_NEXT_ACTION/,
    'repair is not a command (PLAN-V2 §3)');
});
