/**
 * `DockerSandbox` was removed as dead code (PLAN-V2 §2.2/§8.3): it had zero production call-sites —
 * generated commands never executed through this module after the restricted workflow was retired.
 * The module is intentionally empty so the worker barrel (`./llm-worker/index.js`) keeps compiling
 * without pulling a dead dependency; nothing is exported here.
 */
export {};
