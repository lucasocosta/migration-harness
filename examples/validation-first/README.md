# Executable validation example

Synthetic Angular and existing-shell React applications using real framework runtimes.
The React candidate is already implemented so the example starts with a passing
comparison; it is not evidence of an autonomous assistant migration. Dependencies
come from the installed harness workspace. Run from the repository root after build:

```bash
node packages/cli/dist/index.js prepare-migration --help
node packages/cli/dist/index.js prepare-migration --config examples/validation-first/migration.json --workspace-root . --artifact-path artifacts/example-preflight --preflight-only
node packages/cli/dist/index.js prepare-migration --config examples/validation-first/migration.json --workspace-root . --artifact-path artifacts/example-baseline --allow-project-commands
node packages/cli/dist/index.js verify-migration --config examples/validation-first/migration.json --workspace-root . --artifact-path artifacts/example-verify --preparation artifacts/example-baseline/preparation.json --allow-project-commands
```

Use a new artifact directory each time. Ports 4320/4353 must be free; the harness
owns and closes both servers. Build outputs under each app's dist are disposable.
No API server is needed: the save response is explicitly mocked, which proves
request/observable behavior, not backend persistence. Existing destination permissions
have a required native regression check; its shell is checked by a target requirement.

To exercise a regression, change the React request's email value, verify into a new
directory with the SAME preparation, restore the correct implementation and verify
again. Expected results: FAIL then PASS. Do not edit the source, fixture, policy,
requirements or protected destination files to make the regression pass. A source or
reference change yields INCONCLUSIVE and requires explicit preparation/versioning.
Preparation fixes source behavior but does not approve a migration. Verification
PASS applies only to the declared suite, requirements and native checks.
