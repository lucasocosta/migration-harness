# Validation record

## v0.2 — 2026-08-29

Executed in the artifact-generation environment with Node.js 22.16.0 and TypeScript 5.8.3.

### Passed

- Strict TypeScript build for:
  - `@migration-harness/core`
  - `@migration-harness/equivalence-validator`
  - `@migration-harness/engine`
- `scripts/smoke-v02.mjs`:
  - PUT source vs PUT target → `EQUIVALENT`
  - PUT source vs POST target → `NOT_EQUIVALENT`
  - first divergence → `NETWORK_METHOD_MISMATCH`
  - FSM repair transition → `REPAIR_PATCH → EQUIVALENCE_VERIFY → PR_READY`

### Not fully typechecked in this environment

`scenario-runner` and `trace-recorder` depend on Playwright. The generation environment does not contain the project Playwright dependency tree, so their full package typecheck was not claimed here.

The project pins Playwright `^1.63.0` because the implementation uses current ARIA snapshot JSON APIs. Run the full validation after installing workspace dependencies:

```bash
pnpm install
pnpm build
pnpm smoke:v02
```

### Remaining validation work

- browser-backed ScenarioRunner integration test;
- response body cap/content-type tests;
- navigation event test;
- sanitizer adversarial tests;
- volatile query normalization tests;
- navigation/storage/ARIA comparator tests;
- causal ordering tests.

## Browser E2E vertical slice — v0.2.1

A reproducible browser fixture now validates the differential-execution core using real Chromium execution.

Command:

```bash
bash scripts/e2e-fixture.sh
```

The fixture executes the same customer-profile scenario against three behavioral implementations:

1. source behavior: `PUT /api/customers/123`;
2. equivalent target: `PUT /api/customers/123`;
3. intentionally regressed target: `POST /api/customers/123`.

Observed results:

```text
source vs target            → EQUIVALENT
source vs target-regression → NOT_EQUIVALENT
                              NETWORK_METHOD_MISMATCH
                              source=PUT
                              target=POST
```

Browser evidence includes user interaction, HTTP request/response and ARIA snapshot events. The current `EquivalenceValidator` evaluates the NETWORK dimension; navigation/state/ARIA comparators remain subsequent milestones.

### Environment limitation

The execution environment cannot access npm, so the Node Playwright dependency cannot be installed here. The browser portion of this fixture therefore uses the locally installed Python Playwright binding with `/usr/bin/chromium`; the resulting trace schema is consumed by the real TypeScript `EquivalenceValidator`. This tests the browser→trace→validator vertical slice but does **not** yet prove the TypeScript `ScenarioRunner`/`TemporalTraceRecorder` integration.

The fixture pages intentionally model source/target observable behavior without bundling Angular or React runtimes, because those packages are also unavailable offline. A real Angular/React adapter test remains the next integration milestone.
