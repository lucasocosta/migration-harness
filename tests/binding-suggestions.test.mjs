import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeBindingAdaptations, proposeScenarioInventory, proposeFromOutcomes, isBindingAnchor,
} from '../packages/engine/dist/equivalence/index.js';
import { parseSuggestionReport, resolveScenarioForSide, parseMigrationConfig } from '../packages/core/dist/index.js';

function config() {
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'customer',
    source: {
      root: 'apps/angular', baseUrl: 'http://localhost:4200', relevantFiles: ['src/page.ts'],
      commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
    },
    target: {
      root: 'apps/react', baseUrl: 'http://localhost:5173', relevantFiles: ['src/page.tsx'], writePaths: ['src/page.tsx'], protectedPaths: [],
      commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
    },
    scenarios: [{
      definition: {
        scenarioId: 'save', unitId: 'customer', name: 'Save', description: 'Save',
        entryUrl: 'http://localhost:4200/c', preconditions: {}, testDataProfile: 'standard',
        steps: [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }],
      },
      required: true, fixtureRoot: 'migrations/customer/scenarios/fixtures',
      bindings: {
        source: { entryUrl: 'http://localhost:4200/c', steps: [] },
        target: { entryUrl: 'http://localhost:5173/c', steps: [{ stepId: 'save', targetRole: 'button', targetName: 'Salvar' }] },
      },
    }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [], acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 2, maxRepairAttempts: 2, maxDurationMs: 600000 },
  };
}

test('binding proposals target only the binding projection and never rewrite semantics', () => {
  assert.equal(isBindingAnchor('NODE_MISSING'), true);
  assert.equal(isBindingAnchor('NETWORK_MISSING_REQUEST'), false);
  const report = proposeBindingAdaptations({
    scenarioId: 'save',
    side: 'target',
    stepId: 'save',
    anchors: ['NODE_MISSING', 'STEP_FAILED', 'NETWORK_MISSING_REQUEST'],
    observedCandidates: [{ targetRole: 'button', targetName: 'Salvar' }],
    generatedAt: '2026-09-27T12:00:00.000Z',
  });
  assert.equal(report.authority, 'HINT_ONLY');
  assert.equal(report.suggestions.length, 1);
  const suggestion = parseSuggestionReport(report).suggestions[0];
  assert.equal(suggestion.kind, 'BINDING_ADAPTATION_PROPOSAL');
  assert.equal(suggestion.status, 'PROPOSED');
  assert.ok(suggestion.codes.includes('NODE_MISSING'));
  assert.ok(!suggestion.codes.includes('NETWORK_MISSING_REQUEST'));
  assert.ok(suggestion.description.includes('Salvar'));
  // No semantic rewrite is proposed (no step/action payload fields).
  assert.ok(!JSON.stringify(report).includes('"action"'));
  assert.ok(!JSON.stringify(report).includes('inputValue'));
});

test('resolveScenarioForSide refuses any semantic drift when applying a binding', () => {
  const parsed = parseMigrationConfig(config());
  const side = resolveScenarioForSide(parsed, 'save', 'target');
  assert.equal(side.definition.entryUrl, 'http://localhost:5173/c');
  assert.equal(side.definition.steps[0].targetName, 'Salvar');
  // A binding cannot invent a different action even if someone patches the raw object.
  const hacked = config();
  hacked.scenarios[0].bindings.target.steps[0] = { stepId: 'save', targetRole: 'button', targetName: 'Other' };
  // resolve re-validates semantic projection of the *definition* (actions stay click).
  const resolved = resolveScenarioForSide(parseMigrationConfig(hacked), 'save', 'target');
  assert.equal(resolved.definition.steps[0].action, 'click');
});

test('scenario inventory proposals are non-authoritative and skip dynamic routes', () => {
  const report = proposeScenarioInventory({
    unitId: 'customer',
    routes: [
      { path: '/customers', dynamic: false, guardIds: [], resolverIds: [] },
      { path: '/customers/:id', dynamic: true, guardIds: [], resolverIds: [] },
    ],
    endpoints: [{ method: 'PUT', path: '/api/customers/1', dynamic: false }],
    runtimeRoutes: ['/customers'],
    generatedAt: '2026-09-27T12:00:00.000Z',
  });
  const routeSuggestions = report.suggestions.filter(item => item.kind === 'SCENARIO_INVENTORY_PROPOSAL' && item.target.requestPath === undefined);
  assert.ok(routeSuggestions.some(item => item.description.includes("Route '/customers'")));
  assert.ok(!report.suggestions.some(item => item.description.includes('/:id')));
  assert.ok(report.suggestions.every(item => item.status === 'PROPOSED'));
  assert.equal(routeSuggestions.filter(item => item.description.includes("Route '/customers'")).length, 1, 'deduped routes');
});

test('outcomes map failed assertion reasons to binding proposals', () => {
  const report = proposeFromOutcomes({
    scenarioId: 'save',
    stepId: 'save',
    outcomes: [
      { assertionId: 'a', status: 'VIOLATED', reason: 'NODE_MISSING' },
      { assertionId: 'b', status: 'SATISFIED' },
      { assertionId: 'c', status: 'NOT_EVALUABLE', reason: 'CHECKPOINT_MISSING' },
    ],
    generatedAt: '2026-09-27T12:00:00.000Z',
  });
  assert.equal(report.suggestions.length, 1);
  assert.deepEqual(report.suggestions[0].codes, ['NODE_MISSING']);
});
