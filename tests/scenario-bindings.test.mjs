import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMigrationConfig, resolveScenarioForSide, scenarioBindingProjection, scenarioSemanticProjection,
  migrationConfigHash, parseScenario,
} from '../packages/core/dist/index.js';
import { evaluateUnitAssertions } from '../packages/equivalence-validator/dist/index.js';
import { event } from './helpers.mjs';

function config() {
  const project = (name, port) => ({
    root: `apps/${name}`, baseUrl: `http://localhost:${port}`, relevantFiles: ['src/page.ts'],
    commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
  });
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'customer',
    source: project('angular', 4200),
    target: { ...project('react', 5173), writePaths: ['src/page.tsx'], protectedPaths: [] },
    scenarios: [{
      definition: {
        scenarioId: 'update-customer', unitId: 'customer', name: 'Save', description: 'Synthetic save',
        entryUrl: 'http://localhost:4200/customers/1', preconditions: {}, testDataProfile: 'standard',
        steps: [
          { stepId: 'fill-name', action: 'fill', targetRole: 'textbox', targetName: 'Nome', inputValue: 'Ana' },
          { stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Salvar' },
        ],
        completionSignal: { type: 'LOCATOR_VISIBLE', targetRole: 'alert', timeoutMs: 5000 },
      },
      required: true, fixtureRoot: 'migrations/customer/fixtures',
      bindings: {
        source: { entryUrl: 'http://localhost:4200/customers/1', steps: [], unitScope: { role: 'form', name: 'Editar cliente' } },
        target: {
          entryUrl: 'http://localhost:5173/clientes/1',
          steps: [{ stepId: 'save', targetRole: 'button', targetName: 'Gravar' }],
          unitScope: { role: 'form', name: 'Formulario do cliente' },
        },
      },
    }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [{
      id: 'shows-error', scenarioId: 'update-customer', description: 'Show the validation error',
      origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true,
      assertion: { checkpoint: { kind: 'AFTER_STEP', stepId: 'save' }, claim: { kind: 'NODE_PRESENT', role: 'alert' } },
    }],
    acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 3, maxRepairAttempts: 3, maxDurationMs: 600000 },
  };
}

test('a binding adapts the route, locators and unit scope of one application only', () => {
  const source = resolveScenarioForSide(config(), 'update-customer', 'source');
  const target = resolveScenarioForSide(config(), 'update-customer', 'target');
  assert.deepEqual(source.definition, parseScenario(config().scenarios[0].definition));
  assert.deepEqual(source.unitScope, { role: 'form', name: 'Editar cliente' });
  assert.equal(target.definition.entryUrl, 'http://localhost:5173/clientes/1');
  assert.deepEqual(target.definition.steps.map(step => [step.stepId, step.action, step.targetRole, step.targetName, step.inputValue]), [
    ['fill-name', 'fill', 'textbox', 'Nome', 'Ana'],
    ['save', 'click', 'button', 'Gravar', undefined],
  ]);
  assert.deepEqual(target.unitScope, { role: 'form', name: 'Formulario do cliente' });
  // Both sides remain the same scenario: only the addressing projection differs.
  assert.deepEqual(scenarioSemanticProjection(source.definition), scenarioSemanticProjection(target.definition));
  assert.notDeepEqual(scenarioBindingProjection(config().scenarios[0], 'source'), scenarioBindingProjection(config().scenarios[0], 'target'));
  assert.deepEqual(parseScenario(target.definition), target.definition);
  const withoutScope = config(); delete withoutScope.scenarios[0].bindings.target.unitScope;
  assert.equal(resolveScenarioForSide(withoutScope, 'update-customer', 'target').unitScope, undefined);
  assert.throws(() => resolveScenarioForSide(config(), 'absent-scenario', 'target'), /Unknown scenario/);
});

test('a binding cannot change an action, a value, the step set or the application origin', () => {
  for (const mutate of [
    c => { c.scenarios[0].bindings.target.steps[0] = { stepId: 'save', action: 'fill', targetRole: 'button' }; },
    c => { c.scenarios[0].bindings.target.steps[0] = { stepId: 'save', targetRole: 'button', inputValue: 'other' }; },
    c => { c.scenarios[0].bindings.target.steps[0] = { stepId: 'save', targetRole: 'button', completionSignal: { type: 'LOCATOR_VISIBLE', targetRole: 'alert', timeoutMs: 1000 } }; },
    c => { c.scenarios[0].bindings.target.steps[0] = { stepId: 'unknown-step', targetRole: 'button' }; },
    c => { c.scenarios[0].bindings.target.steps[0] = { stepId: 'save', targetRole: 'invented-role' }; },
    c => { c.scenarios[0].bindings.target.entryUrl = 'http://localhost:4200/customers/1'; },
    c => { c.scenarios[0].bindings.target.unitScope = { role: 'invented-role' }; },
    c => { c.scenarios[0].bindings.target.unitScope = { name: 'no role' }; },
    c => { c.scenarios[0].bindings.target.completionSignal = { type: 'LOCATOR_VISIBLE', targetRole: 'alert', timeoutMs: 1000 }; },
  ]) {
    const value = config(); mutate(value);
    assert.throws(() => parseMigrationConfig(value));
    assert.throws(() => resolveScenarioForSide(value, 'update-customer', 'target'));
  }
});

