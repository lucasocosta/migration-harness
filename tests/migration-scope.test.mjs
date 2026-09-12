import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMigrationConfig } from '../packages/core/dist/index.js';
import { snapshotMigrationScope, compareMigrationScope } from '../packages/engine/dist/migration-scope.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

async function fixture(t) {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  config.profile = 'standard';
  config.target.writePaths = ['page.tsx', 'page.css', 'assets', 'nested/Page.tsx'];
  const snapshot = () => snapshotMigrationScope({ config, workspaceRoot: root });
  return { root, config, snapshot };
}

test('scope uses current dirty bytes and permits scoped creation, edits, deletion, CSS and binary assets', async t => {
  const { root, config, snapshot } = await fixture(t);
  await write(root, 'target/user-work.txt', 'existing uncommitted work');
  await write(root, 'target/page.tsx', 'existing page');
  const baseline = await snapshot();
  await write(root, 'target/page.tsx', 'repaired page');
  await write(root, 'target/page.css', '.page {color: red}');
  await write(root, 'target/assets/logo.png', Buffer.from([0, 1, 2, 255]));
  await write(root, 'target/nested/Page.tsx', 'export default null');
  assert.deepEqual(compareMigrationScope(config, baseline, await snapshot()), []);
  await rm(join(root, 'target/page.tsx'));
  assert.deepEqual(compareMigrationScope(config, baseline, await snapshot()), []);
  await write(root, 'target/user-work.txt', 'overwritten');
  assert.deepEqual(compareMigrationScope(config, baseline, await snapshot()), [
    { side: 'target', path: 'user-work.txt', code: 'OUTSIDE_WRITE_SCOPE', change: 'MODIFIED' },
  ]);
});

test('source changes and offscope target additions/removals are refused', async t => {
  const { root, config, snapshot } = await fixture(t), baseline = await snapshot();
  await write(root, 'source/main.ts', 'changed');
  await write(root, 'source/new.ts', 'new');
  await rm(join(root, 'source/build.mjs'));
  await rm(join(root, 'target/main.ts'));
  await write(root, 'target/new.ts', 'new');
  const findings = compareMigrationScope(config, baseline, await snapshot());
  assert.equal(findings.length, 5);
  assert.deepEqual(findings.filter(item => item.side === 'source').map(item => item.code), Array(3).fill('SOURCE_CHANGED'));
  assert.ok(findings.some(item => item.path === 'main.ts' && item.side === 'target' && item.change === 'REMOVED'));
});

test('generated outputs and dependencies are excluded, but cannot conceal declared inputs', async t => {
  const { root, config, snapshot } = await fixture(t);
  config.source.generatedPaths = ['.angular'];
  const baseline = await snapshot();
  for (const path of ['source/.angular/cache', 'source/dist/index.html', 'target/dist/app.js', 'target/node_modules/x/index.js', 'target/.git/index']) await write(root, path, 'generated');
  assert.deepEqual(await snapshot(), baseline);
  for (const path of ['main.ts', 'src', 'public', 'node_modules', 'page.tsx', 'assets']) {
    assert.throws(() => parseMigrationConfig({ ...config, target: { ...config.target, generatedPaths: [path] } }));
  }
});

test('links in writable paths or their ancestors are refused without following them', async t => {
  const { root, config, snapshot } = await fixture(t);
  await symlink('/does-not-exist', join(root, 'target/unrelated-link'));
  const baseline = await snapshot();
  assert.deepEqual(compareMigrationScope(config, baseline, baseline), []);
  await symlink('/does-not-exist', join(root, 'target/assets'));
  await symlink('/does-not-exist', join(root, 'target/nested'));
  const current = await snapshot();
  assert.deepEqual(compareMigrationScope(config, baseline, current).map(item => item.code), ['LINK_NOT_ALLOWED', 'LINK_NOT_ALLOWED']);
  assert.equal(compareMigrationScope(config, current, current).length, 2);
});

test('private entries have opaque metadata, never names or contents, and changes are refused', async t => {
  const { root, config, snapshot } = await fixture(t);
  await write(root, 'target/.env', 'NOT_A_REAL_SECRET');
  const baseline = await snapshot();
  assert.ok(baseline.target.entries.some(item => item.kind === 'OPAQUE'));
  assert.ok(!JSON.stringify(baseline).includes('.env'));
  assert.ok(!JSON.stringify(baseline).includes('NOT_A_REAL_SECRET'));
  await write(root, 'target/.env', 'DIFFERENT_SYNTHETIC_CONTENT');
  assert.deepEqual(compareMigrationScope(config, baseline, await snapshot()), [
    { side: 'target', code: 'PRIVATE_ENTRY_CHANGED', change: 'MODIFIED' },
  ]);
});

test('hardlinks, oversized files, implicit profiles and private writable paths fail closed', async t => {
  const { root, config, snapshot } = await fixture(t);
  delete config.profile;
  await assert.rejects(snapshot(), /STANDARD_PROFILE_REQUIRED/);
  config.profile = 'standard';
  const paths = config.target.writePaths;
  config.target.writePaths = ['key.pem'];
  await assert.rejects(snapshot(), /UNSAFE_WRITE_SCOPE/);
  config.target.writePaths = paths;
  await link(join(root, 'target/main.ts'), join(root, 'target/hard.ts'));
  await assert.rejects(snapshot(), /SCOPE_HARD_LINK/);
  await rm(join(root, 'target/hard.ts'));
  await write(root, 'target/assets/large.bin', Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(snapshot(), /SCOPE_SIZE_LIMIT/);
});
