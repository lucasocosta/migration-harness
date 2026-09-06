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
- [x] Angular decorated inputs/outputs and simple synchronous reactive forms: discovery semantics (IO refs, forms symbols/directives, classified valueChanges), planner routing, codemod props/callbacks with explicit field-by-field validate() and submit gating, conservative refusals, manifest mappings (branch `next/angular-forms-and-io`).

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
- [x] Dedicated regression test: mock fixture paths resolving inside `.migration-private` are rejected (direct and via symlink).

## Validated checkpoint

- [x] Finish the current strict build after ESLint/axe and discovery additions.
- [x] Run all unit/CLI tests against the latest implementation: 28/28 passed.
- [x] Run all browser tests, including the axe context fix: 5/5 passed.
- [x] Re-run pilot including lint/typecheck: equivalent after one repair; contract and audit verified.
- [x] Update README, USAGE, IMPLEMENTATION-STATUS and VALIDATION to match the new delivered scope.
- [x] Final lockfile/private-file check: frozen lockfile passed; raw files 0600, directories 0700.
- [x] Commit the validated checkpoint: `0af541e` (implementation, tests and documentation).

## Assistant-driven integration pivot (2026-09-05)

Decision: the harness does NOT call a model via API. The Transform/Repair "LLM worker" is a human-driven coding assistant (Claude Code, Copilot, codex) driving the CLI with bounded briefs; every submission passes the same deterministic gates. Contract design: `docs/ASSISTANT-INTEGRATION.md`. The RFC §33.II invariant shifts from architectural guarantee to policy + tooling (honest residual-risk statement required).

- [x] Integration contract design (brief format, apply path, boundary model, AGENTS.md spec, llm-worker disposition).
- [x] `brief` / `apply-patch` CLI loop: issuance/baseline binding, strict projection, path and protected-input guards, all 10 refusal codes, optional static gates, archived manifests, rollback and audit. Expanded assistant suite: 15/15 passed, including partial-write fault injection.
- [x] `AGENTS.md` reviewed against design section 4: migration/maintenance scopes, public submission exception, fresh-brief procedure and honest crash limitations.
- [x] RFC sections 25/33.II and USAGE updated to policy + tooling; HTTP provider demoted to optional adapter.
- [x] Deterministic assistant-protocol worked example (`pnpm pilot:assistant`) passed with typecheck/lint, actual applied bytes, regression, repair, refusal and audit.
- [x] Continuation review: read HANDOFF and ASSISTANT-INTEGRATION; reproduce the pilot's incorrect brief-count assertion.
- [x] Verify issuance lookup, brief-time baseline checks, guarded public paths and protected-input fingerprints.
- [x] Verify aggregate repair budget, manifest screening, optional static gates and handled-failure rollback.
- [x] Verify expanded boundary regressions and both pilots: build, 60/60 unit/CLI, 9/9 browser, both smokes and diff check passed. Commit this continuation checkpoint after recording these results.
- [ ] Record a real brief-only human-driven assistant session. The deterministic protocol pilot is not evidence of this separate DoD requirement.
- Note: the "external model service with credentials" item is obsolete by design under this pivot; HttpWorkerProvider stays as a demoted optional adapter.

## Remaining broader scope / environment dependencies

- [ ] Execute DockerSandbox against a real local digest-pinned image. Docker is unavailable in this WSL environment. (Still relevant: it bounds harness-side execution of generated code.)
- [x] Builder-based reactive form groups with statically-normalizable configs: normalized to the literal subset in discovery (`builderInferred` provenance), CODEMOD-routed with byte-identical generation; non-static configs remain explicit unresolved edges.
- [x] Structured async-validator evidence (bound field, validator symbol, local/imported/unknown scope) and provider-lifetime recording (`providedIn`, component `providers`) on MigrationUnit, feeding the LLM/MANUAL lanes.
- [ ] Transformations for async validators, FormArray, dynamic controls, ngModel mixing and side-effectful valueChanges (stay LLM/MANUAL), complex provider lifetimes and stream orchestration transformations.
- [x] Dedicated WebSocket scenario adapter: WEBSOCKET_FRAME signal + 8th additive trace event, opt-in routeWebSocket capture (default stays blocked), capped/correlated recording, sanitizer default-deny pipeline, structural LLM projection, equivalence pairing by connection with strict within-connection order (direction/payload-shape/missing/unexpected divergences, BLOCKING); dependency-free RFC 6455 echo fixture; 45 unit/CLI + 9 browser tests passing.
- [ ] Service-worker scenario adapter and automatic application-wide causal instrumentation.
- [ ] OpenAPI composed/conditional schemas, external references and arbitrary test-framework extraction beyond structured assertion imports.
- [ ] Operational encryption/key rotation, backup retention and externally anchored audit storage.
- [ ] Human accessibility review and actual approval of any real migration contract. Synthetic fixture approval does not satisfy this.

Implementation checkpoint: `0af541e`. No remote publication was requested or performed. The remaining items above are intentionally unchecked; the RFC is not being declared production-complete.
