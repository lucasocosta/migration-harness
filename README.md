# Migration Harness

The assistant migrates; the harness verifies observable behavior.

Initial use cases: migrate an Angular page, component or application incrementally
into an **existing React application**, preserving its conventions and functionality.
The assistant uses its own coding capabilities. The harness does not need a model API.

## Product direction

```text
Prepare a stable source reference
  -> migrate into the existing target
  -> run project checks and compare scenarios
  -> fix regressions and repeat
  -> deliver evidence and coverage limits
```

The same assistant should run this end to end. Independent validation means protected
criteria and tool-issued results, not a different agent or a mandatory fresh session.

**This simplified standard workflow is planned, not delivered.** RFC v0.3 replaces
the previous mandatory brief-only direction. Existing commands and restricted
protocols still work as before; no new profile flag or consolidated verify command
is available yet.

## What exists

- `check-projects`: preflight and native checks with baseline reports and bounded execution; not a migration verdict.
- Playwright scenario execution, trace recording, sanitization and private artifacts.
- Network shapes/status/params, navigation, storage, ARIA and declared-causality comparison.
- Optional critical-contract validation and evidence import.
- Discovery, limited Angular codemods, project-check helpers and deterministic pilots.
- A restricted `brief / apply-patch / run` assistant workflow with scope/integrity checks.

Important gaps: payload values can differ while shapes pass; semantic repair is
mostly limited to HTTP-method mismatches; native project orchestration and a complete
migration report are missing. A pilot passing does not certify a user migration.
See [current status](docs/STATUS.md).

## Start here

- [RFC](docs/RFC.md): the agreed target and boundaries.
- [Implementation plan](docs/PLAN.md): ordered work, checklists and acceptance evidence.
- [Copilot manual](docs/COPILOT-MIGRATION.md) and [scope template](docs/templates/MIGRATION-SPEC.md).
- [CLI reference](docs/USAGE.md): commands that actually exist.
- [Architecture](docs/ARCHITECTURE.md), [assistant integration](docs/ASSISTANT-INTEGRATION.md)
  and [agent protocol](AGENTS.md).
- [Research](docs/research.md): retained foundations and limits.
- [Validation](docs/VALIDATION.md) and [review decisions](docs/REVIEWS.md): historical evidence.

## Development

```bash
npx --yes pnpm@10.15.0 install --frozen-lockfile
npx --yes pnpm@10.15.0 exec playwright install chromium
npx --yes pnpm@10.15.0 build
node --test tests/*.test.mjs
node --test tests/browser/*.test.mjs
node scripts/pilot.mjs
node scripts/pilot-assistant.mjs
```

Tests import built `dist/`. Pilots use real framework runtimes but synthetic data,
approval and deterministic transformations. Neither demonstrates the new standard
agent workflow. Private traces are never assistant inputs; on WSL they stay on the
native Linux filesystem. Docker execution remains unverified in this environment.

Clones under `apps/angular` and `apps/react` keep their own Git histories.
`apps/`, `migrations/` and `artifacts/` are ignored by this repository: arrange
approved versioning of migration specifications separately. Never commit secrets.
