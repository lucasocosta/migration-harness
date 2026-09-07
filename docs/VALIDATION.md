# Validation record

## P3 consolidated verification operation - 2026-09-07

Based on adc61d4 (managed suite capture). Added the consolidated standard
operation: `prepare-migration` and `verify-migration` CLI commands,
`MIGRATION_PREPARATION` (core/migration-preparation.ts) and engine
migration-operations (`preflightMigration`, `prepareMigration`, `verifyMigration`,
`summarizeMigration`). `captureProjectSuite` gained an owned shared
pseudonymization key, baseline/candidate phases, source-only mode and structured
`ScenarioExecutionError` step/stage codes surfaced on capture records. The
validation-first example (synthetic Angular source, real-shell React target with
the candidate implemented) exercises the whole flow, including the documented
regression recipe.

- Workspace build PASS.
- Focused new tests: 7/7 unit (tests/migration-operations.test.mjs) and 1/1
  browser (tests/browser/migration-verify.test.mjs) PASS.
- Full serial regression PASS: 186/186 (165 unit/CLI + 21 browser), no
  failures/skips. Commands run separately, wall time about 28.4 min and 3.8 min
  on /mnt/c: `node --test --test-concurrency=1 tests/*.test.mjs` and
  `node --test --test-concurrency=1 tests/browser/*.test.mjs`.
- Both smokes PASS. `git diff --check` PASS. examples/validation-first left
  byte-identical after the mutation/restore regression.
- Standalone pilots and Cinema native builds were not rerun in this increment.

Coverage: preparation schema strictness; authorization refusals before any
artifact write; unsafe artifact/output overlap and private-workspace refusals;
tampered preparation hash refusal; unreadable pseudonymization key and stale
evidence fail closed (report INCONCLUSIVE with STALE_EVIDENCE, never PASS);
preflight-only discipline (preflight.json/started.json without
preparation.json); CLI option validation and help; and the full example
lifecycle: prepare PASS -> verify PASS -> controlled candidate regression FAIL
(BEHAVIOR_DIVERGENCE on the save scenario, exit 4) -> restore -> verify PASS,
with ports 43120/43153 owned and released by the harness.

Reference integration: the preparation fixes a verified reference and verify
re-checks it before and after capture, refuses an invalid cache, requires
complete source evidence (every scenario x run, matching trace hashes, unique
run IDs) and computes global source stability over the whole inventory; missing
captures never verify a reference. Served baseline/source-build identity is tied
to the candidate capture (SOURCE_BUILD_MISMATCH). Report status integrates
preservation, requirements, native checks and optional critical-contract state;
PASS requires complete required coverage.

Remaining: no real migration has been verified by this operation yet (Cinema is
pending P5); operation-level occupied-port/stale-build/timeout behavior relies on
the managed-build library tests; normal agent iteration and persistent budgets
are P4.

## P3 reset and suite capture - 2026-09-07

Based on 378d730 (managed static builds). Added `runProjectReset` and
`captureProjectSuite`; the shared browser capture now accepts cancellation and
an expected served-build identity. Internal workspace dependencies were added
for the existing runner/sanitizer, without upgrading external packages.

- Build PASS after resolving strict optional-property typing at the library boundary.
- Initial focused tests: 9/9 PASS; first full serial regression: 177/177 PASS
  (157 unit/CLI + 20 browser), about 699 seconds.
- Follow-up: deferred Playwright loading until capture is requested. A standalone
  import cost about 1.7s here; non-browser engine operations must not load it.
  Added a module-loading regression; final focused tests 10/10 PASS (4 reset/loading
  tests + 6 browser). Full regression after this adjustment: 178/178 PASS
  (158 unit/CLI + 20 browser), no failures/skips, about 517 seconds, with
  `node --test --test-concurrency=1 tests/*.test.mjs tests/browser/*.test.mjs`.
- Both smokes PASS. Tracked Markdown links: 17 documents, 49 local links, none missing.
- Final diff check PASS; cloned Angular/React worktrees remain clean. Standalone
  pilots and Cinema native builds were not rerun in this increment.

