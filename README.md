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

The CLI surface is v2 — `init`, `doctor`, `prepare`, `verify`, `status`, `reference`
(owner decision 2026-10-03, [PLAN-V2](docs/PLAN-V2.md) §8.2). The former 26-command
surface and the restricted profile were retired with it. Profile rules, including
which CLI flags do not exist, live in [AGENTS.md](AGENTS.md); how to drive the cycle
lives in [the operator guide](docs/OPERATOR.md).

## What exists

- `init` / `doctor`: schema-valid configuration plus the decisions only the owner can
  make, then an environment preflight (exit 0 is never a migration approval).
- `prepare` / `verify`: versioned fixed reference and resumable session in one
  operation; then the complete declared suite, native checks and one consolidated
  report, one attempt per run.
- `status` / `reference`: attempts, budgets, scope findings and the next action
  without spending an attempt; versioned reference updates whose weakening needs an
  owner decision.
- One JSON envelope per `--json` run: `operationStatus` × `outcome` × `decision` with
  immutable exit codes 0/1/3/4/5 and `nextActions` that name who must authorize them.
- Playwright scenario execution, trace recording, sanitization and private artifacts.
- Network shapes/status/params, navigation, storage, ARIA and declared-causality comparison.
- Project-check orchestration (authorized argv, managed builds and servers, bounded
  execution) as an engine capability; a project PASS is not a migration verdict.
- Privacy controls: pseudonymization, sanitized public evidence and explicit
  degraded-mode disclosures.

Selected payload values and required semantic assertions block incorrect standard
candidates. Repairs are ordinary scoped edits made by the assistant between two
`verify` runs; no harness command edits the candidate.

Cinema has a recorded PASS (36 scenarios, 131 requirements); component-first
exercises two dependent units (5 scenarios, 11 requirements). These are synthetic
applications; the Cinema-specific three-regression acceptance item remains open.
A pilot passing does not certify a user migration. See the
[archived Cinema evidence](docs/archive/CINEMA-EVIDENCE.md) and [current status](docs/STATUS.md).

## Start here

- [AGENTS.md](AGENTS.md): trust/safety limits and the protocol an AI assistant must follow here.
- [Operator guide](docs/OPERATOR.md): install → doctor → prepare → edit → verify → status/reference, the envelope, budgets and privacy.
- [RFC v0.3](docs/RFC.md): the specification this repository targets.

## Development

```bash
npx --yes pnpm@10.15.0 install --frozen-lockfile
npx --yes pnpm@10.15.0 exec playwright install chromium
npx --yes pnpm@10.15.0 build
node --test tests/*.test.mjs
node --test tests/browser/*.test.mjs
```

Tests import built `dist/`. Private traces are never assistant inputs; on WSL they
stay on the native Linux filesystem. Docker execution remains unverified in this
environment.

Clones under `apps/angular` and `apps/react` keep their own Git histories.
`apps/`, `migrations/` and `artifacts/` are ignored by this repository: arrange
approved versioning of migration specifications separately. Never commit secrets.

## Reproducibility and distribution

Use Node `^20.19.0`, `^22.12.0` or `>=24.0.0`; CI uses Node 22. Angular 20.3.31
is pinned for the framework fixtures and compiler helpers. The package version in
`package.json` (currently 0.2.x) tracks the code line, while **RFC v0.3** is the
target specification — they are different number series, not a version mismatch.
`pnpm test` and
`pnpm test:browser` build first and run serially. GitHub Actions also exercises
both executable examples, the smokes, dependency advisories
and links against the files actually tracked by Git.

The repository is MIT-licensed; see [LICENSE](LICENSE). The packages are not
published to npm. Local assistant settings in `.codex/` and `.serena/` are ignored.
