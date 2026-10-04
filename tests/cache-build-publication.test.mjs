/**
 * Atomic publication of the immutable build cache (docs/PLAN-V2.md §4.3): two producers racing on
 * the same key leave exactly one complete entry, and a corrupted or incomplete entry is a miss —
 * never a success that serves unattested bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical } from '../packages/core/dist/index.js';
import {
  assessBuildCache, buildCacheRoot, probeBuildCache, publishBuildCacheSide, restoreBuildCache,
} from '../packages/engine/dist/build-cache.js';
import { withProjectBuildServers } from '../packages/engine/dist/build-servers.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const exists = async path => { try { await access(path); return true; } catch { return false; } };

const BUILD_SCRIPT = `import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/build.log', 'run\\n');
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;
const LINT_SCRIPT = `import { mkdirSync, appendFileSync } from 'node:fs';
mkdirSync('../markers', { recursive: true });
appendFileSync('../markers/lint.log', 'run\\n');`;

async function fixture(t) {
  const { root, config } = await buildWorkspace();
  // The build cache is opt-in (default off); these cases exercise publication with it enabled.
  process.env.MIGRATION_HARNESS_BUILD_CACHE = '1';
  t.after(() => { delete process.env.MIGRATION_HARNESS_BUILD_CACHE; });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const side of ['source', 'target']) {
    await write(root, `${side}/build.mjs`, BUILD_SCRIPT);
    await write(root, `${side}/lint.mjs`, LINT_SCRIPT);
    config[side].commands.push({ id: 'lint', kind: 'lint', argv: [process.execPath, 'lint.mjs'], cwd: '.', timeoutMs: 3000 });
    config.checks.push({ id: `lint-${side}`, side, commandId: 'lint', required: true });
  }
  const lines = async name => (await readFile(join(root, 'markers', name), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  return {
    root, config, lines,
    assess: side => assessBuildCache({ config, workspaceRoot: root, side }),
    entry: async side => {
      const assessment = await assessBuildCache({ config, workspaceRoot: root, side });
      assert.equal(assessment.cacheable, true, `${side} must be cacheable for this case`);
      return join(buildCacheRoot(root), assessment.identity.key);
    },
    cycle: use => withProjectBuildServers({ config, workspaceRoot: root, allowProjectCommands: true }, use ?? (async () => 'completed')),
  };
}

/** Snapshot-shaped output: file bytes, the fingerprints of those bytes and their aggregate hash. */
const snapshot = entries => {
  const files = new Map(entries);
  const fingerprints = [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length }));
  return { files, buildHash: digest(fingerprints), totalBytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) };
};

test('two simultaneous producers publish one complete entry, never a half-written one', async t => {
  const f = await fixture(t);
  const assessment = await f.assess('source');
  assert.equal(assessment.cacheable, true);
  assert.equal((await f.assess('source')).identity.key, assessment.identity.key, 'the identity is stable before any build');
  const recorded = { at: new Date().toISOString(), durationMs: 11, exitCode: 0, stdoutBytes: 0, stderrBytes: 0 };

  // Same identity, different bytes: whichever producer wins, the entry must be wholly theirs.
  const producers = ['A', 'B'].map(marker => snapshot([
    ['index.html', Buffer.from(`<html>${marker}</html>`)],
    ['app.js', Buffer.from(`// ${marker}`)],
    ['nested/asset.txt', Buffer.from(`asset-${marker}`)],
    ...Array.from({ length: 24 }, (_, index) => [`chunk-${index}.js`, Buffer.from(`${marker}-${index}`)]),
  ]));
  const results = await Promise.all(producers.map(output => publishBuildCacheSide({
    config: f.config, workspaceRoot: f.root, side: 'source', identity: assessment.identity, output, recorded,
  })));
  for (const result of results) assert.ok(['PUBLISHED', 'REUSED'].includes(result.status), JSON.stringify(result));
  assert.equal(results.filter(result => result.status === 'PUBLISHED').length >= 1, true);

  const entry = join(buildCacheRoot(f.root), assessment.identity.key);
  const manifest = JSON.parse(await readFile(join(entry, 'manifest.json'), 'utf8'));
  assert.equal(manifest.key, assessment.identity.key);
  assert.equal(manifest.protocol, assessment.identity.document.protocol);
  assert.equal(digest(manifest.output.files), manifest.output.buildHash, 'the manifest attests its own file list');
  const markers = new Set();
  for (const file of manifest.output.files) {
    const bytes = await readFile(join(entry, 'files', ...file.path.split('/')));
    assert.equal(sha256(bytes), file.sha256, `${file.path} matches its recorded hash`);
    assert.equal(bytes.length, file.bytes);
    const text = bytes.toString('utf8');
    const found = /(?:>|\/\/ |asset-)([AB])(?:<|\b|-)/.exec(text)?.[1];
    if (found) markers.add(found);
  }
  assert.equal(markers.size, 1, 'the surviving entry never mixes two producers');
  assert.deepEqual((await readdir(buildCacheRoot(f.root))).filter(name => name.startsWith('tmp-')), [],
    'no temporary directory survives a publication');

  // Publishing the same key again reuses the complete entry instead of rewriting it.
  const again = await publishBuildCacheSide({ config: f.config, workspaceRoot: f.root, side: 'source',
    identity: assessment.identity, output: snapshot([['index.html', Buffer.from('<html>Z</html>')]]), recorded });
  assert.equal(again.status, 'REUSED');
  const restored = join(f.root, 'source', 'restored-probe');
  await restoreBuildCache({ entry, manifest }, restored);
  const winner = markers.values().next().value;
  assert.match(await readFile(join(restored, 'index.html'), 'utf8'), new RegExp(`>${winner}<`));
  await rm(restored, { recursive: true, force: true });
  assert.equal((await probeBuildCache(assessment.identity, f.root)).status, 'HIT');
});

