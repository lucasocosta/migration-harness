export * from './platform-paths.js';
export * from './process-tree.js';
export * from './artifacts.js';
export * from './sealing.js';
export * from './repair-loop.js';
export * from './migration-reference.js';
export * from './project-checks.js';
export * from './build-cache.js';
export * from './build-servers.js';
export * from './capture-suite.js';
export * from './state-capture.js';
export * from './timings.js';
export * from './migration-operations.js';
export * from './migration-scope.js';
export * from './migration-session.js';
export * from './quality-gates/index.js';
export * from './equivalence/index.js';
// Browser-stack modules (scenario-runner, trace-recorder) are intentionally NOT re-exported
// here: they import @playwright/test at module top level, and the entrypoint must stay free
// of Playwright for non-browser operations (tests/project-reset.test.mjs). Consumers import
// the subpaths directly (e.g. engine/dist/scenario-runner/index.js); internal engine code
// reaches them through dynamic import() for the same reason.
