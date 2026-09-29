import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canonical, parseMigrationConfig, parseStateCapture, parseStateFieldClaim, parseStateProjection,
  responseFieldClaimsForScenario,
} from '../packages/core/dist/index.js';

/** P7.3-shaped configuration: request steps, a response claim and one network accepted difference. */
function plainConfig() {
  const project = (name, port, file, argv) => ({
    root: `apps/${name}`, baseUrl: `http://localhost:${port}`, relevantFiles: [`src/${file}`],
    commands: [{ id: 'build', kind: 'build', argv, cwd: '.', timeoutMs: 60000 }],
  });
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'customer',
    source: project('laravel', 4200, 'Customer.php', ['composer', 'install']),
    target: { ...project('spring', 5173, 'Customer.java', ['./gradlew', 'build']), writePaths: ['src/Customer.java'], protectedPaths: [] },
    scenarios: [{
      definition: {
        scenarioId: 'save-note', unitId: 'customer', name: 'Save note', description: 'Persist a customer note',
        entryUrl: 'http://localhost:4200/customers/1', preconditions: {}, testDataProfile: 'standard',
        steps: [
          { stepId: 'get-customer', action: 'request', method: 'GET', path: '/api/customer' },
          { stepId: 'post-note', action: 'request', method: 'POST', path: '/api/customer/notes', body: { note: 'ok' } },
        ],
      },
      required: true, fixtureRoot: 'migrations/customer/fixtures',
      bindings: {
        source: { entryUrl: 'http://localhost:4200/customers/1', steps: [] },
        target: { entryUrl: 'http://localhost:5173/customers/1', steps: [] },
      },
    }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [
      { id: 'customer-note', scenarioId: 'save-note', description: 'The response reports the saved note',
        origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true,
        responseClaim: { kind: 'RESPONSE_FIELD', path: 'data.saved', valueType: 'boolean' } },
      { id: 'note-request', scenarioId: 'save-note', description: 'Saving posts a note', origin: 'EXISTING_TEST',
        sourceReference: 'tests/customer.spec.ts', required: true,
        assertion: { checkpoint: { kind: 'SCENARIO_END' },
          claim: { kind: 'REQUEST_OBSERVED', method: 'POST', pathPattern: '/api/customer/notes', count: 1 } } },
    ],
    acceptedDifferences: [{
      id: 'legacy-note-value', scenarioId: 'save-note', description: 'Fixture note wording differs',
      decisionReference: 'REVIEWS.md#note-wording',
      resolution: {
        sourceAssertions: [{ checkpoint: { kind: 'SCENARIO_END' },
          claim: { kind: 'REQUEST_OBSERVED', method: 'POST', pathPattern: '/api/customer/notes', count: 1 } }],
        targetRequirementIds: ['note-request'],
        matches: [{ code: 'NETWORK_PAYLOAD_VALUE_MISMATCH', requestPath: '/api/customer/notes', field: 'payload.note', count: 1 }],
      },
    }],
    policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 3, maxRepairAttempts: 3, maxDurationMs: 600000 },
  };
}

