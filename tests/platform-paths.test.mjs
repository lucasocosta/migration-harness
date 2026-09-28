import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coversPosix, fromPosix, isWithin, isWithinPosix, pathSegments, privateBaseDir,
  samePath, toPosix, PRIVATE_STATE_FRAGMENT,
} from '../packages/core/dist/platform-paths.js';

test('pathSegments splits on both separators', () => {
  assert.deepEqual(pathSegments('a/b/c'), ['a', 'b', 'c']);
  assert.deepEqual(pathSegments('a\\b\\c'), ['a', 'b', 'c']);
  assert.deepEqual(pathSegments('/a//b/'), ['a', 'b']);
  assert.ok(pathSegments('ws/.migration-private/raw').includes('.migration-private'));
});

test('toPosix normalizes backslashes', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  assert.equal(toPosix('a/b/c'), 'a/b/c');
});

test('fromPosix keeps declared config form', () => {
  assert.equal(fromPosix('src/app.ts'), 'src/app.ts');
});

test('isWithin covers descendants and rejects parents', () => {
  const root = '/tmp/mig-root';
  assert.equal(isWithin(root, `${root}/child/file`), true);
  assert.equal(isWithin(root, root), false);
  assert.equal(isWithin(root, '/tmp/other'), false);
  assert.equal(isWithin(root, '/tmp/mig-root-evil/x'), false);
  // A child literally named `..evil` is inside the root, not outside it.
  assert.equal(isWithin(root, `${root}/..evil`), true);
  assert.equal(isWithin(root, `${root}/../escape`), false);
});

test('isWithinPosix and coversPosix use declared relative form', () => {
  assert.equal(isWithinPosix('src', 'src/app.ts'), true);
  assert.equal(isWithinPosix('src', 'src'), true);
  assert.equal(isWithinPosix('src', 'srcx/app.ts'), false);
  assert.equal(coversPosix('src', 'src'), true);
  assert.equal(coversPosix('src', 'src/app.ts'), true);
  assert.equal(coversPosix('src/app.ts', 'src'), false);
});

test('samePath compares resolved paths', () => {
  assert.equal(samePath('/tmp/a', '/tmp/a'), true);
  assert.equal(samePath('/tmp/a', '/tmp/b'), false);
});

test('privateBaseDir honors MIGRATION_HARNESS_STATE_DIR', async () => {
  const { resolve } = await import('node:path');
  const previous = process.env.MIGRATION_HARNESS_STATE_DIR;
  try {
    process.env.MIGRATION_HARNESS_STATE_DIR = '/custom/state';
    assert.equal(privateBaseDir(), resolve('/custom/state'));
    delete process.env.MIGRATION_HARNESS_STATE_DIR;
    assert.ok(privateBaseDir().includes(PRIVATE_STATE_FRAGMENT.split('/').pop()));
  } finally {
    if (previous === undefined) delete process.env.MIGRATION_HARNESS_STATE_DIR;
    else process.env.MIGRATION_HARNESS_STATE_DIR = previous;
  }
});
