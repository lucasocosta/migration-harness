import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareMigration } from '../packages/engine/dist/migration-operations.js';
import { ArtifactStore } from '../packages/engine/dist/artifacts.js';
import { preflightBrowser } from '../packages/engine/dist/scenario-runner/index.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

// Regression coverage for the two re-prepare crashes found by the Session D pilot:
// a second prepare over the same artifact identity crashed on the pseudonymization key
// (EEXIST), and a prepare over a non-empty artifact directory crashed on mkdir (EEXIST).
const cleanPrivate = (t, root, dir) => t.after(() => rm(new ArtifactStore(join(root, dir)).privateRoot, { recursive: true, force: true }));

// Both tests assert on a real PASS preparation, and preflight probes Chromium before the
// preparation exists (measured 2026-10-03: `BROWSER_UNAVAILABLE` is the only divergence on a
// host without a browser). The gate host has Chromium; this skip keeps the file usable there too.
let chromiumIssue;
try { await preflightBrowser(); } catch (error) { chromiumIssue = error?.message ?? String(error); }
const withoutChromium = t => {
  if (!chromiumIssue) return false;
  t.skip(`Chromium unavailable: ${chromiumIssue}`);
  return true;
};

async function fixture(t) {
  const { root, config } = await buildWorkspace();
  config.profile = 'standard'; config.limits = { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 600000 };
  const script = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Retry fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>{document.querySelector("output").textContent="Saved";localStorage.setItem("ready","yes");};');`;
  for (const side of ['source', 'target']) await write(root, `${side}/build.mjs`, script);
  config.scenarios[0].definition.steps = [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save',
    completionSignal: { type: 'STORAGE_KEY_SET', storageType: 'localStorage', storageKey: 'ready', timeoutMs: 2500 } }];
  t.after(() => rm(root, { recursive: true, force: true }));
  cleanPrivate(t, root, 'artifacts/prepared');
  return { root, config };
}

test('re-preparing over the same artifact identity reuses the pseudonymization key', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await fixture(t);
  const input = { config, workspaceRoot: root, artifactPath: 'artifacts/prepared', allowProjectCommands: true };
  const first = await prepareMigration(input);
  assert.equal(first.kind, 'MIGRATION_PREPARATION'); assert.equal(first.status, 'PASS');
  // The natural retry: public artifacts discarded, private state kept.
  await rm(join(root, 'artifacts/prepared'), { recursive: true, force: true });
  const second = await prepareMigration(input);
  assert.equal(second.kind, 'MIGRATION_PREPARATION'); assert.equal(second.status, 'PASS');
  assert.equal(second.keyId, first.keyId, 'the shared pseudonymization key survives a re-prepare');
  assert.deepEqual(second.reference.criteria, first.reference.criteria,
    'an unchanged workspace re-prepares to the same semantic criteria');
});

test('prepare refuses a non-empty artifact directory with a stable code', async t => {
  if (withoutChromium(t)) return;
  const { root, config } = await fixture(t);
  const input = { config, workspaceRoot: root, artifactPath: 'artifacts/prepared', allowProjectCommands: true };
  const first = await prepareMigration(input);
  assert.equal(first.status, 'PASS');
  await assert.rejects(prepareMigration(input),
    error => error instanceof Error && error.message === 'ARTIFACT_NOT_FRESH');
});
