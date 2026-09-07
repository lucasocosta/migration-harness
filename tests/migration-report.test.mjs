import test from 'node:test';
import assert from 'node:assert/strict';
import { MigrationConfigSchema, parseMigrationConfig, migrationConfigHash, parseMigrationReport } from '../packages/core/dist/index.js';
import { buildMigrationReport, adaptLegacyComparison } from '../packages/quality-gates/dist/migration-report.js';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';
import { trace } from './helpers.mjs';

const hash = 'a'.repeat(64);
const time = '2026-09-06T12:00:00.000Z';
function config() {
  const project = (name, port) => ({
    root: `apps/${name}`, baseUrl: `http://localhost:${port}`, relevantFiles: ['src/page.tsx', 'package.json'],
    commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
  });
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'customer',
    source: project('angular', 4200), target: { ...project('react', 5173), writePaths: ['src/page.tsx', 'src/page.css'], protectedPaths: ['src/auth'] },
    scenarios: [{
      definition: { scenarioId: 'update-customer', unitId: 'customer', name: 'Save', description: 'Synthetic save',
        entryUrl: 'http://localhost:4200/customers/1', preconditions: {}, testDataProfile: 'standard',
        steps: [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }] },
      required: true, fixtureRoot: 'migrations/customer/scenarios/fixtures',
      bindings: { source: { entryUrl: 'http://localhost:4200/customers/1', steps: [] },
        target: { entryUrl: 'http://localhost:5173/clientes/1', steps: [{ stepId: 'save', targetRole: 'button', targetName: 'Salvar' }] } },
    }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [{ id: 'saved-value', scenarioId: 'update-customer', description: 'Save the edited value', origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true }],
    acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 3, maxRepairAttempts: 3, maxDurationMs: 600000 },
  };
}
function evidence(configuration = config()) {
  const identity = { migrationId: configuration.migrationId, configurationHash: migrationConfigHash(configuration), referenceHash: hash, candidateHash: hash, buildHash: hash };
  return { identity, evaluatedAt: time, referenceVerified: true,
    scenarios: [{ identity: { ...identity }, scenarioId: 'update-customer', status: 'PASS', requirements: [{ requirementId: 'saved-value', status: 'PASS' }], diagnostics: [], evidencePaths: ['results/scenario.json'] }],
    checks: [{ identity: { ...identity }, checkId: 'target-build', status: 'PASS', diagnostics: [], evidencePaths: ['results/build.json'] }],
  };
}

test('migration config is versioned, strict, optional-contract and supports scoped normal edits', () => {
  assert.deepEqual(parseMigrationConfig(config()), config());
  for (const mutate of [
    c => { c.version = '2'; }, c => { c.unknown = true; }, c => { c.policy.assistant = { allowedPackages: ['react'] }; },
    c => { c.scenarios = []; }, c => { c.scenarios[0].required = false; }, c => { c.checks = []; },
    c => { c.checks[0].required = false; }, c => { c.checks[0].commandId = 'missing'; },
    c => { c.target.commands[0].kind = 'serve'; }, c => { c.target.commands[0].argv = []; },
    c => { c.target.commands[0].timeoutMs = 0; }, c => { c.target.commands.push(c.target.commands[0]); },
    c => { c.requirements[0].scenarioId = 'missing'; }, c => { c.requirements.push(c.requirements[0]); },
    c => { c.requirements[0].origin = 'CRITICAL_CONTRACT'; }, c => { c.limits.sourceRuns = 1; },
    c => { c.policy.network = { comparePayloadValues: false }; },
    c => { c.policy.network = { compareResponseValues: false }; },
    c => { c.policy.network = { comparePayloadShape: false }; },
    c => { c.reset = { kind: 'COMMANDS', sourceCommandId: 'build', targetCommandId: 'build' }; },
  ]) { const c = config(); mutate(c); assert.throws(() => parseMigrationConfig(c)); }
});

