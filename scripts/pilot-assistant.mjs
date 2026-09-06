/**
 * Assistant-driven equivalent of scripts/pilot.mjs (docs/ASSISTANT-INTEGRATION.md §6).
 * The "assistant" here is deterministic in-script logic (the codemod), but every trust
 * boundary is the real one: briefs and applications go through the actual CLI, gates
 * through the actual harness. This tests the protocol, not the recorded human-driven
 * assistant session required by section 6.2.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { frameworkFixture } from '../tests/browser/fixture.mjs';
import { endpoint } from '../tests/helpers.mjs';
import { discover } from '../packages/static-analyzer/dist/index.js';
import { planTransformation } from '../packages/transformation-planner/dist/index.js';
import { captureScenario } from '../packages/scenario-runner/dist/index.js';
import { sanitizeTrace } from '../packages/trace-sanitizer/dist/index.js';
import { synthesizeContract } from '../packages/contract-synthesizer/dist/index.js';
import { approveContract, reviewContract, verifyContractIntegrity } from '../packages/contract-review/dist/index.js';
import { repairHttpMethod } from '../packages/codemods/dist/index.js';
import { ArtifactStore, verifyAudit } from '../packages/engine/dist/index.js';
import { fileHash } from '../packages/llm-worker/dist/index.js';
import { parseApplyResult, parseBrief, verifyBriefId } from '../packages/core/dist/index.js';

const exec = promisify(execFile);
const cli = resolve('packages/cli/dist/index.js');
const CANDIDATE = 'src/customer-profile.tsx';

await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(resolve('artifacts/pilot-assistant-'));
const store = new ArtifactStore(root);
const fixture = await frameworkFixture();
const browser = await chromium.launch();
const harness = (...args) => exec(process.execPath, [cli, ...args, '--artifact-root', root]);
const save = async (name, value) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
const read = path => readFile(join(root, path), 'utf8').then(JSON.parse);
const refused = async run => { try { const ok = await run; return { code: 0, stdout: ok.stdout }; } catch (error) { return { code: error.code, stdout: String(error.stdout) }; } };
const briefArgs = (out, extra = []) => ['brief', '--unit-id', 'CustomerProfileComponent', '--unit', join(root, 'unit.json'), '--plan', join(root, 'plan.json'), '--contract', join(root, 'contract.json'), '--scenario', join(root, 'scenario.json'), '--source-trace', join(root, 'source-trace.json'), '--policy', join(root, 'policy.json'), '--source-root', resolve('examples/angular-react-pilot/source'), '--candidate-files', CANDIDATE, '--candidate-root', join(root, 'work'), ...extra, '--out', out];

try {
  // Shared fixture setup with the deterministic pilot: discovery, plan, contract, approved baseline.
  const scenario = JSON.parse(await readFile('examples/angular-react-pilot/scenario.json', 'utf8'));
  const discovery = await discover('examples/angular-react-pilot/source');
  const plan = planTransformation(discovery);
  const sanitizer = { pseudonymizationKey: randomBytes(32).toString('hex'), allowedPayloadKeys: ['email'], allowedStorageKeys: ['profile.saved'] };
  const runs = [];
  for (let run = 1; run <= 3; run++) {
    const raw = await captureScenario(scenario, run, { browser, baseUrl: fixture.sourceUrl });
    await store.writeRaw(`${scenario.unitId}-setup`, raw);
    runs.push(sanitizeTrace(raw, sanitizer));
  }
  // Synthetic approval belongs only to this fixture, never to user contracts.
  const draft = synthesizeContract(scenario.unitId, runs, [endpoint()]);
  // This fixture approves only structural/critical invariants, before hashing. Runtime
  // ARIA observations contain pseudonyms and cannot be sent in assistant briefs.
  for (const entry of draft.scenarios) {
    delete entry.invariants.accessibilityAriaYaml;
    delete entry.invariants.accessibilityAriaJson;
  }
  const approved = approveContract(reviewContract(draft), 'synthetic-pilot-reviewer');
  const contractBaseline = JSON.stringify(approved);
  await mkdir(join(root, 'work/src'), { recursive: true });
  await save('unit.json', discovery.unit); await save('plan.json', plan); await save('contract.json', approved);
  await save('scenario.json', scenario); await save('source-trace.json', runs[0]);
  await save('policy.json', {
    sanitization: { allowedPayloadKeys: ['email'], allowedStorageKeys: ['profile.saved'] },
    assistant: { allowedPackages: ['react'], targetConventions: { framework: 'react', language: 'typescript' }, maxBriefBytes: 262_144, maxSubmissionBytes: 500_000, typecheck: true, lint: true },
  });
  const manifestPath = await save('transformation.manifest.json', fixture.transformed.manifest);
  const applyArgs = (briefFile, submissionFile, out, extra = []) => ['apply-patch', '--brief', join(root, briefFile), '--input', join(root, submissionFile), '--candidate-root', join(root, 'work'), '--policy', join(root, 'policy.json'), '--out', out, ...extra];

  // (1) TRANSFORM_BRIEF for the unit — hygiene asserted.
  await harness(...briefArgs('brief-1.json'));
  const brief1Text = await read('brief-1.json').then(JSON.stringify);
  const brief1 = parseBrief(JSON.parse(brief1Text));
  assert.equal(brief1.kind, 'TRANSFORM_BRIEF');
  assert.equal(verifyBriefId(brief1), true);
  assert.equal(brief1.trace.kind, 'LLM_SAFE_TRACE');
  assert.ok(!brief1Text.includes(store.privateRoot), 'no private root paths in briefs');
  assert.ok(!/\.migration-private/.test(brief1Text), 'no raw-domain references in briefs');
  assert.ok(!brief1Text.includes('"environment"'), 'briefs carry projections, not trace envelopes');
  assert.ok(!/p_[0-9a-f]{24}/.test(brief1Text), 'the entire brief carries no pseudonyms');
  assert.ok(verifyBriefId(brief1) && verifyContractIntegrity(brief1.contract));

  // (2) The assistant (codemod acting as the assistant) produces patch + manifest from the brief.
  const candidate = fixture.transformed.code;
  await save('submission-1.json', { briefId: brief1.briefId, patches: [{ path: CANDIDATE, beforeHash: fileHash(''), content: candidate }], manifest: fixture.transformed.manifest });
  // (3) apply-patch -> PASS (all gates green).
  const apply1 = await harness(...applyArgs('brief-1.json', 'submission-1.json', 'apply-1.json', ['--scenario', join(root, 'scenario.json'), '--contract', join(root, 'contract.json'), '--source-url', fixture.sourceUrl, '--target-url', fixture.targetUrl, '--manifest', manifestPath, '--next-out', 'run-2.json']));
  assert.equal(apply1.stdout.trim(), 'PASS');
  const applied1 = parseApplyResult(await read('apply-1.json'));
  assert.deepEqual(applied1.appliedFiles, [CANDIDATE]);
  assert.match(applied1.next.command, /^run --scenario .* --max-repairs 0 --out run-2\.json$/);
  assert.equal(await readFile(join(root, 'work', CANDIDATE), 'utf8'), candidate);
  await fixture.setTarget(await readFile(join(root, 'work', CANDIDATE), 'utf8'));
  // (4) run --max-repairs 0 -> EQUIVALENT, harness-issued, disposition surfaced.
  await harness('run', '--scenario', join(root, 'scenario.json'), '--contract', join(root, 'contract.json'), '--source-url', fixture.sourceUrl, '--target-url', fixture.targetUrl, '--manifest', manifestPath, '--policy', join(root, 'policy.json'), '--max-repairs', '0', '--out', join(root, 'run-1.json'));
  const run1 = await read('run-1.json');
  assert.equal(run1.result.status, 'EQUIVALENT'); assert.equal(run1.disposition, null);

  // (5) Harness injects the method regression (assistant re-issues the candidate wrong), verified, then a REPAIR_BRIEF.
  const broken = repairHttpMethod(candidate, 'POST', 'PUT');
  await harness(...briefArgs('brief-2.json'));
  const brief2 = parseBrief(await read('brief-2.json'));
  await save('submission-2.json', { briefId: brief2.briefId, patches: [{ path: CANDIDATE, beforeHash: fileHash(candidate), content: broken }], manifest: fixture.transformed.manifest });
  assert.equal((await harness(...applyArgs('brief-2.json', 'submission-2.json', 'apply-2.json'))).stdout.trim(), 'PASS');
  await fixture.setTarget(await readFile(join(root, 'work', CANDIDATE), 'utf8'));
  const regression = await refused(harness('run', '--scenario', join(root, 'scenario.json'), '--contract', join(root, 'contract.json'), '--source-url', fixture.sourceUrl, '--target-url', fixture.targetUrl, '--manifest', manifestPath, '--policy', join(root, 'policy.json'), '--max-repairs', '0', '--out', join(root, 'run-2.json')));
  assert.equal(regression.code, 4);
  const run2 = await read('run-2.json');
  assert.equal(run2.result.status, 'NOT_EQUIVALENT');
  assert.equal(run2.disposition, 'AUTO_REPAIRABLE');
  assert.ok(run2.result.divergences.some(d => d.code === 'NETWORK_METHOD_MISMATCH'));
  await harness(...briefArgs('repair-brief.json', ['--repair', '--equivalence', join(root, 'run-2.json')]));
  const repairBrief = parseBrief(await read('repair-brief.json'));
  assert.equal(repairBrief.kind, 'REPAIR_BRIEF');
  assert.equal(repairBrief.repair.failure.code, 'NETWORK_METHOD_MISMATCH');

  // (6) Minimal repair patch -> PASS -> EQUIVALENT again.
  const mismatch = run2.result.divergences.find(d => d.code === 'NETWORK_METHOD_MISMATCH');
  const fixed = repairHttpMethod(broken, mismatch.source, mismatch.target);
  await save('submission-3.json', { briefId: repairBrief.briefId, patches: [{ path: CANDIDATE, beforeHash: fileHash(broken), content: fixed }], manifest: fixture.transformed.manifest });
  assert.equal((await harness(...applyArgs('repair-brief.json', 'submission-3.json', 'apply-3.json'))).stdout.trim(), 'PASS');
  await fixture.setTarget(await readFile(join(root, 'work', CANDIDATE), 'utf8'));
  await harness('run', '--scenario', join(root, 'scenario.json'), '--contract', join(root, 'contract.json'), '--source-url', fixture.sourceUrl, '--target-url', fixture.targetUrl, '--manifest', manifestPath, '--policy', join(root, 'policy.json'), '--max-repairs', '0', '--out', join(root, 'run-3.json'));
  assert.equal((await read('run-3.json')).result.status, 'EQUIVALENT');

  // (7) Refusal demonstration: an out-of-allowlist submission is refused atomically, machine-readable.
  await save('submission-4.json', { briefId: repairBrief.briefId, patches: [{ path: 'src/outside-bounds.tsx', beforeHash: fileHash(''), content: 'export const tampering = 1;\n' }], manifest: fixture.transformed.manifest });
  const rogue = await refused(harness(...applyArgs('repair-brief.json', 'submission-4.json', 'apply-4.json')));
  assert.notEqual(rogue.code, 0);
  const refusedResult = parseApplyResult(await read('apply-4.json'));
  assert.equal(refusedResult.status, 'REFUSED');
  assert.ok(refusedResult.refusals.some(item => item.code === 'PATCH_PATH_OUTSIDE_BOUNDARY'));
  await assert.rejects(readFile(join(root, 'work/src/outside-bounds.tsx')), /ENOENT/);

  // (8) Contract untouched, audit valid, assistant artifacts in the public domain.
  assert.equal(JSON.stringify(await read('contract.json')), contractBaseline);
  assert.ok(verifyContractIntegrity(approved));
  const audit = await read('assistant/audit.json');
  assert.equal(verifyAudit(audit), true);
  assert.deepEqual(audit.map(entry => entry.action), ['BRIEF_ISSUED', 'APPLY_PASS', 'BRIEF_ISSUED', 'APPLY_PASS', 'BRIEF_ISSUED', 'APPLY_PASS', 'APPLY_REFUSED']);
  assert.equal((await readdir(join(root, 'assistant/briefs'))).length, 3);
  assert.equal((await readdir(join(root, 'assistant/submissions'))).length, 3);
  assert.equal((await readdir(join(root, 'assistant/refusals'))).length, 1);
  assert.ok((await readdir(join(root, 'assistant/results'))).length >= 4);
  console.log(JSON.stringify({ result: 'ASSISTANT_LOOP_EQUIVALENT', assistant: 'DETERMINISTIC_PROTOCOL_SIMULATION', regression: 'NETWORK_METHOD_MISMATCH', repair: 'REPAIR_BRIEF->PASS', refusal: 'PATCH_PATH_OUTSIDE_BOUNDARY atomic', contractUnchanged: true, auditVerified: true, approval: 'SYNTHETIC_FIXTURE_ONLY', artifacts: root, privateArtifacts: store.privateRoot }, null, 2));
} finally { await browser.close(); await fixture.close(); }
