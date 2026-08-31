# Migration Harness v0.2

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

## v0.2 implemented foundation

- core schemas for `TransformationPlan`, `TransformationManifest` and `EquivalenceResult`;
- deterministic v0.2 state machine;
- `ScenarioRunner` separated from trace observation;
- hardened Playwright trace recorder with navigation events, async request draining, configurable request filtering and response-body caps;
- initial network `EquivalenceValidator`;
- method, path, query, payload-shape and status comparison;
- volatile query parameter support;
- contract integrity and initial trace sanitization from v0.1;
- CLI `compare` command;
- executable PUT→POST regression smoke test.

## Not implemented yet

- production runtime schema validation;
- end-to-end browser CLI for `trace`;
- full navigation/storage/ARIA equivalence validators;
- causal DAG comparison;
- EvidenceFusionEngine;
- production-grade raw/sanitized artifact isolation;
- Angular static analyzer implementation;
- automatic codemods/LLM migration;
- bounded LLM repair sandbox.

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
```

Compare two sanitized traces:

```bash
harness compare \
  --source source.sanitized.json \
  --target target.sanitized.json \
  --out equivalence.json
```

## Read before continuing implementation

- `docs/research.md` — consolidated research, decisions, invariants and implementation handoff.
- `docs/ARCHITECTURE.md` — current architecture summary.
- `docs/MVP-PLAN.md` — recommended implementation sequence.
- `docs/VALIDATION.md` — validations already executed and environment limitations.

## Reproducible browser vertical slice

Run:

```bash
bash scripts/e2e-fixture.sh
```

This executes a real Chromium scenario, compares source and target traces, then injects a `PUT → POST` regression and verifies that the `EquivalenceValidator` blocks it with `NETWORK_METHOD_MISMATCH`.

See `examples/e2e-customer-profile/` and `docs/VALIDATION.md` for scope and environment limitations.
