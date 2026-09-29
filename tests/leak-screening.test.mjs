import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { trace, contract } from './helpers.mjs';
import { screenPatchContent, collectTraceValues, fileHash, BoundedWorker } from '../packages/llm-worker/dist/index.js';
import { ArtifactStore } from '../packages/engine/dist/index.js';

const exec = promisify(execFile), cli = resolve('packages/cli/dist/index.js');
const TOKEN = 'ab12cd34ef56ab78cd90ef12'; // 24 hex chars: the tail of a pseudonymized trace token.
const CANDIDATE = 'src/customer-profile.tsx';
const INITIAL = `import React from 'react';\nexport function CustomerProfileComponent() { return <button>Save</button>; }\n`;
const patchFor = content => [{ path: CANDIDATE, beforeHash: fileHash(''), content }];
const codes = (content, options) => screenPatchContent(patchFor(content), options);

test('unicode-escaped pseudonym probe is refused after literal decoding', () => {
  const probe = `export const token = '\\u0070_${TOKEN}';`;
  const escapedConcat = `export const token = '\\u0070_' + '${TOKEN}';`;
  for (const content of [probe, escapedConcat]) {
    assert.doesNotMatch(content, /p_[0-9a-f]{24}/, 'the raw-bytes probe must not see this content');
    const refusals = codes(content);
    assert.ok(refusals.some(item => item.code === 'PSEUDONYM_IN_PATCH' && /pseudonymized/.test(item.message)), content);
    assert.equal(refusals.filter(item => item.code === 'PSEUDONYM_IN_PATCH').length, 1, content);
  }
});

test('hex-escaped and constant-concatenated pseudonyms are refused', () => {
  const contents = [
    `export const a = '\\x70_${TOKEN}';`,
    `export const b = 'p_' + '${TOKEN}';`,
    'export const c = `\\u0070_' + TOKEN + '${suffix}`;',
    'export const d = `p_${""}' + TOKEN + '`;',
  ];
  for (const content of contents) {
    assert.doesNotMatch(content, /p_[0-9a-f]{24}/, content);
    assert.ok(codes(content).some(item => item.code === 'PSEUDONYM_IN_PATCH'), content);
  }
});

test('plain raw pseudonym tokens are still refused', () => {
  const raw = `// copied verbatim: p_${TOKEN}\nexport const note = 1;`;
  assert.match(raw, /p_[0-9a-f]{24}/);
  assert.ok(codes(raw).some(item => item.code === 'PSEUDONYM_IN_PATCH'));
  // The raw-domain path screen keeps its raw-bytes check and now also sees decoded literals.
  assert.ok(codes(`// data from .migration-private/raw/update-customer/1.json\nexport const x = 1;`).some(item => item.code === 'RAW_PATH_REFERENCE'));
  assert.ok(codes(`export const p = '.migration\\u002dprivate/raw/x.json';`).some(item => item.code === 'RAW_PATH_REFERENCE'));
});

test('literals already present in authorized baseline files are not refused', () => {
  const traceScreen = collectTraceValues(trace());
  assert.equal(traceScreen.overflow, false);
  // Ordinary legitimate literals are never a leak signal.
  assert.deepEqual(codes(INITIAL), []);
  // A trace-derived value reused from an authorized pre-existing file is allowed...
  const seed = `export const seedEmail = 'person@example.test';\nexport const label = 1;\n`;
  assert.deepEqual(codes(seed, { trace: traceScreen, baselineTexts: [seed] }), []);
  // ...while the same value with no authorized source for it is refused.
  assert.ok(codes(`export const contact = 'person@example.test';`, { trace: traceScreen }).some(item => item.code === 'PSEUDONYM_IN_PATCH'));
});

test('trace value collection truncation refuses screening as incomplete', () => {
  // Depth cap: the walk cannot reach the leaf value, so the result is incomplete.
  let deep = 'a-deep-trace-value';
  for (let level = 0; level < 40; level++) deep = { nested: deep };
  const depthScreen = collectTraceValues(deep);
  assert.equal(depthScreen.overflow, true);
  // Final-value cap: 10_001 distinct >= 8-char strings, of which the walk may keep only 10_000.
  const many = {};
  for (let index = 0; index < 10_001; index++) many[`key-${index}`] = `trace-value-${index}`;
  const countScreen = collectTraceValues(many);
  assert.equal(countScreen.overflow, true);
  assert.equal(countScreen.values.length, 10_000);
  // Fail closed: an incomplete value set refuses even a benign patch instead of accepting dropped values.
  const refusals = codes(`export const ok = 1;`, { trace: depthScreen });
  assert.ok(refusals.some(item => item.code === 'SCHEMA_INVALID' && /screening budget/.test(item.message)), JSON.stringify(refusals));
});

