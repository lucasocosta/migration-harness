import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { canonical, migrationConfigHash, migrationReferenceHash } from '../../packages/core/dist/index.js';
import { collectMigrationReference, ReferenceWeakeningError } from '../../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../../packages/engine/dist/project-checks.js';
import { prepareMigration } from '../../packages/engine/dist/migration-operations.js';
import { startMigrationSession, verifyMigrationSession, inspectMigrationSession, updateMigrationSessionReference, migrationSessionPath } from '../../packages/engine/dist/migration-session.js';
import { ArtifactStore } from '../../packages/engine/dist/artifacts.js';
import { buildWorkspace, write } from '../helpers/build-workspace.mjs';

const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const EMAIL = 'Lucas@Example.Test';
let chromiumSkip = null;
try { const probe = await chromium.launch({ headless: true }); await probe.close(); } catch { chromiumSkip = 'Chromium is unavailable'; }

const pageHtml = '<!doctype html><html lang="en"><head><title>Acceptance fixture</title></head><body>'
  + '<h1 id="view">Profile</h1><label for="email">Email</label><input id="email" type="text" value="">'
  + '<button id="save" type="button">Save</button><button id="reorder" type="button">Reorder</button>'
  + '<p role="alert" id="required" aria-label="Email required" hidden>Email required</p>'
  + '<p role="alert" id="saved" aria-label="Saved" hidden>Saved</p>'
  + '<p role="alert" id="reordered" aria-label="Reordered" hidden>Reordered</p>'
  + '<script src="/app.js"></script></body></html>';
const appJs = (save, reorder) => `const $ = (id) => document.getElementById(id);
const validEmail = (value) => value.includes('@');
async function put(path, payload) {
  const response = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return response.ok;
}
$('save').onclick = async () => {
${save}
};
$('reorder').onclick = async () => {
  if (await put('/api/reorder', { email: $('email').value })) {
    $('reordered').hidden = false;
${reorder}
  }
};`;
const CORRECT_SAVE = `  const value = $('email').value;
  if (!validEmail(value)) { $('required').hidden = false; return; }
  if (await put('/api/customer', { email: value })) $('saved').hidden = false;`;
const BROKEN_SAVE = `  const value = $('email').value.toLowerCase().trim();
  if (await put('/api/customer', { email: value })) $('saved').hidden = false;`;
const CORRECT_NAV = `    $('view').textContent = 'Order summary';
    history.pushState({}, '', '/summary');`;
const BROKEN_NAV = `    $('view').textContent = 'Elsewhere';
    history.pushState({}, '', '/elsewhere');`;
const buildScript = app => `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.html', ${JSON.stringify(pageHtml)});
writeFileSync('dist/app.js', ${JSON.stringify(app)});`;

