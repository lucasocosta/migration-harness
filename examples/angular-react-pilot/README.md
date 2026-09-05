# Real Angular/React pilot

Run `pnpm pilot` from the repository root after installing dependencies and Chromium.

The fixture boots real Angular 19 in Chromium, transforms a supported standalone component to React with the codemod, and executes the same scenario using the TypeScript ScenarioRunner. Angular's async code is compiled for ES2016 so Zone.js can track Promise continuations.

The pilot records three source runs, synthesizes a draft, simulates approval of synthetic invariants, validates equivalent React, injects PUT -> POST, classifies the divergence, runs a bounded deterministic repair provider, rebuilds React and verifies equivalence again. It asserts that the entire approved contract remains byte-for-byte unchanged and verifies the hash-chained audit. Generated React is independently typechecked.

Each execution prints its public and private artifact directories. Raw traces stay under `~/.local/state/migration-harness/<artifact-root-hash>/raw` with verified private permissions; sanitized traces, comparisons, contract fixtures, plan, manifest, patches, gates and audit are available under the public artifact root.

The synthetic reviewer is deliberately named `synthetic-pilot-reviewer`. No actual human or production approval is implied. The provider is deterministic, not an external LLM, and the source component is within the codemod's documented subset.