test('the per-application unit scope decides where an assertion is evaluated', () => {
  const tree = unitName => ({ role: 'generic', children: [
    { role: 'banner', children: [{ role: 'text', text: 'SHELL' }] },
    { role: 'form', name: unitName, children: [{ role: 'alert', children: [{ role: 'text', text: 'Nome e obrigatorio' }] }] },
  ] });
  const run = unitName => {
    const trace = { scenarioId: 'update-customer', runIndex: 1, startedAt: '2026-09-05T00:00:00.000Z',
      environment: { browser: 'chromium', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' },
      sanitization: { version: 'test', appliedAt: '2026-09-05T00:00:01.000Z', redactionsCount: 0 }, events: [] };
    event(trace, 'USER_INTERACTION', { stepId: 'save', action: 'click', targetAriaRole: 'button', targetAriaName: 'Salvar' });
    event(trace, 'ARIA_STATE_CHANGE', { triggerEventId: 'event-1', rawYamlTree: '', jsonTree: tree(unitName) });
    return trace;
  };
  const parsed = parseMigrationConfig(config());
  const assertion = { id: 'shows-error', required: true, ...parsed.requirements[0].assertion };
  const unitScopes = {
    source: resolveScenarioForSide(config(), 'update-customer', 'source').unitScope,
    target: resolveScenarioForSide(config(), 'update-customer', 'target').unitScope,
  };
  const bound = evaluateUnitAssertions({ source: run('Editar cliente'), target: run('Formulario do cliente'), assertions: [assertion], unitScopes });
  assert.deepEqual(bound.outcomes.map(item => item.status), ['SATISFIED', 'SATISFIED']);
  assert.deepEqual(bound.divergences, []);
  // Without the adaptation the destination container cannot be located: not evaluable, never a pass.
  const unbound = evaluateUnitAssertions({ source: run('Editar cliente'), target: run('Formulario do cliente'), assertions: [assertion], unitScopes: { source: unitScopes.source, target: unitScopes.source } });
  const missing = unbound.outcomes.find(item => item.side === 'target');
  assert.equal(missing.status, 'NOT_EVALUABLE');
  assert.equal(missing.reason, 'SCOPE_NOT_FOUND');
  assert.equal(unbound.divergences[0].code, 'UNIT_ASSERTION_NOT_EVALUABLE');
  // A bound scope still cannot hide a control the destination does not render.
  const empty = evaluateUnitAssertions({ source: run('Editar cliente'), target: run('Formulario do cliente'), assertions: [{ ...assertion, claim: { kind: 'NODE_PRESENT', role: 'button', name: 'Gravar' } }], unitScopes });
  assert.equal(empty.outcomes.find(item => item.side === 'target').reason, 'NODE_MISSING');
  // An assertion-level scope remains the default when the application declares none.
  const declared = { ...assertion, scope: { role: 'form', name: 'Editar cliente' } };
  assert.equal(evaluateUnitAssertions({ source: run('Editar cliente'), target: run('Editar cliente'), assertions: [declared] }).outcomes.every(item => item.status === 'SATISFIED'), true);
  assert.equal(evaluateUnitAssertions({ source: run('Editar cliente'), target: run('Formulario do cliente'), assertions: [declared], unitScopes: { target: unitScopes.target } }).outcomes.every(item => item.status === 'SATISFIED'), true);
});

test('adapting a binding is a versioned criteria change, not a silent edit', () => {
  const initial = migrationConfigHash(config());
  for (const mutate of [
    c => { c.scenarios[0].bindings.target.unitScope.name = 'Outro formulario'; },
    c => { c.scenarios[0].bindings.target.steps[0].targetName = 'Salvar'; },
    c => { c.scenarios[0].bindings.target.entryUrl = 'http://localhost:5173/clientes/2'; },
  ]) { const changed = config(); mutate(changed); assert.notEqual(migrationConfigHash(changed), initial); }
  const scenario = parseMigrationConfig(config()).scenarios[0];
  const adapted = structuredClone(scenario); adapted.bindings.target.unitScope.name = 'Outro formulario';
  assert.notDeepEqual(scenarioBindingProjection(adapted, 'target'), scenarioBindingProjection(scenario, 'target'));
  assert.deepEqual(scenarioSemanticProjection(adapted.definition), scenarioSemanticProjection(scenario.definition));
});
