/**
 * Fallback elimination for the build-cache view (docs/PLAN-V2.md §4): a warm cycle whose view of
 * the configuration would leave a side without any required check — `build-target` is the only
 * required target check and it is satisfied from a verified entry — must apply the hit instead of
 * running everything. The reassembled report stays full-config (exactly one row per declared check,
 * mirrored `baselineComparison`, full-config `inputHashAfter`) and equals the no-cache report of
 * the same workspace; every other schema refusal, and every other inconsistency of the cycle,
 * still falls back to a plain full run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, parseMigrationConfig } from '../packages/core/dist/index.js';
import { withProjectBuildServers } from '../packages/engine/dist/build-servers.js';
import { parseProjectCheckConfig } from '../packages/engine/dist/project-checks.js';
import { PhaseTimer } from '../packages/engine/dist/timings.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

const BUILD_SCRIPT = `import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/build.log', 'run\\n');
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;
const LINT_SCRIPT = `import { mkdirSync, appendFileSync } from 'node:fs';
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/lint.log', 'run\\n');`;

async function fixture(t) {
  const { root, config } = await buildWorkspace();
  // The build cache is opt-in (default off); this file exercises the hit/fallback path with it enabled.
  process.env.MIGRATION_HARNESS_BUILD_CACHE = '1';
  t.after(() => { delete process.env.MIGRATION_HARNESS_BUILD_CACHE; });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const side of ['source', 'target']) await write(root, `${side}/build.mjs`, BUILD_SCRIPT);
  await write(root, 'source/lint.mjs', LINT_SCRIPT);
  config.source.commands.push({ id: 'lint', kind: 'lint', argv: [process.execPath, 'lint.mjs'], cwd: '.', timeoutMs: 3000 });
  config.checks.push({ id: 'lint-source', side: 'source', commandId: 'lint', required: true });
  // The scenario under test: the target's only required check is the build check, so satisfying it
  // from cache empties the required target checks of the view built for the remaining checks.
  assert.deepEqual(config.checks.filter(check => check.side === 'target').map(check => check.id), ['build-target']);
  assert.equal(config.checks.filter(check => check.side === 'target' && check.required).length, 1);
  const lines = async name => (await readFile(join(root, 'markers', name), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  return {
    root, config, lines,
    cycle: (options = {}) => withProjectBuildServers(
      { config, workspaceRoot: root, allowProjectCommands: true, ...options }, async () => 'completed'),
  };
}

/** Drop the only two fields that legitimately differ between two runs of the same workspace. */
const normalize = report => JSON.parse(JSON.stringify(report, (key, value) =>
  key === 'durationMs' || key === 'evaluatedAt' ? undefined : value));

/** The view the cache builds when every build check of the configuration is satisfied from cache. */
function satisfiedView(config) {
  const view = structuredClone(config);
  delete view.source.build;
  delete view.target.build;
  view.checks = config.checks.filter(check => check.id === 'lint-source');
  return view;
}

test('a warm cycle whose view empties the required target checks applies the hit instead of falling back', async t => {
  const f = await fixture(t);
  const first = await f.cycle();
  assert.equal(first.cache.source.status, 'MISS');
  assert.equal(first.cache.target.status, 'MISS');
  assert.equal(first.checks.checks.length, f.config.checks.length, 'one row per declared check');
  assert.equal(first.checks.status, 'PASS');
  assert.equal(await f.lines('build.log'), 2, 'cycle 1 executed one required build per side');
  assert.equal(await f.lines('lint.log'), 1, 'cycle 1 executed the remaining required check');

  const timings = new PhaseTimer();
  const warm = await f.cycle({ timings });
  assert.equal(warm.cache.source.status, 'HIT', 'the view no longer forces a fallback');
  assert.equal(warm.cache.target.status, 'HIT');
  assert.equal(warm.cache.target.reason, undefined, 'HIT_NOT_APPLIED / REPORT_NOT_APPLICABLE is gone here');
  const run = timings.snapshot('cache-hit-fallback').phases.find(phase => phase.detail?.step === 'run-commands');
  assert.ok(run, 'the cycle recorded the check run');
  assert.equal(run.detail.satisfiedChecks, 2, 'both build checks were satisfied from the cache');
  assert.equal(run.detail.executedChecks, 1, 'only the remaining check executed');
  assert.equal(await f.lines('build.log'), 2, 'the warm cycle never re-executes a build');
  assert.equal(await f.lines('lint.log'), 2, 'the warm cycle really executes the remaining check');

  assert.equal(warm.checks.checks.length, f.config.checks.length, 'exactly one row per declared check');
  assert.deepEqual(warm.checks.checks.map(row => row.checkId), f.config.checks.map(check => check.id));
  assert.equal(warm.checks.status, 'PASS');
  assert.deepEqual(warm.checks.findings, []);
  assert.equal(warm.checks.inputHashAfter, warm.checks.preflight.inputHash, 'inputHashAfter is the full-config hash');
  for (const row of warm.checks.checks) {
    assert.equal(row.baselineComparison, 'NOT_COMPARED', `${row.checkId} mirrors the baseline comparison`);
    const command = f.config[row.side].commands.find(item => item.id === row.commandId);
    assert.equal(row.commandHash, digest(command), `${row.checkId} records its real command hash`);
  }
  const buildRow = warm.checks.checks.find(row => row.checkId === 'build-target');
  assert.equal(buildRow.status, 'PASS');
  assert.equal(buildRow.output.omitted, true, 'the satisfied row carries the recorded build outcome');
});

