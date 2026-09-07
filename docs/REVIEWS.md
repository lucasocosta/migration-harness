# Review record

## Product reconciliation - 2026-09-06

RFC v0.3 supersedes the product workflow assumed by older reviews below. Those
entries describe historical fixes/decisions, not universal operating instructions.
Former RFC section references refer to v0.2 in Git history. Restricted checks
remain intact; their mandatory use is no longer the product goal.

| Finding | Decision | Delivery |
| --- | --- | --- |
| Value changes with identical payload shape pass | Selected value/outcome comparison and safe diagnostics | PLAN P2, pending |
| Missing required field escalates to contract review | Separate implementation defects from criteria changes | PLAN P4, pending |
| Brief-only read/edit rules dominate normal migration | Standard end-to-end agent; restricted compatibility | RFC agreed; PLAN P4 pending |
| Per-scenario CLI and artificial TypeScript environment fragment verification | Native checks, build identity and aggregate suite report | PLAN P1/P3 pending |
| Broad ARIA mismatches do not isolate the migrated feature | Unit-scoped semantics and side bindings | PLAN P2 pending |

Only documentation changes in this reconciliation. Agreement is not a code fix.
Probes are recorded in VALIDATION.md. PLAN.md owns the implementation checklist.

## Historical implementation reviews

Updated: 2026-09-06. Consolidates the former `REVIEW.md` (adversarial review
supplied 2026-09-05), `REVIEW-RESOLUTION.md` and `REVIEW-2026-09-06.md`
(reconciliation review). The original review texts are not preserved verbatim;
what matters operationally is the decision per finding and the regression that
locks it down. `STATUS.md` tracks delivery and remaining work.

Two findings were **rejected on purpose** — SF-4 and the causal-instrumentation
request. A rejected finding is a design position, not an oversight.

## Reconciliation review — 2026-09-06

Reviewed checkpoint `3b0fad2`. Baseline reproduced before probing: build PASS,
79/79 unit, 11/11 browser, both smokes, both pilots. Nine synthetic adversarial
probes produced the findings below. No real private artifacts were read.

