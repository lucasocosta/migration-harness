# Status

Updated: 2026-09-07. Harness branch: `next/angular-forms-and-io`.
Base of the v0.3 transition: `c663b40`. P1/P2 libraries committed as `c4f319b`.
P3 native project checks committed as `5079579`. No merge or push performed.
RFC v0.3 direction is agreed; its standard workflow is **not implemented**.
[PLAN.md](PLAN.md) is the single ordered implementation checklist.

P1 is complete as a library: versioned configuration and report schemas, config
fingerprints, a versioned reference with real working-tree input fingerprints and its
change lifecycle, conservative v0.2 comparison adaptation and report aggregation.
Implemented in core/migration-config.ts, core/migration-reference.ts,
core/migration-report.ts, engine/migration-reference.ts and
quality-gates/migration-report.ts. These are library APIs; the complete standard
flow is not available. The first P3 CLI operation is described below.
`collectMigrationReference` reads declared public project files, protected destination
work, scenario fixtures and an optional approved critical contract; it refuses symlinks,
escapes, missing inputs and oversized files. `verifyMigrationReference` re-checks those
inputs, so a configured critical contract can now reach a verified state, while missing
repeated-source evidence keeps the outcome UNVERIFIABLE until P3 collects it. A new
reference version classifies additions, binding adaptations and input updates on its
own; weakening evaluation criteria requires an explicit owner decision.

P1 verification: build PASS; unit/CLI suite 110/110 PASS in a serialized run
(tests/migration-reference.test.mjs 8/8); both smokes PASS; `git diff --check` PASS.
Browser suite and pilots were not rerun in these library increments. See VALIDATION.md.

P2 has started: selected request-payload and response-body values are now compared,
not only their shapes, and comparison diagnostics became structural. A difference
reports its path and the kinds involved (`payload.email`, `string` versus `absent`),
never an observed value; navigation, storage and ARIA diagnostics report safe routes,
storage keys with a difference classification and ARIA roles instead of dumping
observed data. A declared required value field that neither side exposes yields
`VALUE_EVIDENCE_OMITTED`, which aggregates as INCONCLUSIVE. Value comparison is
opt-in for the v0.2 policy mapping and on by default in the standard mapping, which a
standard configuration cannot disable.

P2 is complete as a library: value comparison, unit-scoped assertions, applied
per-application bindings, persistence read-back and source/source repeatability.

P2 verification: build PASS; unit/CLI 132/132 serialized; Chromium 13/13; both smokes;
both pilots PASS; `git diff --check` PASS. See VALIDATION.md.

Unit-scoped semantic assertions now exist too: a configuration requirement may carry a
machine-checkable claim at a named checkpoint (node presence/absence with state and
text, forbidden or required request, storage mutation, navigation), evaluated on each
side inside the unit's semantic scope. A required violation in the destination blocks
regardless of the global ARIA policy; a lost scope, a missing checkpoint or an empty
capture is not evaluable; a requirement the source does not meet is disclosed instead
of failing the destination. Diagnostics carry the requirement id, a reason code and the
declared role only.

Per-application bindings are applied as a library: each side declares its entry route,
control locators and the unit's visual scope, and `resolveScenarioForSide` produces that
side's executable scenario while refusing any change to the shared semantic projection.
An adapted scope that does not resolve is not evaluable and a control missing inside the
scope still fails, so an adaptation cannot hide it. Wiring the resolved scenario into an
actual run belongs to P3.

Persistence and repeatability closed the milestone: a `READ_BACK` claim requires the
written values to come back from a later read, a read answered by a declared mock is not
evaluable, mocked coverage is disclosed alongside a pass instead of being hidden, and
`verifySourceStability` compares repeated source executions under the declared reset to
produce the reference's `sourceObservations`. An unstable source is reported with codes
and structural locations for the owner to decide; the harness never declares a field
volatile on its own.

This document replaces the former IMPLEMENTATION-STATUS, PROGRESS, global HANDOFF
and MVP-PLAN. Do not recreate them. A migration may keep its own scoped handoff.

## P3 operational increment

`check-projects` now provides preflight-only and authorized baseline/candidate native
checks: declared argv/cwd without implicit shell, minimal environment, time/output
limits and POSIX process-group cleanup. It checks declared input hashes before/after
execution, annotates prior failing checks without making them pass and omits raw output.

