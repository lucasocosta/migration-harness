# RFC - Migration Harness v0.3

Date: 2026-09-06. Availability updated 2026-09-12: P0-P4 implemented and accepted;
Cinema P5 and component-first P6 have recorded PASS results. The Cinema-specific
three-regression acceptance item remains open; see PLAN.md for its evidence gap.
Supersedes v0.2 as the target specification, not approved contracts. Delivery:
[STATUS.md](STATUS.md). Execution plan: [PLAN.md](PLAN.md).

**Status note (2026-10-03):** the owner retired the restricted profile and the
previous 26-command CLI surface together (owner decision,
[PLAN-V2](PLAN-V2.md) §8.2). The sections that specified that profile — the
`brief`/`apply-patch` protocol and its commands — are marked **withdrawn** below and
trimmed where they were dead weight; rules that still hold for the standard flow are
kept in current terms. The v2 CLI (`init`/`doctor`/`prepare`/`verify`/`status`/
`reference`), its envelope and exit codes are specified in [OPERATOR.md](OPERATOR.md).

## 1. Product objective

The assistant migrates; the harness independently checks observable behavior.
The owner supplies scope and intended differences. The assistant prepares,
implements, compares and repairs using its own coding capabilities.

Initial use cases: Angular page or component into an existing React application;
whole application migration through ordered units and integrated regression.
Preserve the destination's architecture, design system, authentication and existing
functionality. Do not create a replacement React application.

Success is evidence under declared scope and policy, not a formal proof of all
behaviors, pixel identity, accessibility compliance or permission to merge.

## 2. Roles and independence

| Actor | Responsibility |
| --- | --- |
| Owner | Scope, intended differences, sensitive permissions, unresolved business decisions, release approval |
| Assistant | Explore relevant code, prepare scenarios, implement, operate tools, diagnose, repair and explain evidence |
| Harness | Reproducible execution, protected reference, comparisons, checks and attributable results |

One assistant may prepare and transform in one conversation. It may inspect public
synthetic tests. A separate model, fresh conversation and hidden test steps are not
requirements for independent validation. Independence means the evaluator and its
criteria cannot be replaced by the assistant's judgment.

Assistant-authored tests can miss behavior. Expose coverage gaps and exercise
multiple data sets and intentional regressions. A mapping manifest is an optional
diagnostic hint; neither it nor a confidence score can override failing evidence.

## 3. Profiles and transition

**Standard (implemented through P4 acceptance):** normal scoped destination edits,
including styles, assets and tests; one assistant operates the whole lifecycle.
No mandatory submission format, discovery success, codemod or manifest.
Dependency/configuration changes still need declared scope and execution permissions.

**Restricted (WITHDRAWN — retired 2026-10-03):** the issued-workflow protocol and
its CLI commands were removed by owner decision ([PLAN-V2](PLAN-V2.md) §8.2). What
that profile protected still holds for everyone: the harness is the oracle, the
reference and criteria are immutable during ordinary repair, and no agent certifies
its own work — those rules are normative in [AGENTS.md](../AGENTS.md) and enforced by
the standard flow. Recorded sessions of the retired profile are historical evidence
under `docs/archive/`, never a Definition of Done.

Select standard with `profile: "standard"` in config and a recorded SPEC choice;
profile rules are owned by [AGENTS.md](../AGENTS.md), operations by
[OPERATOR.md](OPERATOR.md). Full milestone acceptance remains in PLAN.md.
Never relabel old evidence as current.

## 4. Minimal workflow

```text
Owner's specification
  -> assistant prepares scenarios and project commands
  -> harness checks source reproducibility and fixes a reference
  -> assistant edits the existing target
  -> harness builds/checks, runs the suite and compares
  -> assistant repairs implementation defects -> verify again
  -> consolidated evidence report -> owner reviews integration/release
```

The harness exposes operations and feedback, not model API calls or a mandatory
code generator. Discovery and codemods were retired with the restricted profile
([PLAN-V2](PLAN-V2.md) §8.2); an unsupported Angular construct must not block
validation merely because there is no automatic conversion.

## 5. Specification and reference

One specification identifies source/target roots, functional scope, allowed edits,
integration constraints, commands/cwd, test URLs, scenario inventory, data/reset
strategy, required checks and retry budget. The assistant fills technical details;
the owner need not manually author CLI JSON.

P1 provides versioned runtime-validated configuration and reference schemas plus the
reference collection/verification and change-classification library APIs. The v2
commands `prepare` and `verify` bind them to one resumable session; `status` reads it
and `reference` versions it. Commands and current limitations: OPERATOR.md.

