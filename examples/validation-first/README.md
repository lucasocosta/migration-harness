# Executable validation example

Synthetic Angular and existing-shell React applications using real framework runtimes.
The React candidate is already implemented so the example starts with a passing
comparison; it is not evidence of an autonomous assistant migration. Dependencies
come from the installed harness workspace. The shipped config already carries
`profile: "standard"`, so there is no `init` step. Run from the repository root after
`corepack pnpm build`:

```bash
HARNESS="node packages/cli/dist/index.js"
CFG=examples/validation-first/migration.json

$HARNESS doctor --config "$CFG" --workspace-root . --json
$HARNESS prepare --config "$CFG" --workspace-root . \
  --artifact-path artifacts/example-baseline --allow-project-commands --json
# edit the candidate: examples/validation-first/react/** (target.writePaths: App.tsx)
$HARNESS verify --config "$CFG" --workspace-root . --allow-project-commands --json
$HARNESS status --config "$CFG" --workspace-root . --json
```

`doctor` is the environment preflight and runs no project command; `prepare` opens the
resumable session in one operation (`decision: READY`); the candidate is edited by you,
inside `target.writePaths` — no command edits it; `verify` spends one attempt per run
and, because the session owns the reference and the output, takes neither an
`--artifact-path` nor a preparation path; `status` reads budget, blocks and next action
without spending an attempt. Use a fresh `--artifact-path` for every new `prepare`, and
use `reference` for a versioned reference update (a weakening is refused until the owner
passes `--owner-decision`). Every command supports `--help` and `--help --json`; the
JSON envelope, decisions and exit codes live in
[OPERATOR.md](../../docs/OPERATOR.md).

Ports 4320/4353 must be free; the harness owns and closes both servers. Build outputs
under each app's dist are disposable. No API server is needed: the save response is
explicitly mocked, which proves request/observable behavior, not backend persistence.
Existing destination permissions have a required native regression check; its shell is
checked by a target requirement.

To exercise a regression, change the React request's email value, run `verify` again in
the same session, restore the correct implementation and `verify` once more. Expected
results: FAIL then PASS. Do not edit the source, fixture, policy, requirements or
protected destination files to make the regression pass — repair only the candidate
inside `target.writePaths`. A source or reference change is never a repair: it
surfaces `decision: REVIEW_REFERENCE` and needs a versioned `reference` update (an
owner decision when the change weakens criteria), never an edit of prepared evidence.
Preparation fixes source behavior but does not approve a migration. Verification PASS
applies only to the declared suite, requirements and native checks.
