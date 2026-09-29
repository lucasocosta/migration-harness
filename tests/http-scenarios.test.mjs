import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  canonical, classifyReferenceChange, migrationConfigHash, parseMigrationConfig, parseRawTrace, parseScenario,
  responseFieldClaimsForScenario,
} from '../packages/core/dist/index.js';
import { captureScenario } from '../packages/scenario-runner/dist/index.js';
import { sanitizeTrace } from '../packages/trace-sanitizer/dist/index.js';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';
import { evaluateResponseFieldClaims } from '../packages/quality-gates/dist/index.js';
import { assertionRequirementStatuses, buildMigrationReport } from '../packages/quality-gates/dist/migration-report.js';
import { scenarioRequirementStatuses } from '../packages/engine/dist/migration-operations.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';

const sanitizerPolicy = {
  pseudonymizationKey: 'k'.repeat(40),
  allowedPayloadKeys: ['data', 'email', 'note', 'saved', 'legacyNote'],
};

function apiConfig() {
  const project = (name, port) => ({
    root: `apps/${name}`, baseUrl: `http://localhost:${port}`, relevantFiles: ['src/page.ts'],
    commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
  });
  return {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'customer',
    source: project('angular', 4200), target: { ...project('react', 5173), writePaths: ['src/page.tsx'], protectedPaths: [] },
    scenarios: [{
      definition: {
        scenarioId: 'fetch-customer', unitId: 'customer', name: 'Fetch customer', description: 'API-only scenario',
        entryUrl: 'http://localhost:4200/customers/1', preconditions: {}, testDataProfile: 'standard',
        steps: [
          { stepId: 'get-customer', action: 'request', method: 'GET', path: '/api/customer' },
          { stepId: 'save-note', action: 'request', method: 'POST', path: '/api/customer/notes', body: { note: 'ok' } },
        ],
      },
      required: true, fixtureRoot: 'migrations/customer/fixtures',
      bindings: { source: { entryUrl: 'http://localhost:4200/customers/1', steps: [] }, target: { entryUrl: 'http://localhost:5173/customers/1', steps: [] } },
    }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [{
      id: 'customer-email', scenarioId: 'fetch-customer', description: 'The customer response exposes the email',
      origin: 'SPECIFICATION', sourceReference: 'SPEC.md', required: true,
      responseClaim: { kind: 'RESPONSE_FIELD', path: 'data.email', valueType: 'string' },
    }],
    acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 3, maxRepairAttempts: 3, maxDurationMs: 600000 },
  };
}

const getCustomer = { stepId: 'get-customer', action: 'request', method: 'GET', path: '/api/customer' };
const saveNote = { stepId: 'save-note', action: 'request', method: 'POST', path: '/api/customer/notes', body: { note: 'ok' } };
const scenario = (baseUrl, steps) => ({
  scenarioId: 'api-customer', unitId: 'customer', name: 'Fetch customer', description: 'API-only scenario',
  entryUrl: `${baseUrl}/`, preconditions: {}, testDataProfile: 'standard', steps,
});

