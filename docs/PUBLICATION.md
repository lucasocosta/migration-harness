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
| Documentation links | 80 tracked targets checked, PASS |
| Smokes | Both PASS |
| Deterministic pilot | EQUIVALENT |
| Restricted assistant pilot | ASSISTANT_LOOP_EQUIVALENT, REPAIR_BRIEF->PASS |

The final commit will also be installed and verified in a separate clean checkout.
The clean-checkout revision and results will be recorded after that verification.

## Remaining product evidence

Publishing this harness does not close the Cinema-specific three-regression
acceptance criterion or supply the missing preparation/owner-intervention
measurement. Those remain in [PLAN](PLAN.md). No Cinema candidate, source,
contract, scenario, policy or existing session was changed or reset in this task.
The demonstrations remain synthetic and do not prove real backend persistence,
production migration, complete accessibility or Docker operation.

The task authorizes a normal push of the harness branch, not a merge, forced
push, permissive licensing decision or publication of the separate applications.
