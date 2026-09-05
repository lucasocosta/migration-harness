# Implementation checklist

Updated: 2026-09-05. This is the live task checklist. `[x]` means implemented; verification is tracked separately. See `HANDOFF.md` for continuation details and `REVIEW-RESOLUTION.md` for review decisions.

## Completed implementation

- [x] Read all original project docs, RFC v0.2, research and the subsequent `REVIEW.md`.
- [x] Runtime schemas for scenarios, traces, contracts, units, plans, manifests, results and policy.
- [x] Real Chromium ScenarioRunner with pre-boot conditions and pre-armed completion observers.
- [x] Recorder correlation, async draining, deadlines, body omission, navigation, ARIA and storage deltas.
- [x] Raw/sanitized separation, native Linux private storage, verified permissions and raw retention.
- [x] Deny-by-default payload/storage fields, PII pseudonyms, safe ARIA URLs and structural LLM projection.
- [x] Network, navigation, storage, ARIA, critical-contract and declared-causal-graph comparison.
- [x] Explicit query, path-parameter, request/response-field and storage-value volatility policies.
- [x] Distinct execution identities and observational synthesis for network/navigation/storage/ARIA.
- [x] Evidence fusion and bounded OpenAPI / existing-test-evidence importers.
- [x] Explicit contract REVIEW/APPROVED transition and portable recursive integrity hashes.
- [x] TypeScript/Angular discovery with route ownership, aliases, guards/resolvers, constructor injection, selectors and pipes.
- [x] Conservative transformation plan, Angular component codemod and manifest.
- [x] Bounded patch worker, HTTP provider protocol, file/package constraints and localized repair.
- [x] Failure classification, required-scenario failure results, bounded revalidation and audit chain.
- [x] Coverage/eligibility gates, TypeScript checker, trusted-config ESLint and axe adapters.
- [x] Working CLI discovery, trace, synthesis/review, transformation, comparison, repair and evidence-import commands.
- [x] Real Angular -> React pilot with intentional PUT -> POST regression and one bounded repair.
- [x] Remove unused placeholder API files; retain the old browser fixture explicitly as historical material.

## Review corrections

- [x] MF-1: reject approval directly from CONTRACT_SYNTHESIS; test the actual bypass.
- [x] MF-3: share locale-independent core canonicalization for contract/audit hashing.
- [x] MF-4 / SF-13: fixture realpath containment and origin checks inside mocks.
- [x] SF-1/2/3: default-deny fields, malformed encoded URL handling, ARIA URL cleanup.
- [x] SF-5/6: volatility policies and reject incompatible path/template rules.
- [x] SF-7/8: execution IDs and non-network observational synthesis.
- [x] SF-9/10/11: truthful FSM API, null success disposition, no invented nondeterminism.
- [x] SF-12/14/15: post-open path/inode checks, TS/TSX patch paths, explicit candidate root.
- [x] Common dynamic-evaluation aliases, unicode/prototype keys, retention symlinks and portable hash regression tests.
- [x] ARIA JSON/YAML from one capture; unique divergence IDs; configurable browser environment.
- [x] Finalize MF-2 documentation: static scanning is defense in depth; Docker is the execution boundary, never a proof supplied by the scanner.
- [x] Record the rejected SF-4 suggestion: same-page navigation order is meaningful; do not replace it with a multiset.

## Validated checkpoint

- [x] Finish the current strict build after ESLint/axe and discovery additions.
- [x] Run all unit/CLI tests against the latest implementation: 28/28 passed.
- [x] Run all browser tests, including the axe context fix: 5/5 passed.
- [x] Re-run pilot including lint/typecheck: equivalent after one repair; contract and audit verified.
- [x] Update README, USAGE, IMPLEMENTATION-STATUS and VALIDATION to match the new delivered scope.
- [x] Final lockfile/private-file check: frozen lockfile passed; raw files 0600, directories 0700.
- [x] Commit the validated checkpoint: `0af541e` (implementation, tests and documentation).

## Remaining broader scope / environment dependencies

- [ ] Execute DockerSandbox against a real local digest-pinned image. Docker is unavailable in this WSL environment.
- [ ] Exercise an external model service with actual credentials. The HTTP protocol is tested locally; model reasoning is not.
- [ ] General Angular reactive forms, complex provider lifetimes and stream orchestration transformations beyond the documented codemod subset.
- [ ] Dedicated WebSocket/service-worker scenario adapters and automatic application-wide causal instrumentation.
- [ ] OpenAPI composed/conditional schemas, external references and arbitrary test-framework extraction beyond structured assertion imports.
- [ ] Operational encryption/key rotation, backup retention and externally anchored audit storage.
- [ ] Human accessibility review and actual approval of any real migration contract. Synthetic fixture approval does not satisfy this.

Implementation checkpoint: `0af541e`. No remote publication was requested or performed. The remaining items above are intentionally unchecked; the RFC is not being declared production-complete.
