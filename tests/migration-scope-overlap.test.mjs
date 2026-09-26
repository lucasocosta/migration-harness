import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStandardScope } from '../packages/engine/dist/migration-scope.js';

const config = (writePaths, fixtureRoot) => ({
  profile: 'standard',
  migrationId: 'a'.repeat(32),
  source: { root: 'apps/angular', commands: [] },
  target: { root: 'apps/react', commands: [], writePaths },
  scenarios: [{ fixtureRoot }],
  requirements: [],
  checks: [],
  limits: { maxDurationMs: 1000, sourceRuns: 1 },
});

test('write path that contains an evaluation fixture is refused', () => {
  // writePath covers a directory that holds the fixture (item ⊆ full).
  assert.throws(
    () => validateStandardScope(config(['src'], 'apps/react/src/fixtures')),
    /EVALUATION_INPUT_IN_WRITE_SCOPE/,
  );
});

test('write path nested inside an evaluation fixture is refused', () => {
  // full ⊆ item.
  assert.throws(
    () => validateStandardScope(config(['src/fixtures/button'], 'apps/react/src/fixtures')),
    /EVALUATION_INPUT_IN_WRITE_SCOPE/,
  );
});

test('disjoint write path and fixture are accepted', () => {
  assert.doesNotThrow(() => validateStandardScope(config(['src/button.tsx'], 'apps/react/e2e/fixtures')));
});