The synthetic stateful backend records reset/read ordering for two scenarios,
two source runs and one target run each: six resets before six reads. Bound source
and target controls/routes differ. Evidence is sanitized, has distinct trace IDs
and carries matching build/binding hashes. With no backend reset, both scenarios
become UNSTABLE even with fresh contexts. Failed resets prevent their captures;
scenario errors do not hide remaining scenarios; total timeout records NOT_RUN
and closes owned resources before persisting the summary. Output collisions and
project-local outputs are refused before builds; failed builds leave an explicit
inconclusive inventory. Wrong served-document identity is refused. Cancelling a
capture leaves a caller-provided browser connected with no leaked contexts.

Reset tests cover explicit authorization, public output omission, native nonzero
exit/timeout/cancellation, input mutation and independently checked reset cwd.
ISOLATED_FIXTURES runs no project command and makes no claim to clear an external
backend. Raw trace/key retention is intentionally absent from the new suite API:
one ephemeral shared key is used in memory for an invocation. Sanitized evidence
is not a cross-invocation reference cache.

No source/target comparison or target assertions are run by this operation yet;
CAPTURE_SUITE.COMPLETED is not migration equivalence. Per-scenario stability has
not been attached to a versioned reference or aggregate report. The standard CLI,
reference reuse/invalidation integration and final migration reporting are pending.
No Cinema candidate, approved criteria or application source changes were made.

## P3 managed static builds - 2026-09-07

Added `withProjectBuildServers`, optional disposable-output build configuration and
`SERVED_BUILD` identities. The preceding commits are c4f319b (P1/P2), 5079579
(native checks) and ea769c0 (documentation); this increment is separate.

- Workspace build PASS.
- Focused new tests: 11/11 unit tests and 1/1 Chromium integration test PASS.
- Full serial regression PASS: 168/168, comprising 154 unit/CLI and 14 browser
  tests, no failures/skips, about 535 seconds. Command:
  `node --test --test-concurrency=1 tests/*.test.mjs tests/browser/*.test.mjs`.
- Both smokes PASS. Tracked Markdown: 17 files, 49 local links, none missing.
- Angular/React worktrees clean. No Cinema candidate or evaluation-input edits.
- `git diff --check` PASS.

Coverage: explicit command/cleanup authorization and generated-directory protection;
fresh builds, matching health/header identities and immutable serving; occupied
target port without cleaning the old output or touching its listener; no-op/failed
builds refusing stale artifacts; callback error, abort and total timeout cleanup;
input/disk changes invalidating results; symlink, hard-link, credential-name, missing
index and oversized-file refusal; local-origin configuration; build metadata in the
reference environment hash; SPA fallback without masking missing JS, source-map
refusal, method/Host restrictions and HEAD responses. Chromium loads JS and clicks
the synthetic UI on both origins at 1280x720 and 390x844, with screenshots and no
page errors. These are public synthetic fixtures, not a Cinema migration.

The first focused run exposed a test-client issue: Node fetch ignored the custom
Host header. The test now sends it through node:http and verifies the refusal;
the corrected focused run passed. No failing run was relabeled as a success.

Limits: static SPA library only; no consolidated verification CLI, reset, scenario
or reference-stability orchestration, final migration report or SSR. Only declared
inputs are fingerprinted. Public build assets must not contain secrets; filename
checks are not content sanitization. The callback owns browser resources and must
honor cancellation. Native commands remain authorized local code, not a sandbox;
generated output is explicitly disposable and not rolled back. Existing configs
without build metadata retain the prior environment-hash projection. Standalone
pilots and actual Cinema builds were not rerun in this increment.

## Commit organization - 2026-09-07

- c4f319b: P1/P2 configuration, reference lifecycle, comparison and reporting libraries.
- 5079579: P3 native checks, CLI, process lifecycle and related tests.
- Documentation transition is committed separately after these code snapshots.

No functional code changes or test rerun during commit organization. The verified
snapshot below remains the evidence: build, 143/143 unit/CLI tests and both smokes.
Staged diffs were checked. Local migrations/cinema documents remain ignored by Git;
no private artifacts or cloned applications were added to the harness repository.

## P3 native project checks - 2026-09-06

Reconciled the other agent's P1/P2 library work without reverting it. The committed
HEAD was still c663b40; the accumulated implementation is in the working tree.

