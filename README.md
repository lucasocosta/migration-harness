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

**The standard workflow is implemented through P4 acceptance and exercised by
Cinema (P5) and component-first (P6).** Set `profile: "standard"` in the migration
configuration to use scoped normal edits and persistent sessions. Controlled
reference updates preserve history and budgets.
Existing restricted commands and hooks keep their semantics. There is no CLI
`--profile` flag. See the manual for current commands and limitations.

## What exists

- `prepare-migration` / `verify-migration`: managed builds, full declared suite, fixed reference and consolidated report.
- `start-migration-session` / `migration-session-status`: standard scoped edits, persistent attempts and repair decisions.
- `check-projects`: preflight and native checks with baseline reports and bounded execution; not a migration verdict.
- Playwright scenario execution, trace recording, sanitization and private artifacts.
- Network shapes/status/params, navigation, storage, ARIA and declared-causality comparison.
- Optional critical-contract validation and evidence import.
- Discovery, limited Angular codemods, project-check helpers and deterministic pilots.
- A restricted `brief / apply-patch / run` assistant workflow with scope/integrity checks.

Selected payload values and required semantic assertions now block incorrect
standard candidates. The restricted repair adapter remains method-only; standard
repairs use the assistant's coding abilities.

Cinema has a recorded PASS (36 scenarios, 131 requirements); component-first
exercises two dependent units (5 scenarios, 11 requirements). These are synthetic
applications; the Cinema-specific three-regression acceptance item remains open.
A pilot passing does not certify a user migration. See the
[public Cinema evidence](docs/CINEMA-EVIDENCE.md) and [current status](docs/STATUS.md).

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

## Reproducibility and distribution

Use Node `^20.19.0`, `^22.12.0` or `>=24.0.0`; CI uses Node 22. Angular 20.3.31
is pinned for the framework fixtures and compiler helpers. `pnpm test` and
`pnpm test:browser` build first and run serially. GitHub Actions also exercises
both executable examples, the smokes, restricted pilots, dependency advisories
and links against the files actually tracked by Git.

The packages are private and `UNLICENSED`; no open-source reuse license has been
selected. Local assistant settings in `.codex/` and `.serena/` are ignored.
