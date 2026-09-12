# Status

Updated: 2026-09-12. Harness branch: `next/angular-forms-and-io`, pushed to
`origin` with owner authorization. Base of the v0.3 transition: `c663b40`.
P1/P2 libraries committed as `c4f319b`; P3 committed as `5079579` (native checks),
`378d730` (managed builds), `adc61d4` (suite capture) and `75100c9` (consolidated
verification). RFC v0.3 direction is agreed; P0-P4 are implemented. P4 is complete: scoped normal
editing, persistent sessions, a standard agent, controlled session reference updates
and the full value/validation/navigation repair acceptance. P5 (real-migration
proof, Cinema) closed on 2026-09-12: session
`7746d541d4ad0d27d9a86a2f8972c234`, run 0001 (36/36 scenarios, 131/131
requirements, preservation/requirements/projectChecks PASS, 2/4 attempts), full
suite on the same build (190/190 unit/CLI, 31/31 browser, smokes, both pilots),
human review approved with both apps served side by side, candidate committed
to apps/react as `2c98611` with explicit authorization (no merge/push).
P6 closed the same day: `examples/component-first/` demonstrates the routeless
component use case (hosts on both sides, props/callback/keyboard/limits/design
system) and two ordered units (A -> B) with per-unit and integrated verification
(run 0000 INCONCLUSIVE -> run 0001 PASS, 5/5 scenarios, 11/11 requirements,
zero diagnostics); manual/template updated with the measured example, closing
the three standard use cases. The RFC v0.3 checklist is complete; further work is
owner-directed. [PLAN.md](PLAN.md)
is the single ordered checklist; [migrations/cinema/units.md](../migrations/cinema/units.md)
carries the Cinema evidence and VALIDATION.md the P6 evidence.

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

The consolidated operation completes P3: `prepare-migration` fixes a verified
versioned reference from a source-only capture with declared resets, exclusive
artifacts and an owned private pseudonymization key; `verify-migration` re-checks
that preparation against the destination (native candidate checks compared to the
baseline, a fresh full suite, preservation, requirement assertions, optional
critical contract) and emits a consolidated `MIGRATION_REPORT` with a readable
summary. Stale evidence, build mismatch, source drift or tampering fail closed;
weakening criteria still requires an explicit owner decision.
`examples/validation-first/` is an executable standard example: prepare PASS ->
verify PASS -> controlled regression FAIL (`BEHAVIOR_DIVERGENCE`) -> restore ->
verify PASS. Verification: build PASS; 7/7 new unit and 1/1 new browser tests;
full regression 186/186 (165 unit/CLI + 21 browser); both smokes;
`git diff --check` PASS. No real migration has been verified by this operation yet.

## P4 session increment

Explicit config `profile: "standard"` selects ordinary scoped edits, including
CSS/assets/tests, with `start-migration-session` and `migration-session-status`.
`verify-migration` then uses the frozen session reference/output and persistent
budget. Source/offscope destination changes are refused without reverting anything;
the initial snapshot includes existing uncommitted/untracked user work. A candidate
change during verification prevents COMPLETE even when its nested report passes.

Attempts and active verification time persist in exclusive hash-linked records.
Repeated identical failed candidate/diagnostics stop for no progress; interrupted
attempts do not reset budgets. Implementation failures request repair, not blanket
contract review. Only COMPLETE with lastReportMatchesWorkspace=true supports delivery.
The new `migracao-padrao` agent operates this loop; restricted agents/hook are unchanged.

Limits: file-level scope, not line ownership or a sandbox; private metadata is opaque,
dependency/generated directories excluded. No automatic crash/reset/archive operation.
Session reference updates preserving budgets are implemented (`update-migration-session`:
coverage/binding updates, weakening with an explicit owner decision, chained
`generations.json`, superseded results invalidated); the complete value/validation/
navigation repair acceptance is demonstrated in
tests/browser/migration-acceptance.test.mjs. No Cinema migration performed.
See USAGE.md for operational limits and VALIDATION.md for test evidence.