function acceptanceConfig(sourceUrl, targetUrl, { navigation = false } = {}) {
  const scenario = (id, steps, mocks) => ({
    definition: { scenarioId: id, unitId: 'profile', name: id, description: `Acceptance ${id} behavior`, entryUrl: `${sourceUrl}/`,
      preconditions: { ...(mocks ? { mockInitialApiResponses: mocks } : {}) }, steps, testDataProfile: 'standard' },
    required: true, fixtureRoot: 'fixtures',
    bindings: { source: { entryUrl: `${sourceUrl}/`, steps: [] }, target: { entryUrl: `${targetUrl}/`, steps: [] } },
  });
  const customer = [{ urlPattern: '**/api/customer', method: 'PUT', statusCode: 200, fixturePath: 'saved.json' }];
  const project = (side, baseUrl, extra) => ({ root: side, baseUrl, relevantFiles: ['build.mjs'],
    commands: [{ id: 'build', kind: 'build', argv: [process.execPath, 'build.mjs'], cwd: '.', timeoutMs: 15000 }],
    build: { commandId: 'build', outputDir: 'dist', cleanOutput: true }, ...extra });
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'acceptance-flow', profile: 'standard',
    source: project('source', sourceUrl), target: project('target', targetUrl, { writePaths: ['build.mjs'], protectedPaths: [] }),
    scenarios: [
      scenario('save', [{ stepId: 'email', action: 'fill', targetRole: 'textbox', targetName: 'Email', inputValue: EMAIL },
        { stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save',
          completionSignal: { type: 'LOCATOR_VISIBLE', targetRole: 'alert', targetName: 'Saved', timeoutMs: 5000 } }], customer),
      scenario('guard', [{ stepId: 'click-empty', action: 'click', targetRole: 'button', targetName: 'Save' }], customer),
      ...(navigation ? [scenario('summary', [{ stepId: 'email', action: 'fill', targetRole: 'textbox', targetName: 'Email', inputValue: EMAIL },
        { stepId: 'reorder', action: 'click', targetRole: 'button', targetName: 'Reorder',
          completionSignal: { type: 'LOCATOR_VISIBLE', targetRole: 'alert', targetName: 'Reordered', timeoutMs: 5000 } }],
        [{ urlPattern: '**/api/reorder', method: 'PUT', statusCode: 200, fixturePath: 'reordered.json' }])] : []),
    ],
    checks: ['source', 'target'].map(side => ({ id: `build-${side}`, side, commandId: 'build', required: true })),
    requirements: [{ id: 'empty-submit-forbidden', scenarioId: 'guard', description: 'An invalid email must never reach the service',
      origin: 'EXISTING_TEST', sourceReference: 'acceptance-fixture', required: true,
      assertion: { checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NO_REQUEST', method: 'PUT', pathPattern: '**/api/customer' } } },
      ...(navigation ? [{ id: 'reorder-lands-on-summary', scenarioId: 'summary', description: 'Reordering must land on the summary route',
        origin: 'SPECIFICATION', sourceReference: 'acceptance-fixture', required: true,
        assertion: { checkpoint: { kind: 'SCENARIO_END' }, claim: { kind: 'NAVIGATED', pathPattern: '**/summary' } } }] : [])],
    acceptedDifferences: [], policy: { sanitization: { allowedPayloadKeys: ['email'] } }, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'en-US', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 600000 },
  };
}

const codes = (report, code) => report.diagnostics.filter(item => item.code === code).map(item => `${item.code}${item.scenarioId ? ` scenario=${item.scenarioId}` : ''}${item.detailCode ? ` detail=${item.detailCode}` : ''}`);
const scenarioOf = (report, id) => report.scenarios.find(item => item.scenarioId === id);