test('a tampered output byte is a miss that rebuilds, never a success', async t => {
  const f = await fixture(t);
  await f.cycle();
  const entry = await f.entry('source');
  await writeFile(join(entry, 'files', 'index.html'), '<html>tampered</html>');

  let served = '';
  const rebuilt = await f.cycle(async ({ source }) => { served = await (await fetch(source.origin)).text(); });
  assert.equal(rebuilt.cache.source.status, 'MISS', 'the corrupt entry never produces a hit');
  assert.equal(rebuilt.cache.source.reason, 'RESTORE_FAILED');
  assert.equal(rebuilt.cache.source.publish, 'PUBLISHED', 'the broken entry is replaced');
  assert.equal(rebuilt.checks.status, 'PASS');
  assert.match(served, /<button>Save<\/button>/, 'the rebuilt bytes are what gets served');
  assert.doesNotMatch(served, /tampered/, 'a corrupted byte is never served');
  assert.equal(await f.lines('build.log'), 3, 'the build really ran again');
  const healed = await f.cycle();
  assert.equal(healed.cache.source.status, 'HIT', 'the replacement entry is usable');
  assert.equal(await f.lines('build.log'), 3, 'the healed entry does not build again');
});

test('a corrupted manifest and a missing stored file are misses', async t => {
  const f = await fixture(t);
  await f.cycle();

  // the manifest no longer parses
  await writeFile(join(await f.entry('target'), 'manifest.json'), '{ not json');
  const brokenManifest = await f.cycle();
  assert.equal(brokenManifest.cache.target.status, 'MISS');
  assert.equal(brokenManifest.cache.target.reason, 'MANIFEST_CORRUPTED');
  assert.equal(brokenManifest.checks.status, 'PASS', 'behavior without a usable cache is unchanged');

  // the manifest's own output hash no longer matches its file list
  const targetEntry = await f.entry('target');
  const tampered = JSON.parse(await readFile(join(targetEntry, 'manifest.json'), 'utf8'));
  tampered.output.buildHash = '0'.repeat(64);
  await writeFile(join(targetEntry, 'manifest.json'), JSON.stringify(tampered));
  const brokenHash = await f.cycle();
  assert.equal(brokenHash.cache.target.status, 'MISS');
  assert.equal(brokenHash.cache.target.reason, 'MANIFEST_CORRUPTED');
  assert.equal(brokenHash.checks.status, 'PASS');

  // a file the manifest promises but the entry does not hold
  const sourceEntry = await f.entry('source');
  await rm(join(sourceEntry, 'files', 'app.js'), { force: true });
  const missing = await f.cycle();
  assert.equal(missing.cache.source.status, 'MISS');
  assert.equal(missing.cache.source.reason, 'RESTORE_FAILED');
  assert.equal(missing.checks.status, 'PASS', 'an incomplete entry never serves as success');
  assert.equal((await f.cycle()).cache.source.status, 'HIT', 'the entry is repaired by the rebuild');
});

test('probing an absent key is a miss with no side effects on behavior', async t => {
  const f = await fixture(t);
  const assessment = await f.assess('source');
  assert.equal(assessment.cacheable, true);
  const miss = await probeBuildCache(assessment.identity, f.root);
  assert.equal(miss.status, 'MISS');
  assert.equal(miss.reason, 'ABSENT');
  assert.equal(await exists(join(buildCacheRoot(f.root), assessment.identity.key)), false);
  const first = await f.cycle();
  assert.equal(first.checks.status, 'PASS');
  assert.equal(first.cache.source.publish, 'PUBLISHED');
});