A reference records:
- Source revision and relevant working-tree fingerprints, including untracked inputs.
- Scenario identities, semantic steps, source/target bindings, fixtures and reset.
- Comparison/normalization policy and explicitly intended differences.
- Requirements from the specification/tests and optional approved critical contracts.
- Browser/environment and build configuration affecting observation.
- Independent repeated source executions sufficient to evaluate stability.

Do not discard user changes to obtain a clean tree. Hashes detect inconsistency,
not malicious same-user mutation or authenticated approval. Reuse cached reference
evidence only for matching inputs/environment; otherwise declare it stale.

## 6. Preservation versus requirements

Differential evidence asks whether target preserves observed source behavior.
Critical requirements ask whether desired behavior holds, even if source has a bug.
Report these separately: two equally wrong implementations do not meet a requirement.

The standard profile can compare without a formal approved BehaviorContract.
The owner authorizes preservation in scope; repeated observations do not thereby
become universal business requirements. Mining may suggest assertions, not invent
normative obligations. Approved critical contracts remain optional additional
constraints, immutable during repair and never auto-approved by an agent.

Disclose preserved known legacy defects. A requested legacy fix needs an explicit
expected difference and requirement; neither copy a bug blindly nor normalize it
away without authorization.

## 7. Changes to evaluation inputs

During preparation the assistant creates scenarios/fixtures and checks the source.
After a reference exists:
- Ordinary repair changes target code, not the reference or blocking criteria.
- Added scenarios/data extend coverage in a new reference version, executed on both
  sides while retaining existing required checks and historical results.
- Route/locator bindings may adapt to integration only without changing semantic
  actions or expectations. Record deltas, invalidate affected evidence and rerun both
  sides. Ambiguous mappings require owner review.
- Removing required scenarios/assertions, accepting new differences, broadening ignore
  rules or changing critical requirements requires explicit owner review and a new
  version. Never rewrite past verdicts or approved contracts in place.

Do not turn a failure-to-pass loop into repeated weakening of the test suite.
The v2 `reference` command adopts reference updates into the open session, preserving
history and budgets; a weakening requires an explicit owner decision (OPERATOR §4).

## 8. Scenario execution

Reuse the typed ScenarioRunner and Playwright recorder. Install storage/mocks before
boot, isolate contexts, pre-arm completion signals, correlate requests by identity
and drain asynchronous recording. Completion is explicit, not generic network idle.

Run the same semantic scenario with explicit source/target route and locator bindings.
React need not reproduce Angular's DOM or shell. Bindings cannot point to different
functionality or hide a missing control. Components without routes need scoped test
hosts exercising inputs, outputs and state.

Reset backend/application state between executions, not just the browser. Prefer
synthetic data. Fixed mock success responses do not prove submitted values or
persistence: assert requests and read back a controlled backend when required.
Disclose mocked versus integrated coverage.

Keep origin filtering and opt-in WebSocket/service-worker boundaries. Unsupported
mechanisms and execution failures are explicit. Automatic application-wide causal
instrumentation remains a non-goal.

## 9. Comparison dimensions

| Dimension | Required direction |
| --- | --- |
| Network | Method, route/params/query, counts, completion/status, shapes AND selected relevant values |
| Results/state | Saved values, relevant storage, observable outcomes, read-back for persistence in scope |
| Navigation | Relevant transitions/redirects with explicit aliases; not an unordered URL multiset |
| Forms/interactions | Required/invalid/disabled states, absence of forbidden submission, errors, loading, retry, callbacks |
| UI semantics | Roles/names/states at named checkpoints inside the unit; whole-page ARIA as additional evidence |
| Causality | Declared dependencies, not strict order of independent requests or framework internals |
| Visual/accessibility | Optional screenshot/axe evidence with disclosed human-review limits |

Ignore volatile data only by explicit versioned rules. Preserve meaningful numbers,
booleans, selected strings, absence/null distinctions and relevant array contents.
Required assertions whose values cannot be observed safely are insufficient evidence,
not a pass from matching types.

Sensitive values stay inside protected comparison or appropriate keyed representations.
Public diagnostics expose field paths, types and redacted expected/actual relations.
Show synthetic values only with safe provenance. Never send raw traces to assistants.

## 10. Project checks and execution identity

Use actual destination build/typecheck/lint/test commands and configuration. An
isolated compiler with different options is an optional diagnostic, not a substitute.
Record preexisting failures; they are not new regressions but cannot satisfy a
required check.