- Baseline build PASS; focused P1/P2 suites 40/40 PASS before this increment.
- Final build PASS; unit/CLI suite with --test-concurrency=1: 143/143 PASS,
  including 11 project-check tests. Both smokes PASS; git diff --check PASS.
- Documentation: 21 Markdown documents / 49 local links checked successfully.
- Actual apps/react native npm run build and npm run lint executed through
  runProjectChecks in baseline phase: both PASS, exit 0, about 8.5s and 1.4s.
  Declared input digest before/after matched; app worktrees remained clean.
- Browser suite/pilots were not rerun in this increment; their preceding P2
  checkpoint remains recorded separately below, not relabeled as a current run.

Coverage: no-command preflight, missing/symlinked inputs/cwd, explicit authorization,
literal argv, minimal inherited environment, raw-output omission, baseline failure
annotations, all required/advisory checks, timeout/output limits, spawn failure,
abort, owned-child cleanup after exit/timeout, unrelated-process survival, changed
inputs and exclusive/protected CLI outputs. Help and native exit codes exercised.

The real React check used its existing package scripts/tsconfig/Vite types. No API
source edit, any-cast, gate disable or approved migration contract change was made.
The restricted isolated TypeScript checker is unchanged; native checking is the
new path, not a claim that the old checker was fixed.

Limitations: PROJECT_CHECK_REPORT is not migration equivalence or served-build
identity. Only declared inputs are fingerprinted. Preflight does not check ports
or server readiness; no browser scenario/reset execution occurred. Raw compiler
output is omitted rather than parsed into localized diagnostics. Execution is
authorized local POSIX code, not a sandbox against intentionally escaped processes.
Next work is the remaining P3 server/build/scenario coordination in PLAN.md.

## P2 persistence and repeatability increment - 2026-09-06

Added the `READ_BACK` assertion claim, mocked-coverage disclosure and
`equivalence-validator/stability.ts` (`verifySourceStability`, `comparableProjection`,
`executionHash`). The report now accepts a `MOCKED_COVERAGE` disclosure next to a pass,
and `verifySourceStability` produces the `sourceObservations` a versioned reference
requires, which until now had no producer.

- Workspace build: PASS.
- `tests/persistence-stability.test.mjs`: 4/4 PASS.
- Full unit/CLI suite, serialized: 132/132 PASS. Chromium suite: 13/13 PASS.
- Both smokes, `pnpm pilot` and `pnpm pilot:assistant`: PASS. `git diff --check`: PASS;
  app worktrees stayed clean.

New coverage: a read-back proves persistence only when the written values return, with
differing values, a differently named response field, a missing read and a missing write
each localized; a read answered by a declared mock is NOT_EVALUABLE and aggregates as
INCONCLUSIVE, while the same evidence without the mock declaration would have looked like
proof; an integrated read alongside a mocked initial load still proves persistence;
mocked coverage is INFORMATIONAL, reaches the report as `MOCKED_COVERAGE` and may
accompany a PASS while any other diagnostic still contradicts one; repeated source
executions under a declared reset yield STABLE with equal execution hashes, differing
timestamps do not make a source unstable, a changed payload value yields UNSTABLE with
its structural location, declaring that field volatile in the policy makes it stable
again, too few runs yield NOT_COLLECTED, and mixed scenarios or fewer than two required
runs are refused. No observed value appears in a stability result.

Not established by this work: mocked coverage is derived from the scenario's declared
mocks, not from transport introspection; read-back uses the last write of the checkpoint
window and any later read in the trace; stability compares preservation only (network,
observables, causality, WebSocket), not contracts or assertions; the reset is a recorded
declaration, not proof that a backend was actually cleaned. Running any of this against
real processes, builds and servers is P3.

## P2 applied bindings increment - 2026-09-06

Scenario bindings gained a per-application `unitScope`, and `resolveScenarioForSide`
now produces one side's executable scenario from the shared definition: entry route,
effective control roles/names and that application's unit scope. The shared semantic
and binding projections moved into core, so the reference hash and the resolver agree
by construction, and `evaluateUnitAssertions` accepts per-side `unitScopes`.