test('overlapping trace values are refused in candidate literals', () => {
  const traceScreen = { values: ['abcdefgh', 'defghijk'], overflow: false };
  const content = `export const v = 'abcdefghijk';`;
  // The baseline authorizes only 'abcdefgh'; the overlapping 'defghijk' must still be caught.
  const refusals = codes(content, { trace: traceScreen, baselineTexts: ['abcdefgh'] });
  assert.ok(refusals.some(item => item.code === 'PSEUDONYM_IN_PATCH' && /trace-derived/.test(item.message)), JSON.stringify(refusals));
  // A baseline that really contains both values exempts both.
  assert.deepEqual(codes(content, { trace: traceScreen, baselineTexts: ['abcdefghijk'] }), []);
});

test('decoded baseline literals still exempt equivalent candidate literals', () => {
  const traceScreen = { values: ['abcdefgh'], overflow: false };
  const baseline = `export const seed = "\\u0061bcdefgh";`;
  assert.deepEqual(codes(`export const v = 'abcdefgh';`, { trace: traceScreen, baselineTexts: [baseline] }), []);
  // The same candidate literal without that baseline is refused.
  assert.ok(codes(`export const v = 'abcdefgh';`, { trace: traceScreen }).some(item => item.code === 'PSEUDONYM_IN_PATCH' && /trace-derived/.test(item.message)));
});

test('trace-derived email and name values from the sanitized trace fixture are refused', () => {
  const fixture = trace();
  fixture.events.push({ type: 'ARIA_STATE_CHANGE', eventId: 'aria', timestampMs: 3, sequenceIndex: 3, triggerEventId: 'scenario_completed', rawYamlTree: '', jsonTree: { role: 'alert', name: 'Ada Lovelace Kerr' } });
  const traceScreen = collectTraceValues(fixture);
  assert.equal(traceScreen.overflow, false);
  assert.ok(traceScreen.values.includes('person@example.test'), JSON.stringify(traceScreen.values));
  assert.ok(traceScreen.values.includes('Ada Lovelace Kerr'));
  for (const value of ['person@example.test', 'Ada Lovelace Kerr']) {
    const content = `export const observed = '${value}';`;
    const refusals = codes(content, { trace: traceScreen });
    assert.ok(refusals.some(item => item.code === 'PSEUDONYM_IN_PATCH' && /trace-derived/.test(item.message)), value);
    // The refusal comes from the trace-value comparison, not from the always-on pseudonym screen.
    assert.deepEqual(codes(content), [], value);
  }
});

