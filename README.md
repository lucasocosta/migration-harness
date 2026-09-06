# Migration Harness

Evidence-Guided Translation Validation for behavior-preserving software migration.

The first adapter targets **Angular → React**, but the core architecture is framework-agnostic.

## Core idea

The harness does not trust a transformation because it generated compilable code. It executes equivalent scenarios against source and target implementations and independently evaluates behavioral equivalence.

```text
Angular ──execute──► SourceTrace
   │
   ▼
Transformation ───► TransformationManifest
   │
   ▼
React ───execute──► TargetTrace

SourceTrace + TargetTrace + Critical Contract + Manifest hints
                           │
                           ▼
                  EquivalenceValidator
```

The `TransformationManifest` is evidence/hints only. It cannot make a failing candidate pass.

## Implemented

- strict runtime schemas for scenarios, traces, contracts, units, plans, manifests, results and CLI policy;
- deterministic v0.2 state machine;
- `ScenarioRunner` separated from trace observation;
- hardened Playwright trace recorder with navigation events, async request draining, configurable request filtering and response-body caps;
- network, navigation, storage, ARIA, critical contract and declared causal-graph comparison;
- method, path parameters, query, complete payload shapes, response shapes, transport failures and status comparison;
- volatile query parameter support;
- contract review/approval, recursive integrity hashing and independent critical gates;
- trace sanitization, keyed pseudonyms, a structural-only LLM projection, private raw artifacts and retention;
- TypeScript/Angular discovery with routes, guards/resolvers, DI and template dependencies, transformation planning and a conservative standalone-component codemod;
- bounded patch workers, package/file allowlists, deadline enforcement and a Docker execution adapter;
- assistant-driven `brief` / `apply-patch` / `run` workflow with issued boundaries, protected-input hashes, content screens and audited application;
- OpenAPI/structured-test evidence import, multi-dimension observational synthesis, failure classification, bounded repair, TypeScript/ESLint/axe checks, coverage, eligibility and audit;
- working CLI commands and an executable real Angular/React regression-and-repair pilot.

## Scope And Limits

The pilot covers a deliberately small Angular component. Decorated IO and a synchronous reactive-forms subset, including normalized builder groups, are supported. Arbitrary Angular applications, complex DI lifetimes, dynamic forms and asynchronous stream orchestration still require semantic adapters or review. Discovery reports unresolved dependencies instead of inventing mappings. Causal comparison checks declared edges; automatic browser-wide causal inference is not implemented.

The primary semantic worker is a human-driven coding assistant consuming harness-issued briefs, with no model API integration required. An HTTP provider remains an optional library adapter. Same-user reads outside the CLI are policy-controlled, not technically isolated. The assistant protocol pilot uses deterministic submissions; a recorded real assistant session remains pending. Container execution requires Docker and a locally available digest-pinned image; it was not verified in this WSL environment.

See [status](docs/STATUS.md) for the complete scope, verification snapshot and remaining work.

The [review record](docs/REVIEWS.md) documents accepted and rejected review findings, including two deliberate design rejections.

For migrations into an existing React repository, use the Portuguese
[Copilot manual](docs/COPILOT-MIGRATION.md) and [migration specification template](docs/templates/MIGRATION-SPEC.md).

## First milestone

Before automatic migration, prove differential equivalence:

```text
Angular PUT /api/customers/:id
React   PUT /api/customers/:id
→ EQUIVALENT

Intentional React regression: PUT → POST
→ NOT_EQUIVALENT / NETWORK_METHOD_MISMATCH
```

This behavior is covered by `scripts/smoke-v02.mjs`.

## Commands

After dependencies are installed:

```bash
pnpm build
pnpm smoke:v02
pnpm test
pnpm test:browser
pnpm pilot
pnpm pilot:assistant
```

Compare two sanitized traces:

```bash
harness compare \
  --source source.sanitized.json \
  --target target.sanitized.json \
  --out equivalence.json
```

## Read before continuing implementation

- `docs/research.md` — consolidated research, decisions and invariants (historical record).
- `docs/ARCHITECTURE.md` — current architecture summary.
- `docs/STATUS.md` — delivered scope, limits, verification snapshot, remaining work and continuation notes.
- `docs/VALIDATION.md` — validations already executed and environment limitations.
- `docs/ASSISTANT-INTEGRATION.md` and root `AGENTS.md` — assistant protocol and read/write scope.

## Reproducible browser vertical slice

Run:

```bash
pnpm exec playwright install chromium
pnpm pilot
```

This executes the TypeScript runner against real Angular and generated React in Chromium. It captures three source runs, creates a synthetic fixture contract, detects a `PUT → POST` regression, repairs one candidate file and revalidates the unchanged contract. Each run writes an audit and evidence directory under `artifacts/pilot-*`.

The pilot simulates human approval for synthetic fixture data only. It does not approve any user contract. See [CLI usage](docs/USAGE.md), [pilot](examples/angular-react-pilot/README.md), and [validation](docs/VALIDATION.md). The older Python fixture is retained as historical material.