/** The same configuration extended with the P7.8 state vocabulary: probes, projection, capture and claim. */
function stateConfig() {
  const config = plainConfig();
  config.source.commands.push({ id: 'probe', kind: 'probe', argv: ['php', 'bin/state-probe.php'], cwd: '.', timeoutMs: 30000 });
  config.target.commands.push({ id: 'probe', kind: 'probe', argv: ['java', '-jar', 'java/state-probe.jar'], cwd: '.', timeoutMs: 30000 });
  config.stateProjections = [{
    id: 'customer-state',
    comparison: { collections: [{ path: '/customers', mode: 'KEYED', keyFields: ['id'] }] },
    privacy: {
      allowedPaths: ['/customers', '/customers/*/email', '/customers/*/notes'],
      fields: [
        { path: '/customers/*/email', representation: 'KEYED_EQUALITY', domain: 'email' },
        { path: '/customers/*/notes', representation: 'STRUCTURAL' },
      ],
    },
  }];
  config.scenarios[0].stateCaptures = [{
    id: 'post-scenario', projectionId: 'customer-state',
    checkpoint: { kind: 'SCENARIO_END' }, required: true,
    bindings: { source: { commandId: 'probe' }, target: { commandId: 'probe' } },
    settle: { kind: 'PROBE_BARRIER', completedPath: '/probes/completed', completedValue: 'post-scenario',
      timeoutMs: 60000, pollIntervalMs: 500, maxAttempts: 200 },
  }];
  config.requirements.push(
    { id: 'note-persisted', scenarioId: 'save-note', description: 'The posted note is persisted for customer 1',
      origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true,
      stateClaim: { kind: 'STATE_FIELD', captureId: 'post-scenario', path: '/customers/1/notes/0/body',
        predicate: { kind: 'EQUALS', value: 'ok' } } },
    { id: 'no-legacy-note', scenarioId: 'save-note', description: 'No legacy note copy exists for customer 1',
      origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true,
      stateClaim: { kind: 'STATE_FIELD', captureId: 'post-scenario', path: '/customers/1/legacyNote',
        predicate: { kind: 'ABSENT' } } },
  );
  config.acceptedDifferences.push({
    code: 'STATE_DIVERGENCE', scenarioId: 'save-note', captureId: 'post-scenario', path: '/customers/1/notes',
    resolution: {
      sourcePredicate: { kind: 'KEYED_EQUAL', path: '/customers/1/notes' },
      requiredStateClaimIds: ['note-persisted'],
      ownerDecisionReference: 'REVIEWS.md#state-notes',
    },
  });
  return config;
}

test('a state-verification configuration round-trips through MigrationConfigSchema', () => {
  const config = stateConfig();
  const parsed = parseMigrationConfig(config);
  assert.deepEqual(parsed, config);
  // The two accepted-difference shapes coexist: the network entry keeps its id, the state entry its code.
  assert.equal(parsed.acceptedDifferences.length, 2);
  assert.equal(parsed.acceptedDifferences[0].id, 'legacy-note-value');
  assert.equal(parsed.acceptedDifferences[1].code, 'STATE_DIVERGENCE');
  // Exported schemas parse the same documents standalone.
  assert.deepEqual(parseStateProjection(config.stateProjections[0]), config.stateProjections[0]);
  assert.deepEqual(parseStateCapture(config.scenarios[0].stateCaptures[0]), config.scenarios[0].stateCaptures[0]);
  const claim = config.requirements.find(item => item.stateClaim).stateClaim;
  assert.deepEqual(parseStateFieldClaim(claim), claim);
  // Parsing is idempotent, so the fingerprint of the parsed document matches the declared one.
  assert.deepEqual(parseMigrationConfig(parsed), parsed);
  assert.equal(canonical(parseMigrationConfig(config)), canonical(config));
});

test('an existing configuration without state fields parses unchanged', async () => {
  const config = plainConfig();
  const parsed = parseMigrationConfig(config);
  assert.deepEqual(parsed, config);
  // Absent vocabulary stays absent: no key is introduced, so historical digests keep their bytes.
  assert.equal(canonical(parsed), canonical(config));
  assert.equal('stateProjections' in parsed, false);
  assert.equal('stateCaptures' in parsed.scenarios[0], false);
  assert.equal(parsed.requirements.some(item => 'stateClaim' in item), false);
  assert.equal(parsed.source.commands.some(command => command.kind === 'probe'), false);
  assert.equal(parsed.acceptedDifferences[0].code, undefined);
  assert.deepEqual(parseMigrationConfig(parsed), parsed);

  // A shipped configuration is authoritative evidence: it parses and keeps its exact bytes.
  const shipped = JSON.parse(await readFile(new URL('../examples/api-first/migration.json', import.meta.url), 'utf8'));
  const parsedShipped = parseMigrationConfig(shipped);
  assert.deepEqual(parsedShipped, shipped);
  assert.equal(canonical(parsedShipped), canonical(shipped));
  assert.equal('stateProjections' in parsedShipped, true, 'the persisted api-first example declares its state projections');
});