test('config rejects lexical escapes, overlapping scope and incompatible scenario bindings', () => {
  for (const mutate of [
    c => { c.target.root = c.source.root; }, c => { c.target.root = `${c.source.root}/target`; },
    c => { c.source.root = '../angular'; }, c => { c.target.writePaths = ['src/../auth.ts']; },
    c => { c.target.writePaths = ['src\\page.ts']; }, c => { c.target.writePaths = ['.git/config']; },
    c => { c.target.writePaths = ['.env.local']; }, c => { c.target.writePaths = ['.migration-private/raw.json']; },
    c => { c.target.writePaths = ['src']; }, c => { c.target.commands[0].cwd = '/tmp'; },
    c => { c.target.baseUrl = 'http://user:password@localhost'; },
    c => { c.scenarios[0].bindings.target.entryUrl = 'http://other.test/page'; },
    c => { c.scenarios[0].bindings.target.steps[0].stepId = 'unknown'; },
    c => { c.scenarios[0].bindings.target.steps[0].targetRole = 'invented-role'; },
    c => { c.scenarios[0].bindings.target.steps.push(c.scenarios[0].bindings.target.steps[0]); },
    c => { c.scenarios[0].definition.preconditions.mockInitialApiResponses = [{ urlPattern: '**/api', method: 'GET', statusCode: 200, fixturePath: '../escape.json' }]; },
  ]) { const c = config(); mutate(c); assert.throws(() => parseMigrationConfig(c)); }
  const malformed = config(); malformed.target.baseUrl = 'invalid';
  assert.equal(MigrationConfigSchema.safeParse(malformed).success, false);
});

test('configuration fingerprint includes nested criteria, bindings and native command arguments', () => {
  const c = config(), initial = migrationConfigHash(c);
  assert.equal(migrationConfigHash(Object.fromEntries(Object.entries(c).reverse())), initial);
  for (const mutate of [
    c => { c.requirements[0].required = false; },
    c => { c.scenarios[0].bindings.target.steps[0].targetName = 'Other'; },
    c => { c.target.commands[0].argv.push('--mode=test'); },
    c => { c.policy.network = { volatilePayloadFields: ['email'] }; },
  ]) { const changed = config(); mutate(changed); assert.notEqual(migrationConfigHash(changed), initial); }
});

test('aggregate separates preservation, requirements and native checks', () => {
  const c = config(), input = evidence(c);
  const result = buildMigrationReport(c, input);
  assert.equal(result.status, 'PASS'); assert.equal(result.preservation, 'PASS'); assert.equal(result.requirements, 'PASS');
  assert.equal(result.projectChecks, 'PASS'); assert.deepEqual(result.requiredCoverage.scenarios, { expected: 1, received: 1 });
  assert.deepEqual(parseMigrationReport(result), result);
  input.scenarios[0].requirements[0].status = 'FAIL';
  const failure = buildMigrationReport(c, input);
  assert.equal(failure.status, 'FAIL'); assert.equal(failure.preservation, 'PASS'); assert.equal(failure.requirements, 'FAIL');
  const noRequirements = config(); noRequirements.requirements = [];
  const without = evidence(noRequirements); without.scenarios[0].requirements = [];
  assert.equal(buildMigrationReport(noRequirements, without).requirements, 'NOT_APPLICABLE');
  assert.equal(buildMigrationReport(noRequirements, without).status, 'PASS');
});

test('partial or inconsistent evidence never becomes aggregate success', () => {
  for (const [mutate, code] of [
    [e => { e.scenarios = []; }, 'MISSING_SCENARIO'],
    [e => { e.checks = []; }, 'MISSING_CHECK'],
    [e => { e.scenarios[0].requirements = []; }, 'MISSING_REQUIREMENT'],
    [e => { e.referenceVerified = false; }, 'REFERENCE_UNVERIFIED'],
    [e => { e.identity.configurationHash = 'b'.repeat(64); }, 'CONFIGURATION_MISMATCH'],
    [e => { e.scenarios[0].identity.buildHash = 'b'.repeat(64); }, 'STALE_EVIDENCE'],
    [e => { e.checks[0].identity.candidateHash = 'b'.repeat(64); }, 'STALE_EVIDENCE'],
    [e => { e.scenarios[0].identity.referenceHash = 'b'.repeat(64); }, 'STALE_EVIDENCE'],
    [e => { e.scenarios.push(e.scenarios[0]); }, 'DUPLICATE_EVIDENCE'],
    [e => { e.checks.push(e.checks[0]); }, 'DUPLICATE_EVIDENCE'],
    [e => { e.scenarios[0].requirements.push(e.scenarios[0].requirements[0]); }, 'DUPLICATE_EVIDENCE'],
    [e => { e.scenarios[0].requirements[0].requirementId = 'unknown'; }, 'UNKNOWN_EVIDENCE'],
    [e => { e.scenarios[0].scenarioId = 'unknown'; }, 'UNKNOWN_EVIDENCE'],
    [e => { e.checks[0].checkId = 'unknown'; }, 'UNKNOWN_EVIDENCE'],
  ]) {
    const c = config(), input = evidence(c); mutate(input);
    const result = buildMigrationReport(c, input);
    assert.equal(result.status, 'INCONCLUSIVE', code);
    assert.ok(result.diagnostics.some(d => d.code === code), code);
  }
});