async function startFixture() {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
    const send = (statusCode, value) => { res.writeHead(statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/api/customer') return send(200, { data: { email: 'person@example.test' } });
    if (req.method === 'POST' && req.url === '/api/customer/notes') return send(201, { saved: true });
    if (req.method === 'GET' && req.url === '/api/customer/number') return send(200, { data: { email: 42 } });
    if (req.method === 'GET' && req.url === '/api/customer/missing') return send(200, { data: {} });
    if (req.method === 'GET' && req.url === '/api/customer/extra') return send(200, { legacyNote: 'x' });
    return send(404, { error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl, seen,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

const capture = (fixture, steps, runIndex, options = {}) =>
  captureScenario(scenario(fixture.baseUrl, steps), runIndex, { baseUrl: fixture.baseUrl, ...options });

test('a request step round-trips through scenario and configuration validation', () => {
  const configuration = apiConfig();
  assert.deepEqual(parseScenario(configuration.scenarios[0].definition), configuration.scenarios[0].definition);
  const parsed = parseMigrationConfig(configuration);
  assert.deepEqual(parsed, configuration);
  assert.deepEqual(responseFieldClaimsForScenario(parsed, 'fetch-customer'), [
    { id: 'customer-email', required: true, claim: { kind: 'RESPONSE_FIELD', path: 'data.email', valueType: 'string' } },
  ]);
  assert.deepEqual(responseFieldClaimsForScenario(parsed, 'other-scenario'), []);
  // The claim vocabulary is closed: only the declared JSON types are accepted.
  const wrongType = apiConfig();
  wrongType.requirements[0].responseClaim = { kind: 'RESPONSE_FIELD', path: 'data.email', valueType: 'null' };
  assert.throws(() => parseMigrationConfig(wrongType));
  const wrongPath = apiConfig();
  wrongPath.requirements[0].responseClaim = { kind: 'RESPONSE_FIELD', path: 'data..email', valueType: 'string' };
  assert.throws(() => parseMigrationConfig(wrongPath));
});

test('request steps refuse completion signals and mixed scenarios keep the browser rules', () => {
  const definition = apiConfig().scenarios[0].definition;
  const completion = { type: 'RESPONSE_RECEIVED', responseUrlPattern: '/api/customer', responseMethod: 'GET', timeoutMs: 1000 };
  const withSignal = { ...definition, steps: [{ ...definition.steps[0], completionSignal: completion }] };
  assert.throws(() => parseScenario(withSignal), /completionSignal is not allowed on request steps/);
  const broken = apiConfig();
  broken.scenarios[0].definition = withSignal;
  assert.throws(() => parseMigrationConfig(broken), /completionSignal is not allowed on request steps/);
  const mixed = { ...definition, steps: [definition.steps[0], { stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }] };
  assert.throws(() => parseScenario(mixed), /may not mix request steps with browser interaction steps/);
  const noMethod = { ...definition, steps: [{ stepId: 'get-customer', action: 'request', method: 'GET' }] };
  assert.throws(() => parseScenario(noMethod), /requires method and path/);
  const foreignPath = { ...definition, steps: [{ stepId: 'get-customer', action: 'request', method: 'GET', path: 'api/customer' }] };
  assert.throws(() => parseScenario(foreignPath), /absolute path/);
  // No regression: browser steps keep requiring inputValue and a locator role.
  const browser = { ...definition, steps: [{ stepId: 'fill-email', action: 'fill', targetRole: 'textbox' }] };
  assert.throws(() => parseScenario(browser), /requires inputValue/);
  const noRole = { ...definition, steps: [{ stepId: 'fill-email', action: 'fill', inputValue: 'x' }] };
  assert.throws(() => parseScenario(noRole), /requires targetRole/);
  const valid = { ...definition, steps: [{ stepId: 'fill-email', action: 'fill', targetRole: 'textbox', inputValue: 'x' }] };
  assert.equal(parseScenario(valid).steps[0].action, 'fill');
});

test('API capture records exchanges and request interactions in the validator event shape', async () => {
  const fixture = await startFixture();
  try {
    const definition = scenario(fixture.baseUrl, [getCustomer, saveNote]);
    const trace = parseRawTrace(await captureScenario(definition, 0, { baseUrl: fixture.baseUrl }));
    assert.equal(trace.scenarioId, 'api-customer');
    assert.equal(typeof trace.runId, 'string');
    assert.equal(typeof trace.startedAt, 'string');
    assert.equal(trace.environment.browser, 'none');
    assert.deepEqual(trace.completion, { status: 'COMPLETED', completedStepIds: ['get-customer', 'save-note'] });
    assert.equal(trace.events.length, 6);
    assert.deepEqual(trace.events.map(event => event.sequenceIndex), [1, 2, 3, 4, 5, 6]);

    const [interaction, request, response, secondInteraction, secondRequest, secondResponse] = trace.events;
    assert.deepEqual(Object.keys(interaction).sort(), ['action', 'eventId', 'sequenceIndex', 'stepId', 'timestampMs', 'type']);
    assert.equal(interaction.type, 'USER_INTERACTION');
    assert.equal(interaction.stepId, 'get-customer');
    assert.equal(interaction.action, 'request');
    assert.equal('targetAriaRole' in interaction, false);
    assert.equal(secondInteraction.type, 'USER_INTERACTION');
    assert.equal(secondInteraction.stepId, 'save-note');
    assert.equal(secondInteraction.action, 'request');

    assert.deepEqual(Object.keys(request).sort(), ['correlationId', 'eventId', 'headers', 'method', 'payload', 'sequenceIndex', 'timestampMs', 'type', 'url']);
    assert.equal(request.type, 'HTTP_REQUEST');
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `${fixture.baseUrl}/api/customer`);
    assert.equal(request.payload, null);
    assert.deepEqual(request.headers, { accept: 'application/json' });
    assert.deepEqual(Object.keys(response).sort(), ['body', 'causedByEventIds', 'correlationId', 'eventId', 'headers', 'method', 'requestToResponseEndMs', 'sequenceIndex', 'statusCode', 'timestampMs', 'type', 'url']);
    assert.equal(response.type, 'HTTP_RESPONSE');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { data: { email: 'person@example.test' } });
    assert.equal(response.correlationId, request.correlationId);
    assert.equal(response.method, request.method);
    assert.equal(response.url, request.url);
    assert.deepEqual(response.causedByEventIds, [request.eventId]);
    assert.equal(typeof response.headers['content-type'], 'string');
    assert.equal(typeof response.requestToResponseEndMs, 'number');
    assert.ok(response.requestToResponseEndMs >= 0);
    assert.ok(response.timestampMs >= request.timestampMs);

    assert.equal(secondRequest.type, 'HTTP_REQUEST');
    assert.equal(secondRequest.method, 'POST');
    assert.equal(secondRequest.url, `${fixture.baseUrl}/api/customer/notes`);
    assert.deepEqual(secondRequest.payload, { note: 'ok' });
    assert.deepEqual(secondRequest.headers, { accept: 'application/json', 'content-type': 'application/json' });
    assert.equal(secondResponse.statusCode, 201);
    assert.deepEqual(secondResponse.body, { saved: true });
    assert.deepEqual(secondResponse.causedByEventIds, [secondRequest.eventId]);
    assert.notEqual(secondRequest.correlationId, request.correlationId);

    // The driver really issued the call, body and content type included.
    const posted = fixture.seen.find(item => item.url === '/api/customer/notes');
    assert.equal(posted.method, 'POST');
    assert.equal(posted.contentType, 'application/json');
    assert.deepEqual(JSON.parse(posted.body), { note: 'ok' });

    // Without an explicit baseUrl the side's entry URL is the base; foreign origins are refused.
    const fallback = parseRawTrace(await captureScenario(scenario(fixture.baseUrl, [getCustomer]), 1, {}));
    assert.equal(fallback.events.filter(event => event.type === 'HTTP_RESPONSE').length, 1);
    await assert.rejects(capture(fixture, [getCustomer], 2, { allowedOrigins: ['http://other.invalid'] }), /outside the allowed origins/);

    // The unchanged equivalence validator consumes the recorded exchanges as evidence.
    const source = sanitizeTrace(trace, sanitizerPolicy);
    const target = sanitizeTrace(parseRawTrace(await capture(fixture, [getCustomer, saveNote], 3)), sanitizerPolicy);
    const result = new EquivalenceValidator().validate({ source, target });
    assert.equal(result.status, 'EQUIVALENT');
    assert.deepEqual(result.divergences, []);
  } finally {
    await fixture.close();
  }
});

test('RESPONSE_FIELD claims pass, violate and stay inconclusive against recorded exchanges', async () => {
  const fixture = await startFixture();
  try {
    const sanitized = (steps, runIndex) => capture(fixture, steps, runIndex).then(raw => sanitizeTrace(parseRawTrace(raw), sanitizerPolicy));
    const goodSource = await sanitized([getCustomer, saveNote], 0);
    const goodTarget = await sanitized([getCustomer, saveNote], 1);
    const emailClaim = [{ id: 'customer-email', required: true, claim: { kind: 'RESPONSE_FIELD', path: 'data.email', valueType: 'string' } }];
    const absentClaim = [{ id: 'no-legacy-note', required: true, claim: { kind: 'RESPONSE_FIELD', path: 'legacyNote', valueType: 'absent' } }];

    // PASS: both recorded bodies carry the declared type, and nothing carries the absent path.
    const passed = evaluateResponseFieldClaims({ claims: emailClaim, source: goodSource, target: goodTarget });
    assert.equal(passed.status, 'PASS');
    assert.deepEqual(passed.outcomes.map(item => [item.side, item.status, item.reason ?? null]), [
      ['source', 'SATISFIED', null], ['target', 'SATISFIED', null],
    ]);
    assert.deepEqual(assertionRequirementStatuses(passed.outcomes), [{ requirementId: 'customer-email', status: 'PASS' }]);
    const absentPass = evaluateResponseFieldClaims({ claims: absentClaim, source: goodSource, target: goodTarget });
    assert.equal(absentPass.status, 'PASS');
    assert.equal(absentPass.outcomes.every(item => item.status === 'SATISFIED'), true);

    // VIOLATED: a recorded response with the wrong type, one without the field, and one that should be absent.
    const wrongType = await sanitized([{ stepId: 'get-number', action: 'request', method: 'GET', path: '/api/customer/number' }], 0);
    const violated = evaluateResponseFieldClaims({ claims: emailClaim, source: goodSource, target: wrongType });
    assert.equal(violated.status, 'FAIL');
    assert.deepEqual(violated.outcomes.find(item => item.side === 'target'), {
      assertionId: 'customer-email', side: 'target', required: true, status: 'VIOLATED', reason: 'RESPONSE_FIELD_TYPE_DIFFERS',
    });
    assert.deepEqual(assertionRequirementStatuses(violated.outcomes), [{ requirementId: 'customer-email', status: 'FAIL' }]);
    const withoutField = await sanitized([{ stepId: 'get-missing', action: 'request', method: 'GET', path: '/api/customer/missing' }], 0);
    const missing = evaluateResponseFieldClaims({ claims: emailClaim, source: goodSource, target: withoutField });
    assert.equal(missing.status, 'FAIL');
    assert.equal(missing.outcomes.find(item => item.side === 'target').reason, 'RESPONSE_FIELD_MISSING');
    const extra = await sanitized([{ stepId: 'get-extra', action: 'request', method: 'GET', path: '/api/customer/extra' }], 0);
    assert.equal(evaluateResponseFieldClaims({ claims: absentClaim, source: goodSource, target: extra }).status, 'FAIL');

    // INCONCLUSIVE: exchanges carrying the path disagree, and no recorded exchange exists at all.
    const conflicting = await sanitized([
      getCustomer,
      { stepId: 'get-number', action: 'request', method: 'GET', path: '/api/customer/number' },
    ], 0);
    const ambiguous = evaluateResponseFieldClaims({ claims: emailClaim, source: goodSource, target: conflicting });
    assert.equal(ambiguous.status, 'INCONCLUSIVE');
    assert.equal(ambiguous.outcomes.find(item => item.side === 'target').reason, 'RESPONSE_FIELD_AMBIGUOUS');
    const empty = sanitizeTrace({
      scenarioId: 'api-customer', runIndex: 9, startedAt: '2026-09-05T00:00:00.000Z',
      environment: { browser: 'none', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' }, events: [],
    }, sanitizerPolicy);
    const unevaluable = evaluateResponseFieldClaims({ claims: emailClaim, source: goodSource, target: empty });
    assert.equal(unevaluable.status, 'INCONCLUSIVE');
    assert.deepEqual(unevaluable.outcomes.find(item => item.side === 'target'), {
      assertionId: 'customer-email', side: 'target', required: true, status: 'NOT_EVALUABLE', reason: 'RESPONSE_FIELD_NO_EXCHANGE',
    });
    assert.deepEqual(assertionRequirementStatuses(unevaluable.outcomes), [{ requirementId: 'customer-email', status: 'INCONCLUSIVE' }]);

    // Only this claim kind is evaluated here; other declarations are refused instead of misread.
    assert.throws(() => evaluateResponseFieldClaims({
      claims: [{ id: 'nodes', required: true, claim: { kind: 'NODE_PRESENT', role: 'alert' } }],
      source: goodSource, target: goodTarget,
    }), /RESPONSE_FIELD/);
    // Evidence must belong to the scenario the claim is declared for.
    assert.throws(() => evaluateResponseFieldClaims({
      claims: emailClaim, source: { ...empty, scenarioId: 'other-scenario' }, target: goodTarget,
    }), /Scenario mismatch/);
  } finally {
    await fixture.close();
  }
});

/** Feed engine-mapped requirement statuses through the report aggregator, exactly as `verifyMigration` does. */
function reportFor(config, statuses) {
  const identity = {
    migrationId: config.migrationId, configurationHash: migrationConfigHash(config),
    referenceHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), buildHash: 'c'.repeat(64),
  };
  return buildMigrationReport(config, {
    identity, evaluatedAt: '2026-09-06T12:00:00.000Z', referenceVerified: true,
    scenarios: [{ identity, scenarioId: 'fetch-customer', status: 'PASS',
      requirements: statuses.map(item => ({ requirementId: item.requirementId, status: item.status })),
      diagnostics: [], evidencePaths: ['results/scenario.json'] }],
    checks: [{ identity, checkId: 'target-build', status: 'PASS', diagnostics: [], evidencePaths: ['results/build.json'] }],
  });
}

test('a response-claim requirement reaches report PASS and FAIL through the engine requirement mapping', async () => {
  const fixture = await startFixture();
  try {
    const config = parseMigrationConfig(apiConfig());
    const sanitized = (steps, runIndex) => capture(fixture, steps, runIndex).then(raw => sanitizeTrace(parseRawTrace(raw), sanitizerPolicy));
    const goodSource = await sanitized([getCustomer, saveNote], 0);
    const goodTarget = await sanitized([getCustomer, saveNote], 1);
    const map = (source, target, configuration = config) =>
      scenarioRequirementStatuses(configuration, 'fetch-customer', { assertionOutcomes: [], source, target });

    // Both recorded executions satisfy the claim: the requirement reaches PASS, and so does the report.
    const passed = map(goodSource, goodTarget);
    assert.deepEqual(passed, [{ requirementId: 'customer-email', status: 'PASS' }]);
    assert.equal(reportFor(config, passed).requirements, 'PASS');
    assert.equal(reportFor(config, passed).status, 'PASS');

    // A violating side fails the requirement with its declared reason code — never a pass.
    const violating = await sanitized([{ stepId: 'get-missing', action: 'request', method: 'GET', path: '/api/customer/missing' }], 0);
    const failed = map(goodSource, violating);
    assert.deepEqual(failed, [{ requirementId: 'customer-email', status: 'FAIL', reason: 'RESPONSE_FIELD_MISSING' }]);
    const failedReport = reportFor(config, failed);
    assert.equal(failedReport.requirements, 'FAIL');
    assert.equal(failedReport.status, 'FAIL');

    // Evidence that cannot decide maps to INCONCLUSIVE at both levels.
    const empty = sanitizeTrace({
      scenarioId: 'api-customer', runIndex: 9, startedAt: '2026-09-05T00:00:00.000Z',
      environment: { browser: 'none', viewport: { width: 1280, height: 720 }, locale: 'pt-BR' }, events: [],
    }, sanitizerPolicy);
    assert.deepEqual(map(goodSource, empty), [{ requirementId: 'customer-email', status: 'INCONCLUSIVE', reason: 'RESPONSE_FIELD_NO_EXCHANGE' }]);
    assert.equal(reportFor(config, map(goodSource, empty)).requirements, 'INCONCLUSIVE');

    // Assertion outcomes keep flowing through the same mapping, and a requirement declaring both must hold both.
    assert.deepEqual(scenarioRequirementStatuses(config, 'fetch-customer', {
      assertionOutcomes: [{ assertionId: 'customer-email', side: 'target', required: true, status: 'VIOLATED', reason: 'NODE_MISSING' }],
      source: goodSource, target: goodTarget,
    }), [{ requirementId: 'customer-email', status: 'FAIL', reason: 'NODE_MISSING' }]);

    // A requirement without machine-checkable evidence keeps its previous fail-closed behavior.
    const prose = parseMigrationConfig(apiConfig());
    delete prose.requirements[0].responseClaim;
    assert.deepEqual(map(goodSource, goodTarget, prose), [{ requirementId: 'customer-email', status: 'INCONCLUSIVE' }]);
  } finally {
    await fixture.close();
  }
});

test('the reference requirement digest covers responseClaim only when it is declared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'http-scenario-reference-'));
  try {
    for (const path of ['apps/angular/src/page.ts', 'apps/react/src/page.ts']) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), 'export const input = 1;\n');
    }
    const createdAt = '2026-09-06T12:00:00.000Z';
    const collected = async config => collectMigrationReference({ config, workspaceRoot: root, createdAt });
    const digestOf = async config => (await collected(config)).criteria.requirements.find(item => item.id === 'customer-email').digest;
    // The projection a configuration without the claim must keep: no key may be added for it.
    const historical = requirement => createHash('sha256').update(canonical({
      description: requirement.description, origin: requirement.origin, sourceReference: requirement.sourceReference,
      assertion: requirement.assertion ?? null,
    })).digest('hex');
    const projected = (requirement, extra = {}) => createHash('sha256').update(canonical({
      description: requirement.description, origin: requirement.origin, sourceReference: requirement.sourceReference,
      assertion: requirement.assertion ?? null, ...extra,
    })).digest('hex');

    const plain = apiConfig();
    delete plain.requirements[0].responseClaim;
    assert.equal(await digestOf(plain), historical(plain.requirements[0]));

    const declared = apiConfig();
    const declaredDigest = await digestOf(declared);
    assert.equal(declaredDigest, projected(declared.requirements[0], { responseClaim: declared.requirements[0].responseClaim }));
    assert.notEqual(declaredDigest, await digestOf(plain));

    const retyped = apiConfig();
    retyped.requirements[0].responseClaim.valueType = 'number';
    assert.notEqual(await digestOf(retyped), declaredDigest);

    // The changed claim is therefore a criteria change between two references, not a silent drift.
    const change = classifyReferenceChange(await collected(plain), await collected(retyped));
    assert.ok(change.deltas.some(item => item.kind === 'REQUIREMENT_CHANGED' && item.requirementId === 'customer-email'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