test('bounded worker refuses generated patches carrying decoded pseudonyms and trace values', async () => {
  const policy = { allowedFiles: ['candidate.tsx'], allowedPackages: ['react'], maxFiles: 1, maxInputBytes: 10000, maxOutputBytes: 10000, timeoutMs: 1000 };
  const plan = { unitId: 'unit', createdAt: new Date().toISOString(), items: [] };
  const manifest = { unitId: 'unit', generatedAt: new Date().toISOString(), transformer: { kind: 'LLM', name: 'test' }, mappings: [] };
  const files = { 'candidate.tsx': 'export const baseline = 1;' };
  const attempt = content => new BoundedWorker({ complete: async () => ({ patches: [{ path: 'candidate.tsx', beforeHash: fileHash(files['candidate.tsx']), content }], manifest }) }, policy).transform({ plan, files, trace: trace() });
  await assert.rejects(attempt(`export const token = '\\u0070_${TOKEN}';`), /pseudonymized trace token/);
  await assert.rejects(attempt(`export const contact = 'person@example.test';`), /trace-derived/);
  const accepted = await attempt(`export const baseline = 1;\nexport const added = 'Save';`);
  assert.equal(accepted.patches.length, 1);
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'harness-leak-screening-'));
  const save = async (name, value) => { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); return path; };
  await mkdir(dirname(join(root, CANDIDATE)), { recursive: true });
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
    policy: await save('policy.json', { assistant: { allowedPackages: ['react'], maxBriefBytes: 131072, maxSubmissionBytes: 200000 } }),
  };
  const runBrief = () => exec(process.execPath, [cli, 'brief', '--unit-id', 'CustomerProfileComponent', '--unit', paths.unit, '--plan', paths.plan, '--contract', paths.contract, '--scenario', paths.scenario, '--source-trace', paths.sourceTrace, '--policy', paths.policy, '--candidate-files', CANDIDATE, '--source-root', root, '--candidate-root', root, '--artifact-root', root, '--out', 'brief.json']);
  const runApply = async content => {
    const brief = JSON.parse(await readFile(join(root, 'brief.json'), 'utf8'));
    const input = await save('submission.json', { briefId: brief.briefId, patches: [{ path: CANDIDATE, beforeHash: fileHash(INITIAL), content }], manifest: { unitId: 'CustomerProfileComponent', generatedAt: '2026-09-05T00:00:00.000Z', transformer: { kind: 'LLM', name: 'leak-screening-fixture' }, mappings: [{ mappingId: 'm1', source: 'CustomerProfileComponent', target: 'CustomerProfileComponent', preserves: ['SUCCESS_BEHAVIOR'] }] } });
    return exec(process.execPath, [cli, 'apply-patch', '--brief', join(root, 'brief.json'), '--input', input, '--artifact-root', root, '--candidate-root', root, '--policy', paths.policy, '--out', 'apply.json']);
  };
  return { root, runBrief, runApply };
}

const refused = async run => { try { await run; return { code: 0 }; } catch (error) { return { code: error.code, stdout: String(error.stdout) }; } };

test('apply-patch refuses decoded pseudonym and trace-derived submissions end to end', async () => {
  const { root, runBrief, runApply } = await workspace();
  try {
    await runBrief();
    const readResult = async () => JSON.parse(await readFile(join(root, 'apply.json'), 'utf8'));
    const probe = `export const token = '\\u0070_${TOKEN}';`;
    assert.doesNotMatch(probe, /p_[0-9a-f]{24}/);
    // (1) The probe passes validatePatches and the raw-bytes screen, and is refused by decoded screening.
    assert.equal((await refused(runApply(probe))).code, 3);
    const pseudonym = await readResult();
    assert.equal(pseudonym.status, 'REFUSED');
    assert.ok(pseudonym.refusals.some(item => item.code === 'PSEUDONYM_IN_PATCH' && /pseudonymized/.test(item.message)), JSON.stringify(pseudonym.refusals));
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL, 'refused submissions must not modify files');
    // (5) A trace-derived value from the sanitized source trace is refused at the submission boundary.
    assert.equal((await refused(runApply(`export const contact = 'person@example.test';`))).code, 3);
    const leaked = await readResult();
    assert.ok(leaked.refusals.some(item => item.code === 'PSEUDONYM_IN_PATCH' && /trace-derived/.test(item.message)), JSON.stringify(leaked.refusals));
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL, 'refused submissions must not modify files');
    // Legitimate code still applies: the screens must not block normal submissions.
    const good = `import React from 'react';\nexport function CustomerProfileComponent() { return <button type="button">Save</button>; }`;
    assert.equal((await runApply(good)).stdout.trim(), 'PASS');
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), good);
  } finally {
    await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluation-input values are not exempt at the apply boundary', async () => {
  const { root, runBrief, runApply } = await workspace();
  try {
    await runBrief();
    // 'update-customer' is the scenarioId inside the scenario and contract documents (evaluation inputs) and also a
    // sanitized-trace value; only implementation/context files and candidate baselines may exempt a trace value.
    assert.equal((await refused(runApply(`export const scenarioId = 'update-customer';`))).code, 3);
    const result = JSON.parse(await readFile(join(root, 'apply.json'), 'utf8'));
    assert.equal(result.status, 'REFUSED');
    assert.ok(result.refusals.some(item => item.code === 'PSEUDONYM_IN_PATCH' && /trace-derived/.test(item.message)), JSON.stringify(result.refusals));
    assert.equal(await readFile(join(root, CANDIDATE), 'utf8'), INITIAL, 'refused submissions must not modify files');
  } finally {
    await rm(new ArtifactStore(root).privateRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
