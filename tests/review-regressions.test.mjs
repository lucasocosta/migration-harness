import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical } from '../packages/core/dist/index.js';
import { computeContractHash, protectedContractContent } from '../packages/contract-review/dist/index.js';
import { sanitizeTrace } from '../packages/trace-sanitizer/dist/index.js';
import { EquivalenceValidator } from '../packages/equivalence-validator/dist/index.js';
import { BoundedWorker, fileHash } from '../packages/llm-worker/dist/index.js';
import { ArtifactStore, runRepairLoop } from '../packages/engine/dist/index.js';
import { storeOptions, canCreateSymlink } from './helpers/privacy.mjs';
import { InvariantMiner, synthesizeContract } from '../packages/contract-synthesizer/dist/index.js';
import { classifyFailure } from '../packages/quality-gates/dist/index.js';
import { resolveMockFixture } from '../packages/scenario-runner/dist/index.js';
import { trace, event, contract } from './helpers.mjs';

test('contract hashing shares locale-independent core canonicalization', () => {
  const value = contract();
  value.scenarios[0].invariants.accessibilityAriaJson = { id: 'unicode', value: { Z: 1, a: 2, 'ä': 3, A: { z: 4, Z: 5 } }, enforcement: 'WARNING', evidenceTrail: [{ source: 'HUMAN_SPECIFICATION', evidenceConfidenceHeuristic: 1 }] };
  const expected = createHash('sha256').update(canonical(protectedContractContent(value))).digest('hex');
  const original = String.prototype.localeCompare;
  try { String.prototype.localeCompare = () => { throw new Error('Locale collation must not be used'); }; assert.equal(computeContractHash(value), expected); }
  finally { String.prototype.localeCompare = original; }
});
test('sanitizer denies payload fields by default, normalizes unicode and scrubs ARIA URLs', () => {
  const raw = trace(); delete raw.sanitization;
  raw.events[0].payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"email":"josé@example.test"}');
  event(raw, 'ARIA_STATE_CHANGE', { triggerEventId: 'scenario_completed', rawYamlTree: 'url: https://user:pass@app.test/path?token=hidden', jsonTree: { role: 'link', url: 'https://user:pass@app.test/path?token=hidden&mode=full' } });
  const policy = { pseudonymizationKey: 'review'.repeat(8) };
  const safe = sanitizeTrace(raw, policy); assert.deepEqual(safe.events[0].payload, {});
  assert.doesNotMatch(JSON.stringify(safe), /hidden|user:pass|polluted/); assert.equal({}.polluted, undefined);
  const composed = sanitizeTrace(raw, { ...policy, allowedPayloadKeys: ['email', '__proto__', 'constructor', 'prototype'] });
  raw.events[0].payload.email = 'jose\u0301@example.test';
  assert.equal(sanitizeTrace(raw, { ...policy, allowedPayloadKeys: ['email'] }).events[0].payload.email, composed.events[0].payload.email);
  for (const e of raw.events) if (e.url) e.url = 'https://app.test/malformed%value';
  assert.doesNotThrow(() => sanitizeTrace(raw, policy));
});
test('volatility is explicit and path-template mismatches never invent parameters', () => {
  const source = trace(), target = trace();
  for (const e of target.events) e.url = e.url.replace('/123', '/456');
  source.events[1].body = { id: 1 }; target.events[1].body = { id: 'generated' };
  const validator = new EquivalenceValidator(), rule = { pattern: /^\/api\/customers\/[^/]+$/, template: '/api/customers/:id' };
  assert.equal(validator.validate({ source, target, policy: { network: { pathTemplateRules: [rule] } } }).status, 'NOT_EQUIVALENT');
  assert.equal(validator.validate({ source, target, policy: { network: { pathTemplateRules: [rule], volatilePathParams: { '/api/customers/:id': ['id'] }, volatileResponseFields: ['id'] } } }).status, 'EQUIVALENT');
  assert.throws(() => validator.validate({ source, target, policy: { network: { pathTemplateRules: [{ pattern: /.*/, template: '/incompatible' }] } } }), /incompatible/);
  const a = event(trace(), 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'SET', key: 'nonce', previousValue: null, newValue: 'first' }), b = structuredClone(a); b.events.at(-1).newValue = 'second';
  assert.equal(validator.validate({ source: a, target: b }).status, 'NOT_EQUIVALENT');
  assert.equal(validator.validate({ source: a, target: b, policy: { observables: { volatileStorageValues: [{ storageType: 'localStorage', key: 'nonce' }] } } }).status, 'EQUIVALENT');
});
test('navigation order remains relevant even when intermediate destinations form the same set', () => {
  const a = trace(), b = trace();
  for (const path of ['/login', '/account', '/done']) event(a, 'NAVIGATION', { fromUrl: 'about:blank', toUrl: `https://app.test${path}` });
  for (const path of ['/account', '/login', '/done']) event(b, 'NAVIGATION', { fromUrl: 'about:blank', toUrl: `https://app.test${path}` });
  assert.equal(new EquivalenceValidator().validate({ source: a, target: b }).status, 'NOT_EQUIVALENT');
});
test('worker rejects common dynamic-code aliases, while static checks are not a sandbox', async () => {
  const policy = { allowedFiles: ['candidate.tsx'], allowedPackages: ['react'], maxFiles: 1, maxInputBytes: 10000, maxOutputBytes: 10000, timeoutMs: 1000 };
  const plan = { unitId: 'unit', createdAt: new Date().toISOString(), items: [] }, files = { 'candidate.tsx': '' };
  const manifest = { unitId: 'unit', generatedAt: new Date().toISOString(), transformer: { kind: 'LLM', name: 'test' }, mappings: [] };
  for (const content of ['const e = eval; e("code")', '(0, eval)("code")', 'globalThis["eval"]("code")', '({}).constructor("code")', 'setTimeout("code", 0)', 'process.dlopen(module, "x")']) {
    const worker = new BoundedWorker({ complete: async () => ({ patches: [{ path: 'candidate.tsx', beforeHash: fileHash(''), content }], manifest }) }, policy);
    await assert.rejects(worker.transform({ plan, files }), /execution|forbidden/);
  }
});
test('mining rejects runIndex-only replays and includes observational state candidates', () => {
  const replay = [1, 2, 3].map(runIndex => ({ ...trace(), runIndex }));
  assert.throws(() => InvariantMiner.mineHttpRuntimeEvidence(replay), /execution identities/);
  const runs = replay.map((t, i) => event(event(event({ ...t, runId: `run-${i}` }, 'NAVIGATION', { fromUrl: 'about:blank', toUrl: 'https://app.test/customers' }), 'ARIA_STATE_CHANGE', { triggerEventId: 'scenario_completed', rawYamlTree: '', jsonTree: { role: 'alert', name: 'Done' } }), 'STORAGE_DELTA', { storageType: 'localStorage', mutationType: 'SET', key: 'saved', previousValue: null, newValue: 'yes' }));
  const draft = synthesizeContract('unit', runs);
  const invariants = draft.scenarios[0].invariants;
  assert.equal(invariants.navigation[0].enforcement, 'WARNING'); assert.equal(invariants.accessibilityAriaJson.enforcement, 'WARNING'); assert.equal(invariants.storageDeltas[0].enforcement, 'WARNING');
});
test('raw retention rejects symlinks and deterministic scenario failures do not claim nondeterminism', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-review-'));
  try {
    const store = new ArtifactStore(root, join(root, 'private'), await storeOptions());
    if (await canCreateSymlink()) {
      const path = await store.privatePath('raw/nested'); await symlink(tmpdir(), path);
      await assert.rejects(store.purgeRaw(0), /Symlink/);
    } else {
      t.diagnostic('symlink unavailable; purgeRaw symlink refusal skipped');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.equal(classifyFailure({ divergences: [{ severity: 'BLOCKING', dimension: 'CONTRACT', code: 'SCENARIO_FAILED' }] }), 'UNKNOWN');
  const failed = await runRepairLoop({ source: trace(), contract: contract(), maxRepairAttempts: 2, captureTarget: async () => { throw new Error('Deterministic missing button'); }, repair: async () => { throw new Error('Should not repair'); } });
  assert.equal(failed.result.status, 'NOT_EQUIVALENT'); assert.equal(failed.attempts, 0); assert.equal(failed.disposition, 'UNKNOWN');
});
test('mock fixture resolution rejects paths inside the private artifact store', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-fixture-'));
  try {
    await mkdir(join(root, '.migration-private')); await writeFile(join(root, '.migration-private', 'secret.json'), '{}');
    await writeFile(join(root, 'allowed.json'), '{}');
    await assert.rejects(resolveMockFixture(root, '.migration-private/secret.json'), /escapes the allowed fixture directory/);
    if (await canCreateSymlink()) {
      await symlink(join(root, '.migration-private'), join(root, 'link'));
      await assert.rejects(resolveMockFixture(root, 'link/secret.json'), /escapes the allowed fixture directory/);
    } else {
      t.diagnostic('symlink unavailable; link escape case skipped');
    }
    assert.equal(await resolveMockFixture(root, 'allowed.json'), await realpath(join(root, 'allowed.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
