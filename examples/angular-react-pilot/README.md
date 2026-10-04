# Real Angular/React pilot

This is an implemented v0.2 synthetic integration fixture retained for regression.
It is not the RFC v0.3 standard end-to-end assistant workflow. See
[the implementation plan](../../docs/PLAN.md) for that acceptance milestone.

> **Retired runner:** the `pnpm pilot` package script (`scripts/pilot.mjs`) that drove this
> fixture was removed with the restricted transformation pipeline (owner decision,
> [PLAN-V2](../../docs/PLAN-V2.md) §8.2). The paragraphs below describe what that runner did;
> nothing in the repository executes the fixture anymore — the Angular source, scenario and
> policy are kept as reference material only.

The fixture boots real Angular 20 in Chromium, transforms a supported standalone component to React with the codemod, and executes the same scenario using the TypeScript ScenarioRunner. Angular's async code is compiled for ES2016 so Zone.js can track Promise continuations.

The pilot records three source runs, synthesizes a draft, simulates approval of synthetic invariants, validates equivalent React, injects PUT -> POST, classifies the divergence, runs a bounded deterministic repair provider, rebuilds React and verifies equivalence again. It asserts that the entire approved contract remains byte-for-byte unchanged and verifies the hash-chained audit. Generated React is independently typechecked.

Each execution prints its public and private artifact directories. Raw traces stay under `~/.local/state/migration-harness/<artifact-root-hash>/raw` with verified private permissions; sanitized traces, comparisons, contract fixtures, plan, manifest, patches, gates and audit are available under the public artifact root.

The synthetic reviewer is deliberately named `synthetic-pilot-reviewer`. No actual human or production approval is implied. The provider is deterministic, not an external LLM, and the source component is within the codemod's documented subset.

## Assistant protocol pilot (retired)

The assistant-protocol variant of this fixture — a package script driving the
now-removed command surface — was retired together with the restricted profile
(owner decision, [PLAN-V2](../../docs/PLAN-V2.md) §8.2); its instructions are gone
from this README on purpose. The fixture ships no `migration.json`, so there is no
session to open against it.

To drive a real migration, use the six-command cycle
`doctor → prepare → edit the candidate → verify → status/reference` with the JSON
envelope, as documented in [OPERATOR.md](../../docs/OPERATOR.md); the executable
template is [examples/validation-first](../validation-first/README.md), which runs
from the repository root after `corepack pnpm build`. The fixture
described above is unchanged; only its `pnpm pilot` runner left with the kill switch.