// A fresh tmp workspace with the correct source app and the three-defect candidate, free ports and fixtures.
async function acceptanceWorkspace(t) {
  const { root, config: seed } = await buildWorkspace();
  const sourceUrl = seed.source.baseUrl, targetUrl = seed.target.baseUrl;
  await write(root, 'source/build.mjs', buildScript(appJs(CORRECT_SAVE, CORRECT_NAV)));
  await write(root, 'target/build.mjs', buildScript(appJs(BROKEN_SAVE, BROKEN_NAV)));
  await write(root, 'fixtures/saved.json', '{"saved":true}\n');
  await write(root, 'fixtures/reordered.json', '{"reordered":true}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = acceptanceConfig(sourceUrl, targetUrl);
  const input = { config, workspaceRoot: root };
  const targetFile = () => readFile(join(root, 'target/build.mjs'), 'utf8');
  const writeTarget = async app => write(root, 'target/build.mjs', buildScript(app));
  return { root, input, config, configV2: acceptanceConfig(sourceUrl, targetUrl, { navigation: true }), targetFile, writeTarget };
}
const cleanPrivate = (t, root, dir) => t.after(() => rm(new ArtifactStore(join(root, dir)).privateRoot, { recursive: true, force: true }));

async function realSession(t, f) {
  const preparation = await prepareMigration({ ...f.input, artifactPath: 'artifacts/prepared', allowProjectCommands: true });
  assert.equal(preparation.kind, 'MIGRATION_PREPARATION'); assert.equal(preparation.status, 'PASS');
  cleanPrivate(t, f.root, 'artifacts/prepared');
  await startMigrationSession({ ...f.input, preparation });
  return preparation;
}

async function syntheticSession(t, f, { navigation = false } = {}) {
  const config = navigation ? f.configV2 : f.config;
  const input = { config, workspaceRoot: f.root };
  const reference = await collectMigrationReference({ ...input,
    sourceObservations: { status: 'STABLE', runs: 2, executionHashes: [digest('source'), digest('source')] } });
  const baseline = await runProjectChecks({ ...input, phase: 'baseline', allowProjectCommands: true });
  const preparation = { kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS', reference,
    referenceHash: migrationReferenceHash(reference), artifactPath: 'artifacts/synthetic-prepared', keyId: digest('dummy'), sourceEvidence: [], baseline,
    sourceBuild: { kind: 'SERVED_BUILD', version: '1', side: 'source', runId: randomUUID(), origin: config.source.baseUrl,
      configurationHash: migrationConfigHash(config), inputHash: digest('input'), buildHash: digest('build'), fileCount: 1, totalBytes: 1 } };
  await startMigrationSession({ ...input, preparation });
  return input;
}

test('acceptance: one standard session repairs value, validation and navigation defects across a mid-flow reference refresh', async t => {
  if (chromiumSkip) return t.skip(chromiumSkip);
  const f = await acceptanceWorkspace(t);
  await realSession(t, f);
  const sessionPath = migrationSessionPath(f.config);
  const envelope = async () => readFile(join(f.root, `${sessionPath}/session.json`), 'utf8');
  const firstEnvelope = await envelope();
  const trail = { used: [], remaining: [] };
  const track = async config => { const status = await inspectMigrationSession({ ...f.input, config }); trail.used.push(status.attemptsUsed); trail.remaining.push(status.remainingMs); return status; };

  // Step 2: the planted value and validation defects fail the session-owned verification.
  const first = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(first.decision, 'REPAIR_IMPLEMENTATION');
  assert.equal(first.outcome, 'FAIL'); assert.equal(first.report.status, 'FAIL');
  assert.ok(codes(first.report, 'BEHAVIOR_DIVERGENCE').some(line => line.includes('scenario=save')), `save divergence in ${codes(first.report, 'BEHAVIOR_DIVERGENCE')}`);
  assert.ok(codes(first.report, 'REQUIREMENT_VIOLATED').some(line => line.includes('scenario=guard')), `guard requirement violated in ${codes(first.report, 'REQUIREMENT_VIOLATED')}`);
  await track(f.input.config);

  // Step 3: repair the saved value and the required validation inside target.writePaths only.
  await f.writeTarget(appJs(CORRECT_SAVE, BROKEN_NAV));
  const second = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(second.decision, 'COMPLETE'); assert.equal(second.report.status, 'PASS');
  let status = await track(f.input.config);
  assert.equal(status.lastReportMatchesWorkspace, true); assert.equal(status.generation, 0);

  // Step 4: reference refresh for coverage extension preserves identity, history and budgets.
  const before = { attemptsUsed: status.attemptsUsed, attemptsRemaining: status.attemptsRemaining };
  const update = await updateMigrationSessionReference({ ...f.input, config: f.configV2, artifactPath: 'artifacts/reprepared', allowProjectCommands: true });
  cleanPrivate(t, f.root, 'artifacts/reprepared');
  assert.equal(update.kind, 'MIGRATION_SESSION_REFERENCE_UPDATED');
  assert.equal(update.generation, 1, 'the session itself is generation zero');
  assert.equal(update.classification, 'EXTENSION'); assert.equal(update.referenceVersion, 2);
  assert.deepEqual({ attemptsUsed: update.attemptsUsed, attemptsRemaining: update.attemptsRemaining }, before);
  status = await track(f.configV2);
  assert.equal(status.generation, 1); assert.equal(status.referenceStatus, 'VERIFIED');
  assert.equal(status.lastReportMatchesWorkspace, false, 'the previous-generation PASS is superseded, not current');
  assert.equal(migrationSessionPath(f.configV2), sessionPath, 'the refresh stays inside the same session');

  // Step 5: the newly covered navigation route exposes the third defect.
  const third = await verifyMigrationSession({ ...f.input, config: f.configV2, allowProjectCommands: true });
  assert.equal(third.decision, 'REPAIR_IMPLEMENTATION');
  assert.equal(third.report.status, 'FAIL');
  assert.equal(third.report.identity.configurationHash, migrationConfigHash(f.configV2));
  assert.ok(codes(third.report, 'BEHAVIOR_DIVERGENCE').some(line => line.includes('scenario=summary')), `navigation divergence in ${codes(third.report, 'BEHAVIOR_DIVERGENCE')}`);
  assert.ok(codes(third.report, 'REQUIREMENT_VIOLATED').some(line => line.includes('scenario=summary')), `navigation requirement violated in ${codes(third.report, 'REQUIREMENT_VIOLATED')}`);
  await track(f.configV2);

  // Step 6: repair the navigation and finish.
  await f.writeTarget(appJs(CORRECT_SAVE, CORRECT_NAV));
  const fourth = await verifyMigrationSession({ ...f.input, config: f.configV2, allowProjectCommands: true });
  assert.equal(fourth.decision, 'COMPLETE'); assert.equal(fourth.report.status, 'PASS');
  status = await track(f.configV2);
  assert.equal(status.generation, 1); assert.equal(status.lastReportMatchesWorkspace, true);
  assert.equal(status.attemptsUsed, 4); assert.equal(status.attemptsRemaining, 0);
  assert.ok(status.attempts.every(item => item.generation >= 0));
  assert.deepEqual(status.attempts.map(item => item.generation), [0, 0, 1, 1], 'attempt history records both reference generations');

  // Budget integrity: attempts only accumulate, time only decreases, session identity never moves.
  assert.deepEqual(trail.used, [1, 2, 2, 3, 4]);
  assert.ok(trail.remaining.every(ms => ms <= f.config.limits.maxDurationMs));
  assert.deepEqual([...trail.remaining].sort((a, b) => b - a), trail.remaining, 'remaining active time never increases');
  assert.equal(await envelope(), firstEnvelope, 'session.json is byte-identical after the whole flow');
});

test('acceptance negative: repeated identical failure stops for no progress', async t => {
  if (chromiumSkip) return t.skip(chromiumSkip);
  const f = await acceptanceWorkspace(t);
  await realSession(t, f);
  const first = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(first.decision, 'REPAIR_IMPLEMENTATION'); assert.equal(first.attemptsUsed, 1);
  const second = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(second.decision, 'STOP_NO_PROGRESS', 'the same candidate and fingerprint cannot keep consuming the session');
  assert.equal(second.attemptsUsed, 2);
  assert.equal((await inspectMigrationSession(f.input)).stop, 'STOP_NO_PROGRESS');
});

test('acceptance negative: criteria weakening is refused and the session keeps its generation and budget', async t => {
  if (chromiumSkip) return t.skip(chromiumSkip);
  const f = await acceptanceWorkspace(t);
  const input = await syntheticSession(t, f, { navigation: true });
  const weakened = { ...f.configV2, requirements: f.configV2.requirements.filter(item => item.id !== 'empty-submit-forbidden') };
  await assert.rejects(updateMigrationSessionReference({ ...input, config: weakened, artifactPath: 'artifacts/update-refused', allowProjectCommands: true }),
    error => error instanceof ReferenceWeakeningError);
  const status = await inspectMigrationSession(input);
  assert.equal(status.generation, 0); assert.equal(status.attemptsUsed, 0); assert.equal(status.attemptsRemaining, 4);
  assert.equal(await readFile(join(f.root, `${migrationSessionPath(f.configV2)}/generations.json`), 'utf8').catch(() => 'missing'), 'missing');
});

test('acceptance negative: off-scope edits are refused without consuming an attempt or fabricating a report', async t => {
  if (chromiumSkip) return t.skip(chromiumSkip);
  const f = await acceptanceWorkspace(t);
  const input = await syntheticSession(t, f);
  await write(f.root, 'target/user.txt', 'unrelated work');
  const result = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.equal(result.decision, 'REFUSED_SCOPE');
  assert.ok(result.findings.some(finding => finding.code === 'OUTSIDE_WRITE_SCOPE' && finding.side === 'target'));
  assert.equal(result.attemptsUsed, 0); assert.ok(!('report' in result));
  assert.equal((await inspectMigrationSession(input)).attemptsUsed, 0);
});

test('acceptance negative: an inconclusive verification is never reported as success', async t => {
  if (chromiumSkip) return t.skip(chromiumSkip);
  const f = await acceptanceWorkspace(t);
  await realSession(t, f);
  await write(f.root, 'target/build.mjs', 'process.exit(2);\n');
  const result = await verifyMigrationSession({ ...f.input, allowProjectCommands: true });
  assert.notEqual(result.decision, 'COMPLETE', 'an operationally broken run cannot complete');
  assert.equal(result.outcome, 'INCONCLUSIVE');
  assert.ok(!result.report || result.report.status !== 'PASS');
  const status = await inspectMigrationSession(f.input);
  assert.notEqual(status.lastReportMatchesWorkspace, true);
});