- Workspace build: PASS.
- `tests/scenario-bindings.test.mjs`: 4/4 PASS.
- Full unit/CLI suite, serialized: 128/128 PASS. Chromium suite: 13/13 PASS.
- Both smokes, `pnpm pilot` and `pnpm pilot:assistant`: PASS. `git diff --check`: PASS;
  app worktrees stayed clean.

New coverage: the source side without overrides equals the declared scenario; the
destination resolves its own route, locator and scope while both sides keep an identical
semantic projection; a binding cannot express an action, an input value, a completion
signal, an unknown step, an invalid role, a foreign origin or an invalid scope, refused
by the schema and by the resolver; an adapted destination scope makes the assertion
evaluable where the unadapted one is SCOPE_NOT_FOUND rather than a pass; a control
missing inside an adapted scope still fails with NODE_MISSING; an assertion-level scope
remains the default when an application declares none; and a binding or scope change
alters the configuration hash and is classified as BINDING_ADAPTATION in the reference,
requiring a new version and a rerun of both sides.

Not established by this work: running a resolved scenario end to end (P3 wiring),
persistence read-back, source-stability verification, and any migration verdict.
Declared names and roles are matched by normalized equality or inclusion, with no
similarity heuristics.

## P2 unit assertion increment - 2026-09-06

Added `core/unit-assertion.ts` (checkpoint, unit scope and claim schemas plus outcome
schema), `equivalence-validator/assertions.ts` (per-side evaluation and divergences),
`unitAssertionsForScenario` on the configuration, `assertionRequirementStatuses` for
report requirement statuses, and the assertion inside the reference requirement digest.
Configuration requirements may now carry a machine-checkable claim; prose-only
requirements keep needing caller-supplied evidence.

- Workspace build: PASS.
- `tests/unit-assertions.test.mjs`: 7/7 PASS.
- Full unit/CLI suite, serialized: 124/124 PASS.
- Chromium suite: 13/13 PASS. Both smokes: PASS.
- `pnpm pilot` and `pnpm pilot:assistant`: PASS. `git diff --check`: PASS; app
  worktrees stayed clean.

New coverage: a required violated assertion blocks while the global ARIA dimension
remains a WARNING; a destination-shell-only difference does not fail the unit; advisory
assertions warn instead of blocking; field text, `invalid`, `disabled` and
absence-expected claims; a forbidden submission detected as missing validation, with a
later legitimate submission attributed to its own step; required submissions with
top-level and nested payload fields; storage mutation and navigation claims as
observable callback effects; missing checkpoint, empty capture and lost unit scope
mapped to NOT_EVALUABLE and then INCONCLUSIVE; source-only violation disclosed as
INFORMATIONAL; outcome-to-requirement status mapping; duplicate assertion ids refused;
strict declaration parsing; and the requirement digest changing when its assertion does,
which the reference classifies as a criteria change needing an owner decision.

Privacy assertions confirm that no observed field value, accessible name or shell text
appears in a result: diagnostics carry the requirement id, a reason code and the
declared role. Declared expected texts are owner configuration, so label and message
literals must be declared, not user data.

Not established by this work: per-side control/visual bindings, persistence read-back,
source-stability verification, direct capture of component output callbacks (P6 host),
and any executable verification operation or migration verdict. Checkpoint windows for
a step run from that interaction to the next one and rely on the recorder draining a
step's asynchronous activity rather than on wall-clock timing.

## P2 value comparison increment - 2026-09-06

Added `equivalence-validator/values.ts` (kind-aware value diff, safe path segments,
declared-path presence) and wired it into network comparison: request payload and
response body values are compared when the policy enables it, and equal values keep
exchanges cancelling as before. Comparison diagnostics no longer carry observed data.

- Workspace build: PASS.
- `tests/equivalence-values.test.mjs`: 7/7 PASS.
- Full unit/CLI suite, serialized: 117/117 PASS (110 previous plus the seven new).
- Chromium suite: 13/13 PASS.
- Both smokes: PASS. `pnpm pilot`: EQUIVALENT after one bounded repair
  (`artifacts/pilot-TA7dbr`). `pnpm pilot:assistant`: PASS
  (`artifacts/pilot-assistant-0ZKRd5`), still labeled a deterministic simulation.