Routing assumptions were checked against the official
[Playwright service-worker guide](https://playwright.dev/docs/service-workers):
worker-owned network requests are context events; page requests intercepted by a
fetch handler are not directly routable. Metadata alone does not close these gaps.

| Finding | Decision and implementation |
| --- | --- |
| R1 (P1) key pruning destroyed retained backups: encrypt → purge to backup → rotate with keep=1 left an unreadable backup (`ARTIFACT_AUTH_FAILURE`) | Fixed. Automatic pruning before mutation is refused; rotation retains the versions that backups still need. Synthetic restore regression passed. |
| R2 / R6 (P1) a service worker rewrote PUT into POST at the server while both traces recorded PUT and the validator returned EQUIVALENT; declared page mocks were bypassed under SW passthrough | Fixed. Worker-owned exchanges are observed and one-to-one forwarding is verified; rewritten, cached and autonomous worker traffic is refused rather than compared. Mocks are installed at context level. Four focused browser tests passed. |
| R3 (P1) the importer reset the reference document during recursive visits and replaced the root with a fragment: a local alias failed and a nested external `allOf` imported the wrong field with no unresolved finding | Fixed. Reference document ownership is preserved through local aliases and external compositions. Focused importer regressions passed. |
| R4 / R7 (P1/P2) keys were read without checking file mode, type, hard links or `O_NOFOLLOW` (a 0644 key and a key symlink were accepted); a truncated `MHAES001` envelope was treated as legacy plaintext | Fixed. Key permissions, regular-file status and absence of symlinks are verified; truncated or damaged encrypted envelopes report authentication failure instead of silently degrading. Focused lifecycle tests passed. |
| R5 (P1) the artifact store rejected children of the public root but not equality, so a backup root equal to the public root wrote plaintext raw traces into public `gen-1000/raw/...` | Fixed. A backup root equal to the public root is rejected. Focused regression passed. |
| R8 (P1) the importer excluded only the literal `.migration-private`, not native private roots; CLI audit guards lacked resolved/all-store checks and rotation checked the wrong store root | Fixed. Resolved private-domain guards apply to CLI inputs and audits, with explicit and native private-root rejection for imports. Regression in `tests/cli.test.mjs`. |
| R9 (P2) `anchorAudit` read and appended without a lock; two simultaneous calls produced two anchor lines with no `previousAnchorHash` | Fixed. Exclusive locks cover key generation, raw lifecycle, audit updates and anchor appends. Focused anchor concurrency regression passed. |

All nine were resolved and verified in that implementation cycle (build PASS, 92/92 unit,
13/13 browser, both smokes, both pilots). The instrumentation non-goal recorded
in `STATUS.md` is a scope decision, not an implemented instrumenter.

## Implementation review — 2026-09-05

### Must-fix

| Finding | Decision and implementation |
| --- | --- |
| MF-1 FSM approval bypass | Fixed. Only `CONTRACT_REVIEW` can approve; the regression test attempts the actual synthesis-to-approved shortcut. |
| MF-2 bypassable AST denylist | Accepted the review's boundary-documentation alternative. Checks and tests cover common aliases, indirect eval, constructors and string timers, but static scanning remains defense in depth and does not establish runtime safety. Worker providers return untrusted data; they do not execute patches. Generated commands must run through `DockerSandbox`, never on the host. The deterministic pilot provider is trusted test code, not untrusted generated execution. Live Docker verification is still environment-blocked. |
| MF-3 locale-dependent contract hashes | Fixed. Contract and audit hashes share core codepoint canonicalization; tests replace `localeCompare` with a throwing function. Previously generated synthetic hashes may differ; real approved contracts must never be silently rehashed. |
| MF-4 fixture filesystem escape | Fixed. Real base/fixture paths are resolved and containment enforced before reading; symlink escapes and private-domain paths are rejected. |

### Should-fix

| Finding | Decision and implementation |
| --- | --- |
| SF-1 default-open payload keys | Fixed. Payload and storage fields default to deny; unstructured strings are pseudonymized. Pilot policies allow required fields explicitly. |
| SF-2 malformed URLs | Fixed for malformed encoded URLs accepted by the trace schema: an opaque URL pseudonym replaces an undecodable URL. Invalid trace envelopes still fail schema validation deliberately. |
| SF-3 ARIA URL secrets | Fixed in JSON and YAML. Nested ARIA URLs use URL sanitization; YAML is regenerated from sanitized JSON. |
| SF-4 navigation multiset | **Not adopted.** A single main frame's route transitions and redirects are ordered observable behavior: `/login → /account → /done` and `/account → /login → /done` must not pass merely because their URL multisets agree. RFC §16's independent-request example is handled by the network multiset and the declared causal-DAG comparator. Explicit navigation aliases remain available. A regression test locks this down. |
| SF-5 volatile values | Added per-template volatile path parameters, volatile response fields and per-storage-type/key volatile values, alongside existing query/request-field policies. All require explicit declarations. |
| SF-6 fabricated path params | Fixed. Incompatible regex/template rules throw instead of inventing a literal parameter. |
| SF-7 replayed runs | Added recorder-generated `runId` and duplicate execution-identity rejection, with `startedAt` fallback for older traces. This catches index-only replay; it is not cryptographic proof of independent execution. |
| SF-8 network-only synthesis | Implemented observational storage candidates and stable final navigation/ARIA candidates, kept at WARNING/INFORMATIONAL. External evidence corroborates only operations matching the scenario. |
| SF-9 ignored `needsReview` argument | Removed the argument. Synthesis always enters review. |
| SF-10 success disposition | Successful repair/gate results use `null`, not `UNKNOWN`. |
| SF-11 false nondeterminism | Scenario failure is UNKNOWN/blocking; the repair coordinator returns a structured `SCENARIO_FAILED` result when target execution throws. Nondeterminism is reserved for explicit evidence. |
| SF-12 artifact TOCTOU | Added `O_NOFOLLOW` and post-open realpath/device/inode checks before writing; private roots require verified 0700. Same-UID hostile filesystem mutation is not a solved capability-isolation model in Node — do not treat path checks as protection against a privileged local attacker. |
| SF-13 mock origin bypass | Fixed. Every mock handler enforces the origin allowlist before fulfillment; browser tests cover this independently of context routing. |
| SF-14 patch extensions | Bounded worker patches are restricted to TS/TSX. |
| SF-15 repair containment | CLI repair requires `--candidate-root` and validates the target relative to that explicit root. |

### Additional work from the same pass

- One ARIA JSON capture supplies both representations; YAML is structured YAML of
  that JSON, not Playwright's old shorthand format.
- Missing terminal responses produce `HTTP_FAILED`; divergence IDs are unique;
  ARIA checkpoints resolve actual interaction IDs.
- Browser locale/viewport are configurable and the recorder reports the actual
  navigator locale.
- Public artifact writes reject structured raw traces, including nested ones.
- Unicode NFC normalization, prototype-like keys, malformed percent encodings,
  indirect evaluation, retention symlinks and hash portability have regression
  coverage.
- Playwright is pinned to 1.63.0 in the dependency itself, not only the lockfile.
- Multiple discovered components require explicit entrypoints. Route ownership,
  guards/resolvers, constructor injection, aliases, selectors and pipes have
  implementation and tests.
- Zero-step scenarios remain valid: boot-only behavior is useful and is exercised
  by the browser mock-boundary test.
- Unused placeholder adapters were removed rather than presented as features. The
  scrubber re-export is an intentional compatibility facade. Legacy Python and
  example fixtures are retained as clearly labeled historical material and are
  not used by current test commands.
- Mock fixture paths resolving inside `.migration-private` are rejected, directly
  and via symlink, with a dedicated regression.