test('state cross-references fail closed on unknown or mismatched declarations', () => {
  const unknownProjection = stateConfig();
  unknownProjection.scenarios[0].stateCaptures[0].projectionId = 'missing-projection';
  assert.throws(() => parseMigrationConfig(unknownProjection), /declared state projection/);

  const duplicateProjections = stateConfig();
  duplicateProjections.stateProjections.push({ ...duplicateProjections.stateProjections[0] });
  assert.throws(() => parseMigrationConfig(duplicateProjections), /Duplicate state projection id/);

  const nonProbe = stateConfig();
  nonProbe.scenarios[0].stateCaptures[0].bindings.target.commandId = 'build';
  assert.throws(() => parseMigrationConfig(nonProbe), /probe command on each side/);

  const unknownCommand = stateConfig();
  unknownCommand.scenarios[0].stateCaptures[0].bindings.source.commandId = 'vanished';
  assert.throws(() => parseMigrationConfig(unknownCommand), /probe command on each side/);

  const undeclaredCapture = stateConfig();
  undeclaredCapture.requirements.find(item => item.stateClaim).stateClaim.captureId = 'other-capture';
  assert.throws(() => parseMigrationConfig(undeclaredCapture), /capture declared in its scenario/);

  const duplicateCaptures = stateConfig();
  duplicateCaptures.scenarios[0].stateCaptures.push({ ...duplicateCaptures.scenarios[0].stateCaptures[0] });
  assert.throws(() => parseMigrationConfig(duplicateCaptures), /Duplicate state capture id/);

  const divergenceCapture = stateConfig();
  divergenceCapture.acceptedDifferences[1].captureId = 'other-capture';
  assert.throws(() => parseMigrationConfig(divergenceCapture), /State divergence must reference a capture declared in its scenario/);

  const unguardedClaims = stateConfig();
  unguardedClaims.acceptedDifferences[1].resolution.requiredStateClaimIds = ['note-request'];
  assert.throws(() => parseMigrationConfig(unguardedClaims), /mandatory state-claim requirements/);

  const missingDecision = stateConfig();
  delete missingDecision.acceptedDifferences[1].resolution.ownerDecisionReference;
  assert.throws(() => parseMigrationConfig(missingDecision));

  const unknownScenario = stateConfig();
  unknownScenario.acceptedDifferences[1].scenarioId = 'other-scenario';
  assert.throws(() => parseMigrationConfig(unknownScenario), /references an unknown scenario/);
});

test('request steps and response claims keep their P7.3 vocabulary', () => {
  const parsed = parseMigrationConfig(plainConfig());
  assert.deepEqual(responseFieldClaimsForScenario(parsed, 'save-note'), [
    { id: 'customer-note', required: true, claim: { kind: 'RESPONSE_FIELD', path: 'data.saved', valueType: 'boolean' } },
  ]);
  assert.deepEqual(responseFieldClaimsForScenario(parsed, 'other-scenario'), []);
  // Declaring state vocabulary does not disturb the response-claim projection.
  assert.deepEqual(responseFieldClaimsForScenario(parseMigrationConfig(stateConfig()), 'save-note'),
    responseFieldClaimsForScenario(parsed, 'save-note'));

  const wrongType = plainConfig();
  wrongType.requirements[0].responseClaim.valueType = 'null';
  assert.throws(() => parseMigrationConfig(wrongType));
  const wrongPath = plainConfig();
  wrongPath.requirements[0].responseClaim.path = 'data..saved';
  assert.throws(() => parseMigrationConfig(wrongPath));

  const withSignal = plainConfig();
  withSignal.scenarios[0].definition.steps[0].completionSignal = {
    type: 'RESPONSE_RECEIVED', responseUrlPattern: '/api/customer', responseMethod: 'GET', timeoutMs: 1000,
  };
  assert.throws(() => parseMigrationConfig(withSignal), /completionSignal is not allowed on request steps/);
  const mixed = plainConfig();
  mixed.scenarios[0].definition.steps.push({ stepId: 'save', action: 'click', targetRole: 'button' });
  assert.throws(() => parseMigrationConfig(mixed), /may not mix request steps/);
  const noMethod = plainConfig();
  delete noMethod.scenarios[0].definition.steps[0].method;
  assert.throws(() => parseMigrationConfig(noMethod), /requires method and path/);

  // The command vocabulary widened by exactly one kind: 'probe'.
  const unknownKind = plainConfig();
  unknownKind.source.commands[0].kind = 'deploy';
  assert.throws(() => parseMigrationConfig(unknownKind));
  const probeOnly = plainConfig();
  probeOnly.source.commands.push({ id: 'probe', kind: 'probe', argv: ['php', 'bin/state-probe.php'], cwd: '.', timeoutMs: 30000 });
  assert.doesNotThrow(() => parseMigrationConfig(probeOnly));
});
