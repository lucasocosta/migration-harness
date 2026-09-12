# Publication maintenance — 2026-09-12

The owner requested review of the other agent's corrections, remaining fixes,
commit and push of the current harness branch. Base revision: `e54c21d`, after
`58d0d27` committed the P5 runtime and `dd47241` reconciled part of the documentation.
The original [audit](AUDIT-2026-09-12.md) remains a historical record.

## Changes

- Pin Angular 20.3.31 in fixture dependencies and the codemods/static-analyzer
  compiler dependencies. Record compatible Node versions and refresh the lockfile.
- Add GitHub Actions for frozen install, dependency audit, tracked documentation
  links, build, serial unit/CLI and browser suites, executable examples, smokes and
  both restricted compatibility pilots. Chromium is installed and preflighted;
  skipped browser tests fail CI. Raw artifacts are not uploaded.
- Add a browser regression using the committed component-first configuration and
  source/target files in an isolated copy. It verifies prepare/start/verify, both
  units' complete coverage and persisted status observed from a new CLI process.
  The existing validation-first browser test exercises PASS -> FAIL -> PASS.
- Reconcile current availability and the already-implemented P6 tutorial. Publish
  a portable [Cinema evidence summary](CINEMA-EVIDENCE.md) and preserve P5's open
  criteria instead of claiming that the P4 fixture or blur fix satisfies them.
- Ignore local assistant settings/indexes. Keep packages private and explicitly
  UNLICENSED; no permissive reuse license is selected on the owner's behalf.

## Verification

Local verification on Node 20.20.1 after the changes:

| Check | Result |
| --- | --- |
| Workspace build | PASS |
| Unit/CLI suite, serial | 190/190 PASS, zero skips |
| Chromium suite, serial | 32/32 PASS, zero skips; includes the new full P6 session test |
| Targeted P6 test | PASS; complete coverage, VERIFIED reference and current persisted report |
| Dependency audit | Zero advisories |
| Documentation links | All tracked local link targets PASS |
| Smokes | Both PASS |
| Deterministic pilot | EQUIVALENT |
| Restricted assistant pilot | ASSISTANT_LOOP_EQUIVALENT, REPAIR_BRIEF->PASS |

The first clean-checkout run used Node 22.23.2. Install/build/docs and all 190
unit/CLI tests passed. Browser checks exposed that the new test assumed an
existing `artifacts/` parent; the test now creates that directory itself.
One capture-suite test also returned INCONCLUSIVE during the parallel run;
the same six capture tests passed when rerun with Node 22 at unchanged limits.
Its original cause was not established; failure assertions now include only safe
structural capture diagnostics. Final browser validation runs separately from
unit/CLI work, matching the order used in CI.

Clean-checkout verification completed on
`27ee47ce87b6112651db51af2dc37671e2e9f9f7`, using a fresh detached worktree,
frozen pnpm 10.15.0 install and Node 22.23.2:

| Clean-checkout check | Result |
| --- | --- |
| Frozen install and workspace build | PASS |
| Chromium suite, run without concurrent unit/CLI work | 32/32 PASS, zero skips, 157.4 s |
| Both smokes | PASS |
| Deterministic / restricted assistant pilots | EQUIVALENT / ASSISTANT_LOOP_EQUIVALENT |
| Dependency audit | Zero advisories |
| Checkout after checks | No tracked changes or untracked non-ignored files |

The 190/190 Node 22 unit/CLI result was obtained on `3cc22d8` in a separate clean
worktree. Package sources, manifests, lockfile and top-level unit/CLI tests are
identical in `27ee47c`; its changes only fix the browser test setup and diagnostic
messages and document that verification. Subsequent edits are documentation and
agent-description reconciliation. Published documentation links were rechecked
against the final tracked file set, with 82 targets passing. A limited scan of 231
tracked files found no recognizable credential-key patterns; this is not a full
history or comprehensive security audit.

No evaluation criterion, budget or timeout was relaxed to obtain these results.
The initial transient capture result remains recorded above. CI runs the suites
sequentially and will independently verify the published revision.

## Remaining product evidence

Publishing this harness does not close the Cinema-specific three-regression
acceptance criterion or supply the missing preparation/owner-intervention
measurement. Those remain in [PLAN](PLAN.md). No Cinema candidate, source,
contract, scenario, policy or existing session was changed or reset in this task.
The demonstrations remain synthetic and do not prove real backend persistence,
production migration, complete accessibility or Docker operation.

The task authorizes a normal push of the harness branch, not a merge, forced
push, permissive licensing decision or publication of the separate applications.

## Publication record

The authorized push to `origin/next/angular-forms-and-io` was confirmed at
`31088ae2a67ff078a5bf9fb8b7826a5814ea719a`; GitHub Actions started run
`34710609341`. The publication-record commit adds only documentation. Each later
push receives its own verification; consult the
[workflow runs](https://github.com/lucasocosta/migration-harness/actions/workflows/ci.yml)
for the result corresponding to the latest branch revision.

No merge, force push or push of either Cinema application repository was performed.
