import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import { frameworkFixture } from '../tests/browser/fixture.mjs';
import { endpoint } from '../tests/helpers.mjs';
import { discover } from '../packages/static-analyzer/dist/index.js';
import { planTransformation } from '../packages/transformation-planner/dist/index.js';
import { captureScenario } from '../packages/scenario-runner/dist/index.js';
import { sanitizeTrace } from '../packages/trace-sanitizer/dist/index.js';
import { synthesizeContract } from '../packages/contract-synthesizer/dist/index.js';
import { approveContract, reviewContract, verifyContractIntegrity } from '../packages/contract-review/dist/index.js';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';
import { repairHttpMethod } from '../packages/codemods/dist/index.js';
import { ArtifactStore, AuditTrail, runRepairLoop, verifyAudit } from '../packages/engine/dist/index.js';
import { fileHash, BoundedWorker } from '../packages/llm-worker/dist/index.js';
import { evaluateGates, checkTypeScript, measureCoverage, lintCandidate } from '../packages/quality-gates/dist/index.js';

await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(resolve('artifacts/pilot-'));
const store = new ArtifactStore(root), audit = new AuditTrail();
const fixture = await frameworkFixture();
const browser = await chromium.launch();
try {
  const scenario = JSON.parse(await readFile('examples/angular-react-pilot/scenario.json', 'utf8'));
  const discovery = await discover('examples/angular-react-pilot/source');
  const plan = planTransformation(discovery);
  audit.record('DISCOVERY', { unitId: discovery.unit.id, symbols: discovery.unit.symbols.map(s => s.id) });
  await store.write('discovery.json', discovery); await store.write('plan.json', plan);
  const sanitizer = { pseudonymizationKey: randomBytes(32).toString('hex'), allowedPayloadKeys: ['email'], allowedStorageKeys: ['profile.saved'] };
  let latestTarget;
  const capture = async (side, runIndex) => {
    const raw = await captureScenario(scenario, runIndex, { browser, baseUrl: side === 'source' ? fixture.sourceUrl : fixture.targetUrl });
    await store.writeRaw(`${scenario.unitId}-${side}`, raw);
    const safe = sanitizeTrace(raw, sanitizer); await store.writeSanitized(scenario.unitId, side, safe); if (side === 'target') latestTarget = safe; return safe;
  };
  const runs = [];
  for (let run = 1; run <= 3; run++) runs.push(await capture('source', run));
  audit.record('SOURCE_TRACE_CAPTURE', { runs: runs.length });
  const draft = synthesizeContract(scenario.unitId, runs, [endpoint()]);
  await store.write('contract.draft.json', draft);
  // Simulated approval belongs only to this synthetic fixture, never to user contracts.
  const approved = approveContract(reviewContract(draft), 'synthetic-pilot-reviewer');
  const baseline = JSON.stringify(approved);
  await store.write('contract.approved.json', approved);
  audit.record('SYNTHETIC_CONTRACT_APPROVAL', { reviewer: approved.integrity.approvedBy, hash: approved.integrity.contentHash });
  await store.write('transformation.manifest.json', fixture.transformed.manifest);
  await store.write('candidate.initial.json', { code: fixture.transformed.code });
  const staticCheck = checkTypeScript({ 'candidate.tsx': fixture.transformed.code });
  assert.ok(staticCheck.passed, staticCheck.diagnostics.join('\n'));
  audit.record('TRANSFORM', { transformer: fixture.transformed.manifest.transformer, candidateHash: fileHash(fixture.transformed.code) });
  const equivalent = new EquivalenceValidator().validate({ source: runs[0], target: await capture('target', 1), contract: approved });
  assert.equal(equivalent.status, 'EQUIVALENT', JSON.stringify(equivalent.divergences));
  await store.write('equivalence.initial.json', equivalent);
  let candidate = repairHttpMethod(fixture.transformed.code, 'POST', 'PUT');
  await fixture.setTarget(candidate);
  audit.record('INJECT_REGRESSION', { expected: 'PUT', actual: 'POST' });
  const result = await runRepairLoop({ source: runs[0], contract: approved, manifest: fixture.transformed.manifest, maxRepairAttempts: 2, audit,
    captureTarget: async attempt => capture('target', attempt + 2),
    repair: async (failure, attempt) => {
      await store.write(`equivalence.regression-${attempt}.json`, failure);
      assert.ok(failure.divergences.some(d => d.code === 'NETWORK_METHOD_MISMATCH'));
      const worker = new BoundedWorker({ complete: async request => {
        const data = JSON.parse(request.data);
        return { patches: [{ path: 'candidate.tsx', beforeHash: fileHash(data.files['candidate.tsx']), content: repairHttpMethod(data.files['candidate.tsx'], data.failure.expectedMethod, data.failure.actualMethod) }], manifest: fixture.transformed.manifest };
      } }, { allowedFiles: ['candidate.tsx'], allowedPackages: ['react'], maxFiles: 1, maxInputBytes: 50000, maxOutputBytes: 50000, timeoutMs: 5000 });
      const repaired = await worker.repair({ plan, files: { 'candidate.tsx': candidate }, trace: runs[0], failure: { code: 'NETWORK_METHOD_MISMATCH', expectedMethod: 'PUT', actualMethod: 'POST' } });
      candidate = repaired.patches[0].content;
      await store.write(`repair-${attempt}.json`, repaired);
      await fixture.setTarget(candidate);
      return { changedFiles: ['candidate.tsx'], patchHash: fileHash(candidate) };
    },
  });
  assert.equal(result.result.status, 'EQUIVALENT'); assert.equal(result.attempts, 1);
  assert.equal(JSON.stringify(approved), baseline); assert.ok(verifyContractIntegrity(approved)); assert.ok(verifyAudit(result.audit));
  const finalStaticCheck = checkTypeScript({ 'candidate.tsx': candidate });
  assert.ok(finalStaticCheck.passed, finalStaticCheck.diagnostics.join('\n'));
  const lint = await lintCandidate({ 'candidate.tsx': candidate });
  assert.ok(lint.passed, JSON.stringify(lint.diagnostics));
  await store.write('lint.json', lint);
  const coverage = measureCoverage({ routes: ['/customers/:id'], mutations: [{ method: 'PUT', pathTemplate: '/api/customers/:id' }], scenarios: [scenario] }, [latestTarget]);
  const gates = evaluateGates({ unitId: scenario.unitId, results: [result.result], requiredScenarioIds: [scenario.scenarioId], contractIntegrityVerified: true, securityBoundaryVerified: true, staticChecksPassed: finalStaticCheck.passed, repairIteration: result.attempts, coverage });
  await store.write('equivalence.final.json', result.result); await store.write('gates.json', gates); await store.write('audit.json', result.audit);
  console.log(JSON.stringify({ result: result.result.status, regression: 'NETWORK_METHOD_MISMATCH', repairAttempts: result.attempts, contractUnchanged: true, auditVerified: true, approval: 'SYNTHETIC_FIXTURE_ONLY', artifacts: root, privateArtifacts: store.privateRoot }, null, 2));
} finally { await browser.close(); await fixture.close(); }