- `git diff --check`: PASS; both app worktrees stayed clean.

New coverage: wrong value of the same type, changed number, inverted boolean, type
substitution, omitted and unexpected fields, absence versus explicit null, array
reordering and length, response-body values, nested volatile fields tolerated at any
depth, and the v0.2 shape-only default versus the standard mapping. Privacy assertions
confirm that no observed payload string, storage value, ARIA name, query value or
pseudonym token appears in a result, while paths, storage keys, ARIA roles, path
parameter names and query keys remain available for localization. A declared
`requiredValueFields` entry that neither side exposes — including a field dropped by
sanitization or an operation that never happened — produces `VALUE_EVIDENCE_OMITTED`
and aggregates as INCONCLUSIVE. Helper tests bound depth, difference volume and unsafe
key segments.

Not established by this work: unit-scoped semantic assertions (errors, submit state,
absence of an invalid request), control/route bindings, persistence read-back,
source-stability verification, and any executable verification operation or migration
verdict. Array comparison is positional. Values can only be compared as far as
sanitization retains them, so a required field that was redacted is inconclusive.

## P1 reference lifecycle increment - 2026-09-06

Added `core/migration-reference.ts` (versioned reference, public-safe verification
outcome, pure change classification) and `engine/migration-reference.ts`
(`collectMigrationReference`, `verifyMigrationReference`, `ReferenceWeakeningError`).
The aggregate report now consumes a reference verification: a configured critical
contract only stops emitting `CRITICAL_CONTRACT_UNVERIFIED` with a VERIFIED reference
whose observed contract digest equals the configured one, and `referenceStatus`
separates DECLARED from VERIFIED/STALE/UNVERIFIABLE. No CLI, browser runner or
restricted-profile behavior changed.

- Workspace build: PASS.
- `node --test tests/migration-reference.test.mjs`: 8/8 PASS.
- Full unit/CLI suite, serialized (`--test-concurrency=1`): 110/110 PASS.
- The same suite run in parallel failed only `tests/worker-http.test.mjs` with
  "Worker deadline exceeded" (8.4 s). That test passes alone (2.2 s) and serialized;
  it is a load-sensitive bounded-worker deadline in this environment, and the increment
  touches no worker code. Recorded rather than hidden.
- Both smoke scripts: PASS. `git diff --check`: PASS. App worktrees stayed clean
  (`apps/angular` 11db3f2, `apps/react` b3bfcf5).
- Browser suite and pilots were not rerun; they remain required before the executable
  standard workflow and Cinema acceptance.

Reference tests cover real fingerprints of declared source/target files, protected
destination work and scenario fixtures; `.git` revision resolution with an
`UNVERSIONED` fallback; refusal of missing, escaping, symlinked and oversized inputs
and of a declared-but-absent mock fixture; verification of untouched inputs; STALE for
changed/missing source inputs, changed or added fixtures and changed protected files;
INFORMATIONAL candidate and added-protected-file findings that do not block;
UNVERIFIABLE for a changed configuration, a hand-edited reference and a foreign
migration id; an approved contract verified from disk plus tampered, wrongly declared,
non-approved and deleted contract cases; INITIAL/EXTENSION/BINDING_ADAPTATION/
INPUT_UPDATE classification with recorded lineage; eight weakening shapes (demoted
scenario/requirement/check, removed requirement, new accepted difference, broader
ignore rules, changed step semantics, smaller stability budget) refused without an
owner decision and recorded with one; and report outcomes for verified, declared,
mismatched-reference and tampered-contract evidence.

Not established by this work: value/outcome comparison, execution, build or server
coordination, repeated source executions, and any migration verdict. Hashes detect
inconsistency; they do not authenticate provenance or prevent a same-user mutation.
Revision metadata is best effort and never a trust anchor.

## P1 first library increment - 2026-09-06

Added versioned migration config/report schemas, configuration hashing, aggregate
coverage/identity checks and a conservative v0.2 comparison adapter. No CLI,
browser runner or restricted-classifier behavior changed.