## Current product state

| Area | Delivered | Remaining for the standard flow |
| --- | --- | --- |
| Execution | Typed scenarios, fresh Chromium contexts, pre-boot mocks/storage, explicit completion, recorder draining, managed suite capture with bindings, declared resets, cancellation and observed source repeatability, and the consolidated prepare/verify CLI with managed builds | Exercised by Cinema P5 (run 0001 PASS, committed `2c98611`) and the P6 component-first example (run 0001 PASS) |
| Comparison | Network shapes/status/params/query/transport, selected payload/response values, unit-scoped semantic assertions with per-application scope, persistence read-back, mocked-coverage disclosure, navigation, storage, ARIA, declared causality, structural diagnostics | Exercised by Cinema P5 (run 0001 PASS) and the P6 component-first example (callbacks via rendered host effects) |
| Requirements | Mining, evidence import, approved immutable contracts, critical gates, machine-checkable requirement assertions | Exercised by Cinema P5 (run 0001 PASS) and P6 (11 unit-scope requirements); no contract weakening without owner decision |
| Evidence | Sanitization, private raw storage for legacy captures, hashes/audit, versioned reference, source stability observations, build-linked suite capture records, consolidated report bound to a verified reference and the executed suite | Exercised by Cinema P5 (run 0001 PASS) and P6 (reference STABLE, zero diagnostics) |
| Project checks | Native commands via check-projects, baseline comparisons, timeout/cleanup, input preflight and managed builds/reset/capture; baseline/native results integrated in the consolidated migration report; restricted gates retained | Exercised by Cinema P5 (run 0001 PASS) and P6 (design-system regression check) |
| Agent workflow | Standard scoped edits, persistent sessions, standard agent, controlled session reference updates (coverage/binding, weakening with owner decision) and the complete repair acceptance; restricted briefs/hook/audit retained | Exercised by Cinema P5 and P6 (run 0000 -> run 0001 PASS in both) |
| Repair | Standard implementation/environment/reference decisions, semantic edits, persistent limits; restricted HTTP-method adapter retained | Cinema P5 exercised it (1 authorized repair, run 0000 INCONCLUSIVE -> run 0001 PASS); P6 exercised it again (unit B integration, run 0000 -> run 0001 PASS) |
| Optional adapters | Angular discovery, partial IO/synchronous forms codemods, OpenAPI/structured-test import, HTTP/Docker worker adapters | Not prerequisites for first standard migration |
| Documentation | P0 complete: v0.3 RFC, plan, manual/template, scoped handoff and 21 documents reconciled | Keep availability synchronized as each milestone is verified |

The consolidated `prepare-migration`/`verify-migration` commands exist with exit
codes 0 PASS / 4 FAIL / 5 INCONCLUSIVE. The restricted profile is unchanged:
`compare` accepts optional contract/manifest, `run` still requires an approved
contract and one scenario with apps already running, and apply PASS is not
equivalence. Preparation PASS fixes the baseline and approves no migration.
No CLI profile flag exists; standard is a config field. Restricted commands keep their checks.

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
  P4 now routes standard report failures to REPAIR_IMPLEMENTATION; restricted
  classification remains unchanged.
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

Recorded baselines: Angular `11db3f2`, React `b3bfcf5`. Historical claims that
the React edit page was not implemented are obsolete: `src/paginas/FilmeEditar.tsx`
and `src/rotas.tsx` are implemented inside the session's write paths and validated
by the harness.