test('the applied hit report equals the no-cache report for the same workspace', async t => {
  const f = await fixture(t);
  const stored = await f.cycle();
  assert.equal(stored.cache.source.status, 'MISS');
  assert.equal(await f.lines('build.log'), 2);

  process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE = '1';
  let withoutCache;
  try { withoutCache = await f.cycle(); } finally { delete process.env.MIGRATION_HARNESS_DISABLE_BUILD_CACHE; }
  assert.equal(withoutCache.cache.source.status, 'DISABLED');
  assert.equal(withoutCache.checks.checks.length, f.config.checks.length);

  const hit = await f.cycle();
  assert.equal(hit.cache.source.status, 'HIT');
  assert.equal(hit.cache.target.status, 'HIT');
  assert.equal(hit.checks.status, withoutCache.checks.status);
  assert.deepEqual(normalize(hit.checks), normalize(withoutCache.checks),
    'a hit changes only how the build rows were obtained, never what the report proves');
  assert.equal(hit.builds.source.buildHash, withoutCache.builds.source.buildHash,
    'the restored artifact is byte-identical to a fresh build');
  assert.equal(hit.builds.target.buildHash, withoutCache.builds.target.buildHash);
  assert.equal(await f.lines('build.log'), 4, 'only the first two cycles built');
  assert.equal(await f.lines('lint.log'), 3, 'every cycle executed the remaining check');
});

test('the view permission is pointwise: the real schema and every other refusal are untouched', async t => {
  const f = await fixture(t);
  const view = satisfiedView(f.config);
  assert.throws(() => parseMigrationConfig(view), /At least one required target project check is necessary/,
    'the real configuration schema still refuses the view — it is never relaxed');
  assert.doesNotThrow(() => parseMigrationConfig(f.config), 'a real configuration parses unchanged');

  const permitted = parseProjectCheckConfig(view, true);
  assert.equal(permitted.checks.length, 1, 'the view alone is what the permission accepts');
  assert.throws(() => parseProjectCheckConfig(view), /At least one required target project check is necessary/,
    'without the flag the parse stays strict');

  // The permission never masks a second issue: any real inconsistency keeps falling back.
  const secondIssue = structuredClone(view);
  secondIssue.checks.push({ id: 'ghost-source', side: 'source', commandId: 'missing-command', required: false });
  assert.throws(() => parseProjectCheckConfig(secondIssue, true),
    /Check must reference a project validation command/);
  const emptyChecks = structuredClone(view);
  emptyChecks.checks = [];
  assert.throws(() => parseProjectCheckConfig(emptyChecks, true), /checks/i);
});

test('a real inconsistency on a warm cycle still falls back to a full run', async t => {
  const f = await fixture(t);
  await f.cycle();
  const baseline = (await f.cycle({ phase: 'baseline' })).checks;
  assert.equal(baseline.phase, 'baseline');
  const compared = await f.cycle({ baseline });
  assert.equal(compared.cache.target.status, 'HIT', 'a usable baseline applies the hit');
  assert.equal(compared.checks.checks.length, f.config.checks.length);
  for (const row of compared.checks.checks) {
    assert.equal(row.baselineComparison, 'UNCHANGED', `${row.checkId} mirrors the baseline comparison on an applied hit`);
  }

  // A baseline the session accepts but `runProjectChecksWithCache` cannot use (it no longer names
  // this migration): the cycle must fall back to a plain full run, which reports BASELINE_MISMATCH
  // instead of ever applying the hit.
  const stale = { ...baseline, migrationId: 'other-migration',
    preflight: { ...baseline.preflight, migrationId: 'other-migration' } };
  await assert.rejects(f.cycle({ baseline: stale }), error => {
    assert.equal(error.code, 'BUILD_CHECK_FAILED');
    assert.deepEqual(error.checks.findings, [{ code: 'BASELINE_MISMATCH' }]);
    assert.equal(error.checks.status, 'INCONCLUSIVE');
    assert.equal(error.checks.checks.length, f.config.checks.length, 'the fallback ran every declared check');
    return true;
  });
  assert.equal(await f.lines('build.log'), 2, 'the refused cycle never applies the hit nor executes a command');
  assert.equal(await f.lines('lint.log'), 3, 'the three earlier cycles executed their remaining check; the refused one did not');
});