- Workspace build: PASS.
- Full unit/CLI suite at the first implementation checkpoint: 101/101 PASS
  (92 existing tests plus the first nine P1 tests).
- After adding report-identity consistency and a multi-scenario regression:
  rebuilt successfully; tests/migration-report.test.mjs 10/10 PASS.
- Both smoke scripts: PASS on the final build; git diff --check: PASS.
- Browser suite and pilots were not rerun in this increment; they remain required
  before the executable standard workflow/Cinema acceptance. App worktrees stayed clean.

P1 tests cover strict versions, lexical paths/scope/bindings, nested config hashes,
separate requirement/preservation/check outcomes, missing/duplicate/unknown evidence,
mixed candidate/build/reference identities, advisory results, incomplete legacy
coverage, discarded runtime text, and fail-closed unverified critical contracts.

These helpers consume caller-collected identity hashes and referenceVerified;
they do not authenticate provenance, read project files, create reference versions,
verify approved contracts or prove values equivalent. Those capabilities remain
pending in PLAN.md. No real migration has been certified by this work.

## v0.3 design reconciliation - 2026-09-06

Checkpoint inspected: c663b40. Public code/docs only; no private raw artifacts read.
Two synthetic probes used the built EquivalenceValidator and tests/helpers.mjs:

| Probe | Observed result | Interpretation |
| --- | --- | --- |
| Change an email payload value, keeping method/keys/types and fixture contract | EQUIVALENT, no divergences | Value preservation is not established by shape comparison |
| Omit required email field | NOT_EQUIVALENT; NETWORK_PAYLOAD_SHAPE_MISMATCH + CONTRACT_PAYLOAD_REQUIRED; REQUIRES_CONTRACT_REVIEW | Ordinary target defect unnecessarily escalates to owner |

These are findings, not fixes. No full build/unit/browser/pilot rerun was performed
for that assessment. RFC v0.3 and PLAN.md address them; existing green suites do
not certify the new design. Documentation verification is recorded separately below.

## Documentation transition checks - 2026-09-06

- Checked 21 Markdown documents, balanced code fences and 49 local link targets.
- Parsed both agent YAML frontmatters; names/tools/agents/hooks/handoffs unchanged
  versus HEAD. The old descriptions contained unquoted colons; the rewritten
  descriptions parse correctly without changing execution settings.
- `node --test tests/copilot-hook.test.mjs`: 8/8 PASS.
- `git diff --check`: PASS. Only Markdown files changed; app worktrees stayed clean.
- No full build/unit/browser/pilot rerun for these documentation-only edits.

The new standard profile, value comparisons and consolidated runner remain pending.
Local Cinema documents are ignored by harness Git and are not part of its commits.

## Historical execution records

References to the old integration section 6.2 and mandatory clean-context proof
below describe v0.2 acceptance, now optional restricted-profile evidence. They
are not requirements for the standard workflow. Commit/dirty-tree descriptions
refer to the time of execution, not the current worktree.

What was actually executed, and what each run does not prove. Historical entries
for the pre-dependency, Python-fixture era (v0.2 and v0.2.1) were removed: their
counts and environment no longer describe this tree. `STATUS.md` holds the
current status; `REVIEWS.md` holds review decisions.

## Correction set and migration workflow — 2026-09-06

Tree: commit `3b0fad2` plus the uncommitted corrections for audit findings R1-R9,
the read-only destination context (`--context-files`), the Portuguese Copilot
manual, the migration specification template, and the two Copilot migration
agents with their boundary hook.

| Check | Result |
| --- | --- |
| Strict workspace build | PASS |
| Unit/CLI suite | 92/92 PASS |
| Chromium suite | 13/13 PASS |
| `smoke.mjs` and `smoke-v02.mjs` | PASS |
| Original pilot | PASS, `artifacts/pilot-5ZpYVI`, EQUIVALENT after one bounded repair |
| Assistant protocol pilot | PASS, `artifacts/pilot-assistant-WSkbqf` |
| `git diff --check` | PASS |