2026-09-12 P5 execution checkpoint: standard profile, session
`7746d541d4ad0d27d9a86a2f8972c234` (generation 0, reference `p5-prepared-02`
VERIFIED, 36 scenarios/131 requirements). Run 0000 INCONCLUSIVE (6 STEP_FAILED at
the salvar step: blur-induced button displacement prevented the first click from
submitting). Synthetic probe localized the defect; authorized repair in
`FilmeEditar.tsx` (mousedown preventDefault while validation errors exist,
validations preserved). Run 0001: PASS — preservation/requirements/projectChecks
PASS, 36/36 scenarios, 131/131 requirements, 3/3 checks, 2/4 attempts used.
Declared expected differences remain (trim x2, fractional duration) plus 2
non-blocking ARIA_SEMANTICS_MISMATCH warnings for human review. Coverage ran
against mocked APIs (MOCKED_COVERAGE disclosed). Final suite on the same build:
190/190 unit/CLI, 31/31 browser, both smokes, pilot EQUIVALENT,
pilot-assistant ASSISTANT_LOOP_EQUIVALENT. Human code/accessibility review
completed on 2026-09-12 with both apps served side by side: sides declared
identical, ARIA warnings resolved by inspection, no findings. Authorized commit
remains pending; no merge/push.

The local handoff now directs continuation to P1-P5, not to mandatory human contract
approval and a fresh brief-only conversation. No policy/scenario/contract changes
or candidate implementation are implied by the documentation transition.
Historical evidence must be revalidated/versioned before serving as a v0.3 reference.
Missing SPEC coverage includes 401, 400-save and other load/save errors.

2026-09-08 preparation checkpoint at harness `4c7332f`: both app baselines are
unchanged and clean. Missing local dependencies were restored with `npm ci`
from existing lockfiles. Adoption of standard execution is pending the owner
response because the local SPEC still authorizes only the documentation transition.
Source inspection found conflicts with the required trimming of title/synopsis and
integer duration validation. A public synthetic diagnostic and coverage inventory
are in `migrations/cinema/P5-PREPARATION.md`; validation is recorded in VALIDATION.md.
Resolve those conflicts before fixing the reference; no candidate/session exists.

## Priorities and deferred scope

Next: P6 is closed (component-first example, run 0001 PASS, docs updated); the
Cinema proof is closed (commit `2c98611` in apps/react, human review approved).
Remaining work is owner-directed only: the RFC v0.3 checklist is complete.

Deferred: more Angular codemods/inject() discovery, conditional OpenAPI and arbitrary
test extraction, broader SW/WS/instrumentation and additional artifact operations.
Existing functionality remains supported; do not expand it merely to exhaust the RFC.
A recorded clean-context session is an optional restricted-profile demonstration.

## Environment and continuation

- Tests import dist: build before implementation tests. Node 20.20.1; pnpm is
  present on PATH but its shim fails with "Permission denied" in `npm test` and
  the pilot scripts; `npm run build` works and `node --test tests/*.test.mjs`,
  `node --test tests/browser/*.test.mjs` and `node scripts/pilot*.mjs` run
  directly. Playwright 1.63.0 with Chromium.
- Private storage requires native Linux modes 0700/0600; /mnt/c does not enforce
  them here. Never inspect raw traces. Same-user access is not sandboxed.
- Docker against a real image remains unverified. Local project execution requires
  an authorized environment; static scanning is not an execution sandbox.
- Restricted hooks/issuance keep their checks. AGENTS.md changes invalidate briefs
  that fingerprint it; reissue, never edit hashes or approved artifacts.
- Restricted repair counters are caller-supplied; standard sessions persist their
  own counters and accumulated verification time (editing/idle time excluded).
- Reference fingerprints cover declared working-tree inputs, protected destination
  files, scenario fixtures and the configured contract only; `sourceObservations` is
  caller-supplied, and absent stability evidence keeps verification UNVERIFIABLE.
  Revisions are read from `.git` as metadata and fall back to `UNVERSIONED`.
- Inspect crash/stale-lock state before recovery. No cross-file crash transaction
  is promised. Key rotation retains older keys to keep backups recoverable.
- Human accessibility/release review remains distinct from automatic verification.
- No merge/push/source removal is authorized by the new product direction.