test('required native failures block, advisory failures remain visible', () => {
  const c = config(), e = evidence(c); e.checks[0].status = 'FAIL';
  assert.equal(buildMigrationReport(c, e).status, 'FAIL');
  c.checks.push({ id: 'advisory-build', side: 'source', commandId: 'build', required: false });
  const advisory = evidence(c); advisory.checks.push({ ...advisory.checks[0], checkId: 'advisory-build', status: 'FAIL' });
  const result = buildMigrationReport(c, advisory);
  assert.equal(result.status, 'PASS'); assert.equal(result.checks[1].status, 'FAIL');
});

test('legacy comparison adapter never treats shape-only equality or apply PASS as migration success', () => {
  const identity = evidence().identity;
  const validator = new EquivalenceValidator();
  const equal = validator.validate({ source: trace(), target: trace('PUT', { email: 'different@example.test' }) });
  assert.equal(equal.status, 'EQUIVALENT');
  assert.equal(adaptLegacyComparison(equal, identity).status, 'INCONCLUSIVE');
  assert.throws(() => adaptLegacyComparison({ kind: 'APPLY_RESULT', status: 'PASS' }, identity));
  const different = validator.validate({ source: trace(), target: trace('POST') });
  different.divergences[0].message = 'SECRET_EMAIL alice@private.test';
  different.divergences[0].source = { secret: 'do-not-copy' };
  const adapted = adaptLegacyComparison(different, identity);
  assert.equal(adapted.status, 'FAIL');
  assert.ok(!JSON.stringify(adapted).includes('SECRET_EMAIL'));
  assert.ok(!JSON.stringify(adapted).includes('do-not-copy'));
  assert.deepEqual(adapted.requirements, []);
  const input = evidence(); input.scenarios = [adapted];
  assert.equal(buildMigrationReport(config(), input).status, 'INCONCLUSIVE');
});

test('report schema rejects contradictory PASS, unknown fields and private evidence paths', () => {
  const c = config();
  const missing = evidence(c); missing.checks = [];
  const incomplete = buildMigrationReport(c, missing); incomplete.status = 'PASS';
  assert.throws(() => parseMigrationReport(incomplete));
  const changedBuild = buildMigrationReport(c, evidence(c)); changedBuild.identity.buildHash = 'b'.repeat(64);
  assert.throws(() => parseMigrationReport(changedBuild));
  for (const mutate of [
    e => { e.scenarios[0].diagnostics = [{ code: 'EXECUTION_INCOMPLETE' }]; },
    e => { e.scenarios[0].diagnostics = [{ code: 'LEGACY_WARNING', message: 'runtime text' }]; },
    e => { e.scenarios[0].evidencePaths = ['../private.json']; },
    e => { e.scenarios[0].evidencePaths = ['.migration-private/raw.json']; },
  ]) { const e = evidence(c); mutate(e); assert.throws(() => buildMigrationReport(c, e)); }
});

test('configured critical contract cannot pass before its integrity is actually verified', () => {
  const c = config(); c.criticalContract = { path: 'migrations/customer/approved.json', sha256: hash };
  const result = buildMigrationReport(c, evidence(c));
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.ok(result.diagnostics.some(item => item.code === 'CRITICAL_CONTRACT_UNVERIFIED'));
});

test('all required scenarios must belong to the final candidate, not earlier passing runs', () => {
  const c = config();
  const second = structuredClone(c.scenarios[0]); second.definition.scenarioId = 'invalid-customer';
  c.scenarios.push(second);
  const e = evidence(c);
  assert.equal(buildMigrationReport(c, e).status, 'INCONCLUSIVE');
  e.scenarios.push({ ...structuredClone(e.scenarios[0]), scenarioId: 'invalid-customer', requirements: [] });
  assert.equal(buildMigrationReport(c, e).status, 'PASS');
  e.scenarios[1].identity.candidateHash = 'b'.repeat(64);
  const stale = buildMigrationReport(c, e);
  assert.equal(stale.status, 'INCONCLUSIVE');
  assert.deepEqual(stale.requiredCoverage.scenarios, { expected: 2, received: 1 });
});