New coverage in this set: refusal of key pruning that would orphan retained
backups, with a synthetic restore regression; service-worker one-to-one
forwarding verification and context-level mock installation, in four focused
browser tests; reference-document ownership through local aliases and external
compositions; key mode/type/symlink verification and truncated-envelope
authentication failure; rejection of a backup root equal to the public root;
resolved private-domain guards for CLI inputs, audits and importers; exclusive
locks for key generation, raw lifecycle, audit updates and anchor appends; and
the read-only destination context, where a context file supports relative imports
without becoming writable, a patch targeting it is refused, and mutating it
produces `BASELINE_HASH_MISMATCH`.

The boundary hook for the Copilot agents has eight dedicated regressions
(`tests/copilot-hook.test.mjs`): fail-closed on unusable input, missing phase and
missing brief; refusal of the private raw domain, the native private state root
and credential files, including `~` and `file://` forms; preparation writes
limited to the tracking directory with no command execution; transformation reads
limited to brief, `AGENTS.md`, `allowedFiles`, `contextFiles` and the unit's
artifact root; writes limited to a submission JSON, with direct candidate writes
refused; oracle commands and git publish commands refused while `apply-patch`,
`run` and the destination build pass; and a JSONL decision log written as
evidence.

Not proven by this set: a complete migration into an existing React repository;
the later Cinema setup alone does not close that gap. The hook is defense in depth on the assistant's tool
calls, not isolation; and hooks declared in agent files are a Preview VS Code
feature that requires `chat.useCustomAgentHooks`.

## Assistant integration — 2026-09-05

After checkpoint `a9a7f2d`: build PASS, 60/60 unit/CLI (15 assistant tests), 9/9
browser, both smokes, `git diff --check` PASS. Coverage included all ten refusal
codes, recomputed forged briefs, stale baselines, protected inputs, private
aliases, candidate symlinks, output collisions, issued submission caps, manifest
screens, aggregate repair budgets, configured static gates, locks, multi-file
rollback and injected partial writes.

The assistant protocol pilot ran real CLI and Chromium with typecheck and lint
enabled, rebuilt the applied bytes, produced a deliberate method regression, a
repair, an out-of-scope refusal, an unchanged synthetic contract and a verified
audit. It is explicitly labeled `DETERMINISTIC_PROTOCOL_SIMULATION`, not a recorded
human-driven assistant session. Clean-context recording is now optional evidence
for the restricted profile, not a standard-product prerequisite.

## RFC pilot and review corrections — 2026-09-05

Executed in WSL with Node 20.20.1, TypeScript 5.9.3, pnpm 10.15.0 and Playwright
pinned to 1.63.0. Build PASS across all 15 projects, 28/28 unit/CLI, 5/5 browser,
both smokes, the Angular → generated React pilot with lint/typecheck, and
`git diff --check`.

That pilot recorded three source executions, detected `NETWORK_METHOD_MISMATCH`
after a `PUT → POST` regression, applied exactly one bounded repair, obtained
EQUIVALENT, and verified both the unchanged approved fixture contract and its
audit chain. Approval and provider are synthetic test fixtures: no production
contract was approved and no model reasoning was exercised.

Coverage included portable hashes, the actual FSM approval bypass, default-deny
payload fields, Unicode and prototype keys, malformed encoded URLs, ARIA URL
secrets, mock filesystem and origin boundaries, path/response/storage volatility,
replayed execution identities, causal comparison, static-scan bypass patterns and
worker HTTP error/redirect/size/deadline behavior.

## Environment facts that affect interpretation

- Private raw artifacts live under `~/.local/state/migration-harness/<hash>/raw`,
  with 0700 directories and 0600 files. `/mnt/c` was observed to expose 0777
  despite requested modes, so private artifacts must stay on the native Linux
  filesystem; permission, symlink and retention tests run against native
  temporary directories.
- The recorder handles Chromium's bodyless-response `ERR_ABORTED` case only when
  an actual 204/304/HEAD response exists; see
  [Playwright issue 26897](https://github.com/microsoft/playwright/issues/26897).
  Transport errors without a completed bodyless response remain failures.
- Never verified here: `DockerSandbox` execution (Docker unavailable through this
  WSL integration), external model inference, and framework behavior beyond the
  documented adapters.
- Automated axe results do not replace human accessibility evaluation, and no
  real migration contract has been approved by a human reviewer.