PROJECT_PREFLIGHT / PROJECT_CHECK_REPORT are not migration equivalence. Cinema's
actual React build and lint passed through this executor, without changes to its
source/API or the restricted isolated TypeScript gate. The subsequent increments
below add managed servers and suite capture.

Verification of this increment: build PASS, unit/CLI 143/143 serial, both smokes
PASS; actual React build/lint PASS. Browser/pilots not rerun here. See VALIDATION.md.

The next P3 increment adds `withProjectBuildServers`: native required builds from
explicitly disposable output directories, loopback ports reserved before cleaning,
immutable static SPA snapshots, healthchecks and owned-server cleanup. `SERVED_BUILD`
identifies configuration, declared inputs and served files. Disk/input changes
invalidate the session. This is a library, not the consolidated CLI; it does not
execute scenarios/reset or issue migration success. Static builds only, not SSR.
Focused verification: 11/11 new unit tests and 1/1 Chromium test across both sides
and desktop/mobile viewports. Full regression: 168/168 PASS (154 unit/CLI + 14
browser), build and both smokes PASS. No standalone pilot or Cinema build rerun
in this increment. Evidence is in VALIDATION.md.

`captureProjectSuite` now coordinates those builds with declared reset commands,
fresh Chromium contexts, applied bindings and all configured scenarios: repeated
source runs, one target run and per-scenario source stability. The runner checks
the build identity on actual document navigation and supports cancellation without
closing a caller-owned browser. An exclusive public run directory retains the
inventory, per-capture outcomes and CAPTURE_SUITE summary, with hashes and sanitized
evidence paths. Raw events/key stay in memory; comparisons are within this invocation.
COMPLETED means capture completion, never migration equivalence; an unstable source
is disclosed, reset/capture failures remain visible, missing runs stay NOT_RUN and
build/input invalidation prevents successful completion. Reference/report integration
and CLI exposure remain pending. Focused tests: 4 reset/loading + 6 browser PASS.
Browser modules load only when capture is requested, not during native-only commands.
Final verification: build, 178/178 tests (158 unit/CLI + 20 browser), both smokes
and diff check PASS. Standalone pilots and Cinema native builds were not rerun.

## Current product state

| Area | Delivered | Remaining for the standard flow |
| --- | --- | --- |
| Execution | Typed scenarios, fresh Chromium contexts, pre-boot mocks/storage, explicit completion, recorder draining, managed suite capture with bindings, declared resets, cancellation and observed source repeatability | Consolidated verification CLI |
| Comparison | Network shapes/status/params/query/transport, selected payload/response values, unit-scoped semantic assertions with per-application scope, persistence read-back, mocked-coverage disclosure, navigation, storage, ARIA, declared causality, structural diagnostics | Consolidated verification operation |
| Requirements | Mining, evidence import, approved immutable contracts, critical gates, machine-checkable requirement assertions | Optional contract integration with distinct preservation/requirement outcomes |
| Evidence | Sanitization, private raw storage for legacy captures, hashes/audit, versioned reference, source stability observations, build-linked suite capture records | Binding comparison/report to a valid reference and the executed suite |
| Project checks | Native commands via check-projects, baseline comparisons, timeout/cleanup, input preflight and managed builds/reset/capture; restricted gates retained | Baseline/native results in the consolidated migration report |
| Agent workflow | Restricted issued briefs, TS/TSX patch submissions, read-only context, hook and audit | Normal scoped edits and end-to-end standard agent without mandatory briefs |
| Repair | HTTP-method repair and restricted classifier/briefs | Semantic corrections, persistent budgets and implementation versus infrastructure diagnosis |
| Optional adapters | Angular discovery, partial IO/synchronous forms codemods, OpenAPI/structured-test import, HTTP/Docker worker adapters | Not prerequisites for first standard migration |
| Documentation | P0 complete: v0.3 RFC, plan, manual/template, scoped handoff and 21 documents reconciled | Keep availability synchronized as each milestone is verified |

No `--profile` or aggregate verify command exists. `compare` already accepts
optional contract/manifest, but `run` still requires an approved contract and
handles one scenario with apps already running. Apply PASS is not equivalence.
The reference library reads project files but starts no build, server or browser;
the separate check-projects operation runs native checks, not servers. Managed
servers are currently exposed through the engine library only.

## Latest recorded implementation verification

Historical snapshot of the correction/agent cycle subsequently committed through
`27e01b8` and `e54e9f8`, not a rerun of the v0.3 design:

