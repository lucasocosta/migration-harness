import type { MinimumCoveragePolicy } from '@migration-harness/core';
export const MVP_MINIMUM_COVERAGE_POLICY: MinimumCoveragePolicy = {
  unitRoutesPercent: 100,
  networkMutationsPercent: 100,
  primaryScenariosPercent: 100,
  knownErrorStatesCount: 1,
  scenarioControlsPercent: 100,
};
