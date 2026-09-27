import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { trace, contract } from './helpers.mjs';
import { computeBriefId, parseApplyResult, parseBrief, verifyBriefId, LlmSafeTraceSchema } from '../packages/core/dist/index.js';
import { approveContract } from '../packages/contract-review/dist/index.js';
import { applyCandidateBatch, writePublicBatch, withAssistantLock } from '../packages/cli/dist/assistant-files.js';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';
import { classifyFailure } from '../packages/quality-gates/dist/index.js';
import { ArtifactStore, verifyAudit } from '../packages/engine/dist/index.js';
import { fileHash } from '../packages/llm-worker/dist/index.js';

const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const CANDIDATE = 'src/customer-profile.tsx';
const INITIAL = `import React from 'react';\nexport function CustomerProfileComponent() { return <button>Save</button>; }\n`;
const manifest = (unitId = 'CustomerProfileComponent') => ({ unitId, generatedAt: '2026-09-05T00:00:00.000Z', transformer: { kind: 'LLM', name: 'fake-assistant' }, mappings: [{ mappingId: 'm1', source: 'CustomerProfileComponent', target: 'CustomerProfileComponent', preserves: ['SUCCESS_BEHAVIOR'] }] });
const submission = (briefId, patches, unitId) => ({ briefId, patches, manifest: manifest(unitId) });
const patchFor = (path, content, beforeHash = fileHash(content)) => ({ path, beforeHash, content });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'harness-assistant-'));
  const save = async (name, value) => { const path = join(root, name); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)); return path; };
  await mkdir(resolve(join(root, CANDIDATE), '..'), { recursive: true });
  await writeFile(join(root, CANDIDATE), INITIAL);
  await mkdir(join(root, 'examples/fixture'), { recursive: true });
  await writeFile(join(root, 'examples/fixture/customer-profile.ts'), 'export class CustomerProfileComponent {}');
  const unit = { id: 'CustomerProfileComponent', version: '1.0.0', runtimeRoutes: [], symbols: [{ id: 'examples/fixture/customer-profile.ts#CustomerProfileComponent', name: 'CustomerProfileComponent', kind: 'component', filePath: 'examples/fixture/customer-profile.ts', exported: true, astHash: createHash('sha256').update('unit').digest('hex') }], dependencyGraph: [], inputs: [], outputs: [], reactiveForms: [], providerScopes: [], boundary: { entrypoints: ['examples/fixture/customer-profile.ts#CustomerProfileComponent'], internalSymbols: ['examples/fixture/customer-profile.ts#CustomerProfileComponent'], externalDependencies: [] }, resolutionMetrics: { totalSymbolsIdentified: 1, resolvedSymbolsCount: 1, resolutionCoverage: 1, unresolvedSymbols: [], dynamicEdgesCount: 0 }, metadata: { loc: 10, cyclomaticComplexity: 1, hasRxjsStreams: false, hasDynamicForms: false, templateAstComplexityScore: 0 } };
  const plan = { unitId: 'CustomerProfileComponent', createdAt: '2026-09-05T00:00:00.000Z', items: [{ sourceSymbol: unit.symbols[0].id, targetConcept: 'React component', transformationClass: 'STRUCTURE_CHANGING', mechanism: 'LLM', rationale: 'fixture' }] };
  const scenario = { scenarioId: 'update-customer', unitId: 'CustomerProfileComponent', name: 'update', description: 'fixture scenario', entryUrl: 'http://app.test/customers/123', preconditions: {}, steps: [], testDataProfile: 'standard' };
  const paths = {
    unit: await save('unit.json', unit),
    plan: await save('plan.json', plan),
    contract: await save('contract.json', contract()),
    scenario: await save('scenario.json', scenario),
    sourceTrace: await save('source-trace.json', trace()),
    policy: await save('policy.json', { assistant: { allowedPackages: ['react'], targetConventions: { framework: 'react', language: 'typescript' }, maxBriefBytes: 131072, maxSubmissionBytes: 200000 } }),
  };
  const runBrief = async (extra = []) => exec(process.execPath, [cli, 'brief', '--unit-id', 'CustomerProfileComponent', '--unit', paths.unit, '--plan', paths.plan, '--contract', paths.contract, '--scenario', paths.scenario, '--source-trace', paths.sourceTrace, '--policy', paths.policy, '--candidate-files', CANDIDATE, '--source-root', root, '--candidate-root', root, '--artifact-root', root, '--out', 'brief.json', ...extra]);
  const runApply = async (briefFile, body, extra = []) => { const input = await save('submission.json', body); return exec(process.execPath, [cli, 'apply-patch', '--brief', briefFile, '--input', input, '--artifact-root', root, '--candidate-root', root, '--policy', paths.policy, '--out', 'apply.json', ...extra]); };
  return { root, paths, runBrief, runApply, save };
}

