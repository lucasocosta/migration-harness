# Status

Updated: 2026-09-12. Current work is harness maintenance for publication on
`next/angular-forms-and-io`; the owner explicitly authorized corrections, commit
and push. The separate Cinema application repositories are outside this push.

## Current availability

The standard profile is implemented through P4 acceptance. One assistant can
prepare a fixed reference, edit the scoped destination, verify, repair and adopt
controlled reference updates in the same session. Attempts, active verification
time and history persist. Select `profile: "standard"` in MigrationConfig and
record that choice in the specification; there is no `--profile` flag.

Cinema (P5) has a recorded migration PASS and an authorized React commit. P6 has
a recorded integrated PASS for a routeless component and two dependent units.
The Cinema-specific three controlled regressions and complete usability effort
measurement remain open. Do not describe the whole RFC checklist as closed.
See [PLAN](PLAN.md), [public Cinema evidence](CINEMA-EVIDENCE.md), and
[VALIDATION](VALIDATION.md) for current tasks and historical execution records.

| Area | Delivered | Practical limits |
| --- | --- | --- |
| Execution | Typed scenarios, isolated Chromium contexts, pre-boot mocks/storage, explicit completion, checkpoints, bindings, reset and source repeatability | Unsupported capture mechanisms and failed execution remain inconclusive |
| Comparison | Network shapes and selected values, scoped assertions, navigation, storage, persistence read-back, declared expected differences | Mocked coverage is disclosed and does not prove a real backend |
| Evidence | Versioned fixed reference, hashes, build-linked suite records, public structural diagnostics and consolidated report | Fingerprints detect inconsistency, not malicious mutation by the same OS user |
| Project checks | Authorized argv/cwd, bounded execution, baseline checks, managed static builds and servers | Static SPA serving; SSR and real Docker image execution are not verified |
| Iteration | Scoped normal edits, persistent budgets, no-progress detection and controlled reference refresh | File-level scope checks cannot attribute individual edited lines |
| Restricted compatibility | Brief/patch protocol, approval integrity, hooks and deterministic pilots | Restricted repair adapter remains method-only; old evidence is not standard acceptance |
| Optional helpers | Angular discovery, partial IO/forms codemods, OpenAPI/test import and worker adapters | Field-level inject discovery and additional codemods are deferred |

`prepare-migration` PASS establishes a reference; it does not approve a migration.
`verify-migration` emits PASS/FAIL/INCONCLUSIVE, with CLI exit codes 0/4/5.
Standard sessions may refuse completion on scope/budget grounds even when a
nested behavioral report passes. Human integration/release review remains distinct.
See [USAGE](USAGE.md) for complete operations and limits.

## Publication corrections

The missing P5 runtime and tests are committed as `58d0d27`; the earlier clean-HEAD
schema failure is resolved. Publication maintenance adds a browser regression
that copies and verifies the actual component-first example, CI with mandatory
Chromium execution, tracked-file documentation link checks, ignored local agent
settings, and a portable Cinema evidence summary.

Angular packages used by fixtures and compiler helpers are pinned to 20.3.31.
The dependency audit after installation reports zero advisories. The repository
is MIT-licensed as of 2026-09-28 ([LICENSE](../LICENSE)); packages are not
published to npm.
A new same-revision verification is recorded in [PUBLICATION](PUBLICATION.md).
The original [audit](AUDIT-2026-09-12.md) is historical and is not silently rewritten.

## Recorded demonstrations

- P4: the browser acceptance suite demonstrates controlled value, validation and
  navigation failures and repairs, protected-input refusals, budget persistence,
  no-progress stopping and reference updates without resetting history.
- Cinema P5: session `7746d541d4ad0d27d9a86a2f8972c234`, run 0001 PASS,
  36/36 scenarios, 131/131 requirements, 3/3 checks, two of four attempts used.
  Human review and React commit `2c98611` are recorded. APIs were mocked and three
  declared differences remain; this is a synthetic exercise, not production proof.
- Component-first P6: historical run 0000 had Unit A passing and Unit B incomplete;
  run 0001 passed the integrated suite, 5/5 scenarios and 11/11 requirements.
  The committed destination is now implemented and a fresh verification should pass.
  Callback effects are observed through the host DOM; class names are not ARIA assertions.

## Environment and continuation

- Tests import `dist/`; build first. Use Node `^20.19.0`, `^22.12.0` or `>=24.0.0`,
  pnpm 10.15.0, Playwright 1.63.0 and Chromium. CI uses Node 22. If the pnpm shim
  is unavailable, use `corepack pnpm` or `npx --yes pnpm@10.15.0`.
- Private storage prefers enforced 0700/0600 modes (Linux/macOS). On Windows or
  filesystems without POSIX metadata, `--allow-insecure-private-store` enables an
  explicitly disclosed DEGRADED privacy mode (`WEAK_PRIVATE_PERMISSIONS`); it never
  claims isolation guarantees. See docs/OS-PORTABILITY.md. The historical WSL
  browser close stall was avoided with an isolated TMPDIR under `/dev/shm`; that is
  an environment workaround, not relaxed validation.
- Standard budgets count cumulative verification time, excluding preparation,
  editing and idle time. Restricted repair counters are caller-supplied.
- Missing source-stability evidence remains UNVERIFIABLE. Missing Git metadata
  may produce UNVERSIONED. Preserve existing work; inspect crash/stale-lock state
  before recovery. Do not reset a session to avoid budget limits.
- AGENTS.md changes invalidate restricted briefs that fingerprint it; reissue
  through the harness. Never edit approval/brief hashes or read private raw traces.
- Additional codemods, broader service-worker/WebSocket capture, Docker proof and
  a clean-context restricted demonstration remain deferred, not publication gates.