One orchestration operation should resolve configuration, run allowed commands,
build/serve matching artifacts, execute ALL required scenarios plus destination
regression and aggregate evidence. Commands require cwd, argv, bounded duration
and process cleanup, within an explicitly authorized local or isolated environment.
No arbitrary commands from runtime/source text; do not kill unrelated servers.
Docker is an optional adapter, unverified in the current environment.

Bind results to reference/configuration hashes, candidate tree/build fingerprint,
served artifact identity and scenario set actually executed. Stale servers, changed
inputs mid-run or missing required scenarios prevent success.

## 11. Results and diagnosis

Aggregate report statuses (P1 schema, delivered by verification):
- PASS: every required check covered and passed for the recorded candidate/reference.
- FAIL: reproducible implementation/requirement regression with sufficient evidence.
- INCONCLUSIVE: stale, unstable, insufficient or unsupported evidence, or execution
  failure that cannot establish the claimed behavior.

Reports include per-scenario/dimension results, safe localized diagnostics, accepted
differences, required-check status, coverage gaps, preexisting failures, attempt
history and evidence paths. Preservation and requirements have separate outcomes
and explicit aggregation rules.

Warnings remain visible; the agent cannot demote required checks. Coverage percentages
refer to a declared inventory, not all possible behavior. Missing a known required
error scenario blocks completion.

Legacy per-scenario verdicts and patch-application results belong to the retired
surface (see the status note); nothing maps them onto aggregate success.

## 12. Repair and escalation

The assistant may correct implementation defects within authorized scope: values,
validation, navigation, callbacks, UI state and project check failures. A contract
violation is not itself a reason to review the contract. Repairs are ordinary edits
inside `target.writePaths`; there is no submission format or byte limit.

Persist attempt history across invocations, enforce time/attempt budgets and detect
lack of progress. Rebuild after edits. Focused checks may guide iterations; final
verification runs the complete required suite against one current candidate.
Do not fill a report with passing results from older candidates.
The current P4 budget counts one initial attempt plus maxRepairAttempts and cumulative
verification time (maxDurationMs), excluding preparation, editing and idle time.
Scope/time guards can refuse a session even if its nested behavioral report passes.

Escalate scope/requirement changes, permission/secret exposure, conflicting criteria,
unsupported evidence, unsafe execution or exhausted/no-progress budgets.
Infrastructure can be repaired within authorized operations; a failed run cannot be
called behavioral success. Harness maintenance is separate from candidate repair
and invalidates affected evidence until revalidation.

## 13. Proportional security

Keep data minimization, raw isolation from the assistant channel, default-deny
sensitive fields, origins, retention, protected evaluation inputs and scope checks.
Hashes, static scans and hooks are not a sandbox against the same user.

Check normal edits as a diff against authorized scope, including new/deleted files,
symlinks and protected paths. Preserve unrelated user edits. Encryption, rotation,
backups and anchoring are
optional operations, not prerequisites for a synthetic local migration.

## 14. Architecture and compatibility

Reuse core schemas (version new formats), runner, recorder, sanitizer, validator,
quality gates and artifacts. Add orchestration/reporting incrementally.
Discovery, codemods and the OpenAPI/test importers were retired with the restricted
profile ([PLAN-V2](PLAN-V2.md) §8.2); bounded workers and manifests live in `core`.
Do not rewrite the monorepo for package topology.

Command/result tests track the v2 surface; the legacy flow and its pilots were
retired with their tests ([PLAN-V2](PLAN-V2.md) §8.2). Nothing may grant authority by
relabeling an old result. See [ARCHITECTURE.md](ARCHITECTURE.md) for delivered
boundaries and responsibilities.

## 15. Definition of Done

One standard assistant session must:
- Start from scoped existing Angular/React repositories and prepare a stable reference.
- Implement a page normally with no mandatory formal contract or submission format.
- Operate consolidated verification and receive safe actionable feedback.
- Detect and repair wrong values, missing validation and wrong navigation, not only
  PUT/POST, without weakening criteria or clerical owner intervention.
- Demonstrate failure/inconclusive handling, protected-input integrity, persisted
  budget, current served build identity and destination regression.
- Deliver an honest report and completed/pending tracking before release review.

Cinema is the first integration exercise, not production/third-party proof.
A component-host and multi-unit integration case follow before claiming those uses.
Measure owner interruptions, manual artifact preparation and verification effort;
the harness should reduce validation work, not transfer it to the owner.

## 16. Decision

Adopt validation-first standard direction. Formal contract approval and recorded
clean-context sessions are not product gates. Protect evidence and requirements, not
a prescribed way of writing React.
[PLAN.md](PLAN.md) defines delivery; [research.md](research/research.md) preserves historical
principles, not an instruction to finish every v0.2 extension first.
