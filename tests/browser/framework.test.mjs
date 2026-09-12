import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { captureScenario } from '../../packages/scenario-runner/dist/index.js';
import { sanitizeTrace } from '../../packages/trace-sanitizer/dist/index.js';
import { EquivalenceValidator } from '../../packages/equivalence-validator/dist/index.js';
import { repairHttpMethod } from '../../packages/codemods/dist/index.js';
import { runRepairLoop, verifyAudit } from '../../packages/engine/dist/index.js';
import { discover } from '../../packages/static-analyzer/dist/index.js';
import { planTransformation } from '../../packages/transformation-planner/dist/index.js';
import { contract } from '../helpers.mjs';
import { frameworkFixture } from './fixture.mjs';

test('real Angular -> codemod React -> regression -> bounded repair -> equivalence', { timeout: 120000 }, async () => {
  const fixture = await frameworkFixture();
  const browser = await chromium.launch();
  const scenario = JSON.parse(await readFile('examples/angular-react-pilot/scenario.json', 'utf8'));
  const policy = { pseudonymizationKey: 'browser-test-key'.repeat(3), allowedPayloadKeys: ['email'], allowedStorageKeys: ['profile.saved'] };
  try {
    const discovery = await discover('examples/angular-react-pilot/source');
    assert.equal(discovery.unit.symbols[0].kind, 'component');
    assert.ok(discovery.templates[0].bindings.includes('value'));
    assert.equal(planTransformation(discovery).items.length, 1);
    const source = sanitizeTrace(await captureScenario(scenario, 1, { browser, baseUrl: fixture.sourceUrl }), policy);
    const target = sanitizeTrace(await captureScenario(scenario, 1, { browser, baseUrl: fixture.targetUrl }), policy);
    const equivalence = new EquivalenceValidator().validate({ source, target, contract: contract() });
    assert.equal(equivalence.status, 'EQUIVALENT', JSON.stringify(equivalence.divergences));
    assert.deepEqual(equivalence.divergences, []);
    assert.ok(source.events.some(e => e.type === 'HTTP_RESPONSE' && e.statusCode === 204));
    assert.ok(source.events.some(e => e.type === 'STORAGE_DELTA'));
    let candidate = repairHttpMethod(fixture.transformed.code, 'POST', 'PUT');
    await fixture.setTarget(candidate);
    const approved = contract(), hash = approved.integrity.contentHash;
    const result = await runRepairLoop({ source, contract: approved, maxRepairAttempts: 1,
      captureTarget: async attempt => sanitizeTrace(await captureScenario(scenario, attempt + 2, { browser, baseUrl: fixture.targetUrl }), policy),
      repair: async failure => {
        assert.ok(failure.divergences.some(d => d.code === 'NETWORK_METHOD_MISMATCH'));
        candidate = repairHttpMethod(candidate, 'PUT', 'POST'); await fixture.setTarget(candidate);
        return { changedFiles: ['candidate.tsx'], patchHash: 'test-patch' };
      },
    });
    assert.equal(result.result.status, 'EQUIVALENT'); assert.equal(result.attempts, 1);
    assert.equal(approved.integrity.contentHash, hash); assert.equal(verifyAudit(result.audit), true);
  } finally { await browser.close(); await fixture.close(); }
});