| Check | Recorded result |
| --- | --- |
| Strict workspace build | PASS |
| Unit/CLI suite | 92/92 PASS |
| Chromium suite | 13/13 PASS |
| Both smokes | PASS |
| Deterministic pilot | PASS, artifacts/pilot-5ZpYVI |
| Restricted assistant-protocol pilot | PASS, artifacts/pilot-assistant-WSkbqf |

See [VALIDATION.md](VALIDATION.md) for scope, later documentation checks and probes.
Pilots use synthetic approval and deterministic transformations, not an actual
end-to-end assistant migration. Do not relabel them as v0.3 acceptance.

## Confirmed gaps motivating v0.3

- Different payload string values with the same shape returned EQUIVALENT in a
  synthetic direct-validator probe, even with an approved fixture contract.
  Addressed in P2: value comparison detects it when enabled, and the standard mapping
  enables it. The v0.2 default remains shape-only for compatibility.
- Omitting a required payload field produced NOT_EQUIVALENT but
  REQUIRES_CONTRACT_REVIEW, interrupting an ordinary implementation repair.
- ARIA comparison is broad snapshot comparison; required functionality needs scoped
  semantic checks rather than global WARNING or whole-page blocking parity. Addressed
  in P2: unit-scoped assertions block on their own authority while the global ARIA
  dimension keeps its configured severity.
- Isolated TypeScript uses fixed compiler options, not the destination's tsconfig.
  Cinema's existing React baseline fails that gate on ImportMeta.env while its
  native build passed in preparation.
- Restricted issuance rejects six pseudonym tokens in Cinema's proposed ARIA
  contract. This is a restricted-interface blocker, not a reason to weaken privacy.
- Discovery resolves 1 of 13 Cinema symbols because field inject() is unresolved.
  Helpful future improvement, no longer a prerequisite for standard validation.

## Cinema checkpoint

apps/angular and apps/react exist as independent repositories; migrations/cinema
contains a filled scope, three scenarios, nine sanitized captures and REVIEW
contract proposals. Previous claims that those directories did not exist are obsolete.
Both apps were written for this exercise, not supplied production/third-party code.

Recorded baselines: Angular `11db3f2`, React `b3bfcf5`.
The React edit page is **not implemented**. There is no approved contract, brief,
submission or final equivalence evidence for this unit.

The local handoff now directs continuation to P1-P5, not to mandatory human contract
approval and a fresh brief-only conversation. No policy/scenario/contract changes
or candidate implementation are implied by the documentation transition.
Historical evidence must be revalidated/versioned before serving as a v0.3 reference.
Missing SPEC coverage includes 401, 400-save and other load/save errors.

## Priorities and deferred scope

Next: finish P3 with preservation/requirement comparison and aggregate evidence
bound to the captured suite, managed builds and a valid reference, followed by normal
agent iteration and the Cinema proof. Detailed checkboxes and acceptance are only in
PLAN.md.

Deferred: more Angular codemods/inject() discovery, conditional OpenAPI and arbitrary
test extraction, broader SW/WS/instrumentation and additional artifact operations.
Existing functionality remains supported; do not expand it merely to exhaust the RFC.
A recorded clean-context session is an optional restricted-profile demonstration.

## Environment and continuation

- Tests import dist: build before implementation tests. Node 20.20.1; pnpm absent
  from PATH, use `npx --yes pnpm@10.15.0`. Playwright 1.63.0 with Chromium.
- Private storage requires native Linux modes 0700/0600; /mnt/c does not enforce
  them here. Never inspect raw traces. Same-user access is not sandboxed.
- Docker against a real image remains unverified. Local project execution requires
  an authorized environment; static scanning is not an execution sandbox.
- Restricted hooks/issuance keep their checks. AGENTS.md changes invalidate briefs
  that fingerprint it; reissue, never edit hashes or approved artifacts.
- Existing repair counters are caller-supplied; they are not a persistent budget.
- Reference fingerprints cover declared working-tree inputs, protected destination
  files, scenario fixtures and the configured contract only; `sourceObservations` is
  caller-supplied, and absent stability evidence keeps verification UNVERIFIABLE.
  Revisions are read from `.git` as metadata and fall back to `UNVERSIONED`.
- Inspect crash/stale-lock state before recovery. No cross-file crash transaction
  is promised. Key rotation retains older keys to keep backups recoverable.
- Human accessibility/release review remains distinct from automatic verification.
- No merge/push/source removal is authorized by the new product direction.