async function refusal(run) {
  try { const { stdout } = await run; return { status: stdout.trim(), code: 0 }; }
  catch (error) { return { status: String(error.stdout).trim(), code: error.code, stderr: String(error.stderr) }; }
}

test('brief issues a hash-bound, projection-only artifact and refuses unsafe inputs', async () => {
  const { root, paths, runBrief, save } = await workspace();
  try {
    await runBrief();
    const brief = parseBrief(JSON.parse(await readFile(join(root, 'brief.json'), 'utf8')));
    assert.equal(verifyBriefId(brief), true);
    assert.equal(brief.kind, 'TRANSFORM_BRIEF');
    assert.equal(brief.task, 'TRANSFORM');
    assert.ok(!brief.repair);
    assert.equal(brief.trace.kind, 'LLM_SAFE_TRACE');
    assert.deepEqual(brief.allowedFiles, [{ path: CANDIDATE, sha256: fileHash(INITIAL), exists: true }]);
    assert.deepEqual(brief.contextFiles.map(p => p.replaceAll('\\', '/')), [join(root, 'examples/fixture/customer-profile.ts').replaceAll('\\', '/')]);
    assert.deepEqual(brief.allowedPackages, ['react']);
    assert.match(brief.submission.format.instructions, /AGENTS\.md/);
    const command = brief.submission.command.replaceAll('\\', '/');
    const briefPath = join(root, 'brief.json').replaceAll('\\', '/');
    const rootPosix = root.replaceAll('\\', '/');
    const unquoted = command.replace(/'/g, '');
    assert.ok(unquoted.includes(`--brief ${briefPath}`), `command must cite ${briefPath}: ${command}`);
    assert.ok(unquoted.includes(`--candidate-root ${rootPosix}`), `command must cite ${rootPosix}`);
    assert.ok(command.includes('--input <submission.json>'));
    // A raw (un-sanitized) trace must never feed a brief.
    const raw = trace(); delete raw.sanitization;
    const rawPath = await save('raw-trace.json', raw);
    let result = await refusal(exec(process.execPath, [cli, 'brief', '--unit-id', 'CustomerProfileComponent', '--unit', paths.unit, '--plan', paths.plan, '--contract', paths.contract, '--scenario', paths.scenario, '--source-trace', rawPath, '--policy', paths.policy, '--candidate-files', CANDIDATE, '--candidate-root', root, '--artifact-root', root, '--out', 'raw-brief.json']));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /sanitized/);
    // A non-APPROVED contract is refused.
    const draft = contract(); draft.status = 'DRAFT'; draft.integrity = { algorithm: 'sha256', contentHash: '' };
    const draftPath = await save('draft.json', draft);
    result = await refusal(exec(process.execPath, [cli, 'brief', '--unit-id', 'CustomerProfileComponent', '--unit', paths.unit, '--plan', paths.plan, '--contract', draftPath, '--scenario', paths.scenario, '--source-trace', paths.sourceTrace, '--policy', paths.policy, '--candidate-files', CANDIDATE, '--candidate-root', root, '--artifact-root', root, '--out', 'draft-brief.json']));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /not APPROVED|APPROVED/);
    // A tampered contract (hash mismatch) is refused.
    const tampered = JSON.parse(await readFile(paths.contract, 'utf8')); tampered.scenarios[0].invariants.storageDeltas = []; tampered.integrity.contentHash = 'a'.repeat(64);
    const tamperedPath = await save('tampered.json', tampered);
    result = await refusal(exec(process.execPath, [cli, 'brief', '--unit-id', 'CustomerProfileComponent', '--unit', paths.unit, '--plan', paths.plan, '--contract', tamperedPath, '--scenario', paths.scenario, '--source-trace', paths.sourceTrace, '--policy', paths.policy, '--candidate-files', CANDIDATE, '--candidate-root', root, '--artifact-root', root, '--out', 'tampered-brief.json']));
    assert.notEqual(result.code, 0);
    // Inputs resolving inside the private/raw domain are refused, including '.migration-private' paths.
    await mkdir(join(root, '.migration-private'), { recursive: true });
    const privateUnit = await save('.migration-private/unit.json', JSON.parse(await readFile(paths.unit, 'utf8')));
    result = await refusal(exec(process.execPath, [cli, 'brief', '--unit-id', 'CustomerProfileComponent', '--unit', privateUnit, '--plan', paths.plan, '--contract', paths.contract, '--scenario', paths.scenario, '--source-trace', paths.sourceTrace, '--policy', paths.policy, '--candidate-files', CANDIDATE, '--candidate-root', root, '--artifact-root', root, '--out', 'stolen-brief.json']));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /private artifact domain/);
    // A policy without the assistant section cannot issue briefs.
    const barePolicy = await save('bare-policy.json', {});
    result = await refusal(exec(process.execPath, [cli, 'brief', '--unit-id', 'CustomerProfileComponent', '--unit', paths.unit, '--plan', paths.plan, '--contract', paths.contract, '--scenario', paths.scenario, '--source-trace', paths.sourceTrace, '--policy', barePolicy, '--candidate-files', CANDIDATE, '--candidate-root', root, '--artifact-root', root, '--out', 'bare-brief.json']));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /assistant section/);
  } finally { await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('repair briefs are issued only for AUTO_REPAIRABLE dispositions', async () => {
  const { root, runBrief, save } = await workspace();
  try {
    const methodMismatch = new EquivalenceValidator().validate({ source: trace('PUT'), target: trace('POST') });
    assert.equal(classifyFailure(methodMismatch), 'AUTO_REPAIRABLE');
    const equivalencePath = await save('equivalence.json', methodMismatch);
    await runBrief(['--repair', '--equivalence', equivalencePath]);
    const brief = parseBrief(JSON.parse(await readFile(join(root, 'brief.json'), 'utf8')));
    assert.equal(brief.kind, 'REPAIR_BRIEF');
    assert.equal(brief.task, 'REPAIR');
    assert.equal(brief.repair.failure.code, 'NETWORK_METHOD_MISMATCH');
    assert.equal(brief.repair.editBudgetBytes, 4096);
    const escalation = { ...methodMismatch, divergences: [{ divergenceId: 'c1', scenarioId: 'update-customer', dimension: 'CONTRACT', code: 'CONTRACT_VIOLATION', severity: 'BLOCKING', message: 'critical contract violated' }] };
    assert.equal(classifyFailure(escalation), 'REQUIRES_CONTRACT_REVIEW');
    const escalatedPath = await save('escalation.json', escalation);
    const result = await refusal(runBrief(['--repair', '--equivalence', escalatedPath]));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /only AUTO_REPAIRABLE/);
  } finally { await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('apply-patch refusal matrix rejects atomically for every refusal code', async () => {
  const { root, runBrief, runApply, save } = await workspace();
  try {
    await runBrief();
    const briefFile = join(root, 'brief.json');
    const brief = parseBrief(JSON.parse(await readFile(briefFile, 'utf8')));
    const good = patchFor(CANDIDATE, `import React from 'react';\nexport function CustomerProfileComponent() { return <button>Save</button>; }`, fileHash(INITIAL));
    const cases = {
      PATCH_PATH_OUTSIDE_BOUNDARY: submission(brief.briefId, [patchFor('src/evil.tsx', 'export const evil = 1;')], brief.unitId),
      BASELINE_HASH_MISMATCH: submission(brief.briefId, [patchFor(CANDIDATE, 'export const ok = 1;', 'f'.repeat(64))], brief.unitId),
      AST_FORBIDDEN_CONSTRUCT: submission(brief.briefId, [patchFor(CANDIDATE, `const f = Function('return 1');\nexport const x = f;`, fileHash(INITIAL))], brief.unitId),
      IMPORT_NOT_ALLOWED: submission(brief.briefId, [patchFor(CANDIDATE, `import { pick } from 'lodash';\nexport const x = pick;`, fileHash(INITIAL))], brief.unitId),
      PSEUDONYM_IN_PATCH: submission(brief.briefId, [patchFor(CANDIDATE, `export const note = 'p_ab12cd34ef56ab78cd90ef12';`, fileHash(INITIAL))], brief.unitId),
      RAW_PATH_REFERENCE: submission(brief.briefId, [patchFor(CANDIDATE, `// data from .migration-private/raw/update-customer/1.json\nexport const x = 1;`, fileHash(INITIAL))], brief.unitId),
      SCHEMA_INVALID: { ...submission(brief.briefId, [good], brief.unitId), notes: 'free-roaming assistant' },
      MANIFEST_UNIT_MISMATCH: submission(brief.briefId, [good], 'OtherComponent'),
      BRIEF_ID_MISMATCH: submission('b_' + '0'.repeat(64), [good], brief.unitId),
      EDIT_BUDGET_EXCEEDED: null,
    };
    for (const [code, body] of Object.entries(cases)) {
      if (!body) continue;
      const result = await refusal(runApply(briefFile, body));
      assert.notEqual(result.code, 0, code);
      const applied = parseApplyResult(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')));
      assert.equal(applied.status, 'REFUSED', code);
      assert.ok(applied.refusals.some(refusal => refusal.code === code), `${code}: ${JSON.stringify(applied.refusals)}`);
      assert.deepEqual(applied.appliedFiles, [], code);
      assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL, `${code} must not modify files`);
    }
    // Tampered brief (content edited after issuance) is caught by the briefId hash.
    const tamperedBrief = JSON.parse(await readFile(briefFile, 'utf8'));
    tamperedBrief.scenarios[0].name = 'Renamed by an attacker';
    const tamperedPath = await save('tampered-brief.json', tamperedBrief);
    const tamperResult = await refusal(runApply(tamperedPath, submission(tamperedBrief.briefId, [good], tamperedBrief.unitId)));
    assert.notEqual(tamperResult.code, 0);
    assert.equal(parseApplyResult(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8'))).refusals[0].code, 'BRIEF_ID_MISMATCH');
    // Repair briefs enforce the edit budget.
    const methodMismatch = new EquivalenceValidator().validate({ source: trace('PUT'), target: trace('POST') });
    const equivalencePath = await save('equivalence.json', methodMismatch);
    await runBrief(['--repair', '--equivalence', equivalencePath, '--out', 'repair-brief.json']);
    const repairBriefFile = join(root, 'repair-brief.json');
    const repairBrief = parseBrief(JSON.parse(await readFile(repairBriefFile, 'utf8')));
    const oversize = submission(repairBrief.briefId, [patchFor(CANDIDATE, INITIAL + '\n' + 'x'.repeat(5000), fileHash(INITIAL))], repairBrief.unitId);
    const budgetResult = await refusal(runApply(repairBriefFile, oversize));
    assert.notEqual(budgetResult.code, 0);
    assert.equal(parseApplyResult(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8'))).refusals.some(r => r.code === 'EDIT_BUDGET_EXCEEDED'), true);
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL, 'refused repairs must not touch files either');
  } finally { await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('apply-patch PASS writes exactly the submitted files plus public artifacts and a valid audit chain', async () => {
  const { root, runBrief, runApply, paths } = await workspace();
  try {
    await runBrief();
    const briefFile = join(root, 'brief.json');
    const brief = parseBrief(JSON.parse(await readFile(briefFile, 'utf8')));
    const after = `import React from 'react';\nexport function CustomerProfileComponent() { return <button type="button">Save</button>; }\n`;
    const result = await runApply(briefFile, submission(brief.briefId, [patchFor(CANDIDATE, after, fileHash(INITIAL))], brief.unitId), ['--scenario', paths.scenario, '--contract', paths.contract, '--source-url', 'http://source.test', '--target-url', 'http://target.test', '--manifest', 'manifest.json', '--next-out', 'verify.json']);
    assert.equal(result.stdout.trim(), 'PASS');
    const applied = parseApplyResult(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')));
    assert.equal(applied.status, 'PASS');
    assert.deepEqual(applied.appliedFiles, [CANDIDATE]);
    assert.equal(applied.briefId, brief.briefId);
    assert.match(applied.next.command.replaceAll('\\', '/'), /^run --scenario .* --contract .* --source-url http:\/\/source\.test --target-url http:\/\/target\.test --manifest .*assistant\/manifests\/.* --max-repairs 0 --out verify\.json$/);
    const manifestFiles = await readdir(join(root, 'assistant/manifests'));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'assistant/manifests', manifestFiles[0]), 'utf8')), manifest());
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), after);
    const submissions = (await readdir(join(root, 'assistant/submissions'))).filter(name => name.startsWith(brief.briefId));
    assert.equal(submissions.length, 1);
    assert.equal((await readdir(join(root, 'assistant/results'))).filter(name => name.startsWith(brief.briefId)).length, 1);
    const audit = JSON.parse(await readFile(join(root, 'assistant/audit.json'), 'utf8'));
    assert.equal(verifyAudit(audit), true);
    assert.deepEqual(audit.map(entry => entry.action), ['BRIEF_ISSUED', 'APPLY_PASS']);
  } finally { await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('end-to-end fake assistant loop: brief, apply, verify, repair brief, repair apply', async () => {
  const { root, runBrief, runApply, paths, save } = await workspace();
  try {
    // 1. Transform brief -> working candidate that saves via POST (the regression, as if authored wrong).
    await runBrief();
    const briefFile = join(root, 'brief.json');
    const brief = parseBrief(JSON.parse(await readFile(briefFile, 'utf8')));
    const broken = `import React from 'react';\nexport function CustomerProfileComponent() { const save = async () => { await fetch('/api/customers/123', { method: 'POST' }); }; return <button onClick={save}>Save</button>; }\n`;
    assert.equal((await runApply(briefFile, submission(brief.briefId, [patchFor(CANDIDATE, broken, fileHash(INITIAL))], brief.unitId))).stdout.trim(), 'PASS');
    // 2. Verification (equivalence without a browser: sanitized source vs observed target behaviour) fails auto-repairably.
    const regression = new EquivalenceValidator().validate({ source: trace('PUT', { email: 'updated@example.test' }), target: trace('POST', { email: 'updated@example.test' }) });
    assert.equal(classifyFailure(regression), 'AUTO_REPAIRABLE');
    const equivalencePath = await save('equivalence.json', regression);
    // 3. Repair brief bound to the *current* baseline hash.
    await runBrief(['--repair', '--equivalence', equivalencePath]);
    const repairBrief = parseBrief(JSON.parse(await readFile(briefFile, 'utf8')));
    assert.equal(verifyBriefId(repairBrief), true);
    assert.equal(repairBrief.allowedFiles[0].sha256, fileHash(broken));
    // 4. Minimal repair patch within budget -> PASS; verification is equivalent again.
    const fixed = broken.replace("method: 'POST'", "method: 'PUT'");
    assert.equal((await runApply(briefFile, submission(repairBrief.briefId, [patchFor(CANDIDATE, fixed, fileHash(broken))], repairBrief.unitId))).stdout.trim(), 'PASS');
    assert.equal(new EquivalenceValidator().validate({ source: trace('PUT', { email: 'updated@example.test' }), target: trace('PUT', { email: 'updated@example.test' }) }).status, 'EQUIVALENT');
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), fixed);
    // 5. A deliberate out-of-allowlist submission is refused atomically; nothing else moved.
    const rogue = await refusal(runApply(briefFile, submission(repairBrief.briefId, [patchFor(paths.scenario.replace(root + '/', ''), 'export const tampering = 1;')], repairBrief.unitId)));
    assert.notEqual(rogue.code, 0);
    const refused = parseApplyResult(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')));
    assert.equal(refused.status, 'REFUSED');
    assert.ok(refused.refusals.some(item => item.code === 'PATCH_PATH_OUTSIDE_BOUNDARY'));
    const audit = JSON.parse(await readFile(join(root, 'assistant/audit.json'), 'utf8'));
    assert.equal(verifyAudit(audit), true);
    assert.deepEqual(audit.map(entry => entry.action), ['BRIEF_ISSUED', 'APPLY_PASS', 'BRIEF_ISSUED', 'APPLY_PASS', 'APPLY_REFUSED']);
  } finally { await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('apply refuses a recomputed forged brief, a stale baseline and changed protected inputs', async () => {
  const { root, runBrief, runApply, paths, save } = await workspace();
  try {
    await runBrief();
    const briefFile = join(root, 'brief.json');
    const brief = JSON.parse(await readFile(briefFile, 'utf8'));
    const good = patchFor(CANDIDATE, 'export const value = 1;', fileHash(INITIAL));
    const forged = structuredClone(brief);
    forged.allowedPackages.push('unapproved');
    forged.briefId = computeBriefId(forged);
    assert.equal(verifyBriefId(forged), true, 'a hash is not proof of issuance');
    const forgedPath = await save('forged.json', forged);
    assert.equal((await refusal(runApply(forgedPath, submission(forged.briefId, [good])))).code, 3);
    assert.equal((JSON.parse(await readFile(join(root, 'apply.json'), 'utf8'))).refusals[0].code, 'BRIEF_ID_MISMATCH');
    const changed = INITIAL + '\n// changed by another writer\n';
    await writeFile(join(root, CANDIDATE), changed);
    assert.equal((await refusal(runApply(briefFile, submission(brief.briefId, [{ ...good, beforeHash: fileHash(changed) }])))).code, 3);
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), changed);
    await writeFile(join(root, CANDIDATE), INITIAL);
    await writeFile(paths.plan, (await readFile(paths.plan, 'utf8')) + '\n');
    assert.equal((await refusal(runApply(briefFile, submission(brief.briefId, [good])))).code, 3);
    assert.match(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')).refusals[0].message, /protected input/);
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('brief and apply reject private input aliases, candidate symlinks and output collisions', async () => {
  const { root, runBrief, runApply, paths, save } = await workspace();
  try {
    const privatePath = await save('.migration-private/policy.json', { assistant: { allowedPackages: [] } });
    const alias = join(root, 'policy-alias.json');
    await symlink(privatePath, alias);
    assert.match((await refusal(runBrief(['--policy', alias]))).stderr, /private artifact domain/);
    await symlink(join(root, '.migration-private'), join(root, 'hidden'));
    assert.match((await refusal(runBrief(['--unit', join(root, 'hidden/policy.json')]))).stderr, /private artifact domain/);
    const before = await readFile(paths.contract, 'utf8');
    assert.notEqual((await refusal(runBrief(['--out', 'contract.json']))).code, 0);
    assert.equal(await readFile(paths.contract, 'utf8'), before);
    await runBrief();
    const briefFile = join(root, 'brief.json'), brief = JSON.parse(await readFile(briefFile, 'utf8'));
    await unlink(join(root, CANDIDATE));
    await writeFile(join(root, 'outside.tsx'), INITIAL);
    await symlink(join(root, 'outside.tsx'), join(root, CANDIDATE));
    const body = submission(brief.briefId, [patchFor(CANDIDATE, 'export const x = 1;', fileHash(INITIAL))]);
    assert.equal((await refusal(runApply(briefFile, body))).code, 3);
    assert.ok(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')).refusals.some(r => r.code === 'PATCH_PATH_OUTSIDE_BOUNDARY'));
    assert.equal(await readFile(join(root, 'outside.tsx'), 'utf8'), INITIAL);
    assert.notEqual((await refusal(runApply(briefFile, body, ['--out', 'brief.json']))).code, 0);
    assert.equal(verifyBriefId(JSON.parse(await readFile(briefFile, 'utf8'))), true);
    assert.notEqual((await refusal(runBrief())).code, 0, 'symlinks refused during issuance too');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('brief rejects unsafe approved content, duplicate paths, exhausted and wrong-scenario repairs', async () => {
  const { root, runBrief, save, paths } = await workspace();
  try {
    assert.notEqual((await refusal(runBrief(['--candidate-files', `${CANDIDATE},${CANDIDATE}`]))).code, 0);
    const mismatch = new EquivalenceValidator().validate({ source: trace('PUT'), target: trace('POST') });
    const path = await save('failure.json', mismatch);
    assert.notEqual((await refusal(runBrief(['--repair', '--equivalence', path, '--attempt', '2', '--max-repairs', '1']))).code, 0);
    const wrong = await save('wrong-failure.json', { ...mismatch, scenarioId: 'another-scenario' });
    assert.match((await refusal(runBrief(['--repair', '--equivalence', wrong]))).stderr, /another scenario/);
    const draft = contract(); draft.status = 'REVIEW';
    draft.scenarios[0].invariants.accessibilityAriaYaml = { id: 'aria', value: 'p_ab12cd34ef56ab78cd90ef12', enforcement: 'INFORMATIONAL', evidenceTrail: [{ source: 'RUNTIME_OBSERVATION', evidenceConfidenceHeuristic: 1 }] };
    const approved = approveContract(draft, 'synthetic-test');
    await save('contract.json', approved);
    const baseline = await readFile(paths.contract, 'utf8');
    assert.match((await refusal(runBrief())).stderr, /forbidden trace tokens/);
    assert.equal(await readFile(paths.contract, 'utf8'), baseline, 'never strip an approved contract');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('submission cap is bound to issuance and manifest content is screened', async () => {
  const { root, runBrief, runApply, save } = await workspace();
  try {
    await save('policy.json', { assistant: { allowedPackages: ['react'], maxSubmissionBytes: 2000 } });
    await runBrief();
    const briefFile = join(root, 'brief.json'), brief = JSON.parse(await readFile(briefFile, 'utf8'));
    const generousPolicy = await save('generous.json', { assistant: { allowedPackages: ['react'], maxSubmissionBytes: 1000000 } });
    const large = submission(brief.briefId, [patchFor(CANDIDATE, INITIAL + '\n//' + 'a'.repeat(2500), fileHash(INITIAL))]);
    assert.equal((await refusal(runApply(briefFile, large, ['--policy', generousPolicy]))).code, 3);
    assert.ok(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')).refusals.some(r => r.code === 'SCHEMA_INVALID'));
    for (const [code, literal] of [['PSEUDONYM_IN_PATCH', 'p_ab12cd34ef56ab78cd90ef12'], ['RAW_PATH_REFERENCE', '/home/someone/.local/state/migration-harness/another/raw/file.json']]) {
      const body = submission(brief.briefId, [patchFor(CANDIDATE, INITIAL)]);
      body.manifest.mappings[0].rationale = literal;
      assert.equal((await refusal(runApply(briefFile, body))).code, 3);
      const result = JSON.parse(await readFile(join(root, 'apply.json'), 'utf8'));
      assert.ok(result.refusals.some(r => r.code === code));
      assert.ok(!JSON.stringify(result).includes(literal), 'refusals must not echo leaked content');
    }
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repair edit budget applies to the whole submission, not each file separately', async () => {
  const { root, runBrief, runApply, save } = await workspace();
  try {
    const second = 'src/second.ts';
    await writeFile(join(root, second), 'export const value = 0;\n');
    const failure = await save('failure.json', new EquivalenceValidator().validate({ source: trace('PUT'), target: trace('POST') }));
    await runBrief(['--candidate-files', `${CANDIDATE},${second}`, '--repair', '--equivalence', failure]);
    const briefFile = join(root, 'brief.json'), brief = JSON.parse(await readFile(briefFile, 'utf8'));
    const patches = [];
    for (const path of [CANDIDATE, second]) {
      const before = await readFile(join(root, path), 'utf8');
      patches.push(patchFor(path, before + '\n//' + 'a'.repeat(2200), fileHash(before)));
    }
    assert.equal((await refusal(runApply(briefFile, submission(brief.briefId, patches)))).code, 3);
    assert.ok(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')).refusals.some(r => r.code === 'EDIT_BUDGET_EXCEEDED'));
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL);
    assert.equal(await readFile(join(root, second), 'utf8'), 'export const value = 0;\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configured static gates reject before any application', async () => {
  const { root, runBrief, runApply, save } = await workspace();
  try {
    await save('policy.json', { assistant: { allowedPackages: ['react'], typecheck: true, lint: true } });
    await runBrief();
    const briefFile = join(root, 'brief.json'), brief = JSON.parse(await readFile(briefFile, 'utf8'));
    const body = submission(brief.briefId, [patchFor(CANDIDATE, 'export const value: number = "wrong";', fileHash(INITIAL))]);
    assert.equal((await refusal(runApply(briefFile, body))).code, 3);
    assert.match(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')).refusals[0].message, /TypeScript/);
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate and artifact batches roll back handled failures and clean staged files', async () => {
  const { root } = await workspace();
  const store = new ArtifactStore(root);
  try {
    const second = 'src/new.ts';
    const patches = [patchFor(CANDIDATE, 'export const changed = 1;', fileHash(INITIAL)), patchFor(second, 'export const added = 1;', fileHash(''))];
    await writeFile(join(root, 'audit.json'), JSON.stringify({ previous: true }));
    await mkdir(join(root, 'blocked.json'));
    await assert.rejects(applyCandidateBatch(root, patches, store, () => writePublicBatch(store, [
      { path: 'audit.json', value: { success: true }, replace: true },
      { path: 'result.json', value: { status: 'PASS' } },
      { path: 'blocked.json', value: { status: 'PASS' }, replace: true },
    ])));
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'audit.json'), 'utf8')), { previous: true });
    await assert.rejects(readFile(join(root, second)), /ENOENT/);
    await assert.rejects(readFile(join(root, 'result.json')), /ENOENT/);
    assert.deepEqual(await readdir(join(root, 'src')), ['customer-profile.tsx']);
    await mkdir(join(root, 'blocked'));
    await writeFile(join(root, 'blocked/parent'), 'not a directory');
    await assert.rejects(applyCandidateBatch(root, [patches[0], patchFor('blocked/parent/new.ts', 'export {};', fileHash(''))], store, async () => {}));
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL);
    assert.deepEqual(await readdir(join(root, 'src')), ['customer-profile.tsx']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('assistant lock refuses overlapping writers and is released on errors', async () => {
  const { root } = await workspace();
  const store = new ArtifactStore(root);
  try {
    await withAssistantLock(store, root, async () => {
      await assert.rejects(withAssistantLock(store, root, async () => {}), /EEXIST/);
    });
    await assert.rejects(withAssistantLock(store, root, async () => { throw new Error('test failure'); }), /test failure/);
    await withAssistantLock(store, root, async () => {});
    await assert.rejects(readFile(join(root, '.harness-assistant.lock')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('partial artifact writes leave neither successful records nor temporary files', async () => {
  const { root } = await workspace();
  class FailingStore extends ArtifactStore {
    async write(path, value, privateArtifact) {
      if (path.startsWith('fail.json')) {
        await writeFile(join(this.root, path), '{"status":"PA');
        throw new Error('injected partial write');
      }
      return super.write(path, value, privateArtifact);
    }
  }
  const store = new FailingStore(root);
  try {
    for (const replace of [false, true]) {
      await assert.rejects(writePublicBatch(store, [{ path: 'fail.json', value: { status: 'PASS' }, replace }]), /injected partial write/);
      assert.ok(!(await readdir(root)).some(path => path.startsWith('fail.json')));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('LLM trace schema accepts only the exact structural projection', () => {
  assert.ok(LlmSafeTraceSchema.safeParse({ kind: 'LLM_SAFE_TRACE', events: [{ type: 'WEBSOCKET_FRAME', direction: 'sent', frameTypes: ['string'] }] }).success);
  for (const event of [{ type: 'HTTP_REQUEST', method: 'GET', payloadTypes: [], url: 'https://private.test' }, { type: 'NAVIGATION', destination: 'secret' }, { type: 'UNRECOGNIZED' }]) {
    assert.equal(LlmSafeTraceSchema.safeParse({ kind: 'LLM_SAFE_TRACE', events: [event] }).success, false);
  }
});

test('existing React context permits read-only imports without expanding the write boundary', async () => {
  const { root, runBrief, runApply } = await workspace();
  try {
    const context = join(root, 'src/Button.tsx');
    const before = 'export const Button = () => null;\n';
    await writeFile(context, before);
    await runBrief(['--context-files', context]);
    const briefFile = join(root, 'brief.json');
    const brief = parseBrief(JSON.parse(await readFile(briefFile, 'utf8')));
    assert.ok(brief.contextFiles.includes(context));
    assert.ok(!brief.allowedFiles.some(file => file.path === 'src/Button.tsx'));
    const body = submission(brief.briefId, [patchFor(CANDIDATE, "import { Button } from './Button'; export const CustomerProfileComponent = Button;", fileHash(INITIAL))]);
    assert.equal((await runApply(briefFile, body)).stdout.trim(), 'PASS');
    assert.equal(await readFile(context, 'utf8'), before);
    await runBrief(['--context-files', context]);
    const next = parseBrief(JSON.parse(await readFile(briefFile, 'utf8')));
    assert.equal((await refusal(runApply(briefFile, submission(next.briefId, [patchFor('src/Button.tsx', 'export const Button = 1;', fileHash(before))])))).code, 3);
    assert.equal(await readFile(context, 'utf8'), before);
    await writeFile(context, before + '// changed\n');
    const current = await readFile(join(root, CANDIDATE), 'utf8');
    assert.equal((await refusal(runApply(briefFile, submission(next.briefId, [patchFor(CANDIDATE, current)])))).code, 3);
    assert.ok(JSON.parse(await readFile(join(root, 'apply.json'), 'utf8')).refusals.some(item => item.code === 'BASELINE_HASH_MISMATCH'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
