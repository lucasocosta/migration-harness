# Validation record

## RFC pilot and review corrections - 2026-09-05

Executed in the shared WSL workspace with Node 20.20.1, TypeScript 5.9.3, pnpm 10.15.0 and pinned Playwright 1.63.0. Dependencies and Chromium were installed successfully; the earlier offline limitation below is historical.

| Check | Result |
| --- | --- |
| Strict workspace build, all 15 projects | PASS |
| Unit, CLI, review regression, discovery, importer, HTTP provider and lint tests | 28/28 PASS |
| Chromium browser tests, including real Angular/React, recorder, mock boundaries and axe | 5/5 PASS |
| Original and v0.2 smoke scripts | PASS |
| Real Angular -> generated React pilot with lint/typecheck, regression and repair | PASS |
| `git diff --check` | PASS |

Latest pilot evidence: `artifacts/pilot-Th11LX/`. The run recorded three source executions, detected `NETWORK_METHOD_MISMATCH` after PUT -> POST, applied exactly one bounded repair, obtained EQUIVALENT, verified the unchanged approved fixture contract, and verified its audit chain. Approval and provider are explicitly synthetic test fixtures; no production contract was approved and no real model reasoning was exercised.

Private raw files are in `/home/lucas/.local/state/migration-harness/31e5a2e610e984de3563d19e/raw`. The store enforces 0700 directories and 0600 files. `/mnt/c` was observed to expose 0777 despite requested modes, so private artifacts were moved to the native Linux filesystem. Permission, symlink and retention tests run against native temporary directories.

Coverage includes portable hashes, the actual FSM approval bypass, default-deny payload fields, Unicode/prototype keys, malformed encoded URLs, ARIA URL secrets, mock filesystem/origin boundaries, path/response/storage volatility, replayed execution identities, causal comparison, static-code scan bypass patterns, and worker HTTP error/redirect/size/deadline behavior.

The recorder handles Chromium's bodyless-response ERR_ABORTED case only when an actual 204/304/HEAD response exists. A related upstream behavior is documented in [Playwright issue 26897](https://github.com/microsoft/playwright/issues/26897). Transport errors without a completed bodyless response remain failures.

Not verified here: DockerSandbox execution (Docker is unavailable in this WSL), external model inference, and general framework behavior beyond the documented adapters. See `IMPLEMENTATION-STATUS.md`, `REVIEW-RESOLUTION.md` and `PROGRESS.md` for remaining scope. Automated axe results do not replace human accessibility evaluation.

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
