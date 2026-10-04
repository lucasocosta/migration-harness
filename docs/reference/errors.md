# CLI error catalog

Single source of truth: `packages/cli/src/errors.ts` (`ERROR_CATALOG`). This table is generated
from that catalog — edit the catalog, never this file. Every entry is `{ code, category, cause, action, retryable }`.

## Reading a failure

Text mode (default) prints three lines on **stderr**:

```
ERROR ARTIFACT_NOT_FRESH: The artifact directory already exists from another run.
  category: STATE | retryable: no
  action: Choose a fresh --artifact-path; outputs are never reused or overwritten.
```

`--json` mode prints the same entry as one envelope object on **stderr** (stdout stays a pure
result channel, so a result and a failure can never be interleaved):

```json
{"ok":false,"error":{"code":"ARTIFACT_NOT_FRESH","category":"STATE","cause":"The artifact directory already exists from another run.","action":"Choose a fresh --artifact-path; outputs are never reused or overwritten.","retryable":false}}
```

- `cause` is the catalog cause; when the failure carries extra detail (a flag name, an errno, a
  schema issue) it is appended after ` | ` — already sanitized.
- Stack traces are never printed. Private-domain paths (`.migration-private`, the private state
  directory), pseudonymized tokens (`p_` + 24 hex) and trace payloads are redacted, then re-checked
  with the same `screenPatchContent` screen the privacy boundary uses; anything still flagged is withheld.
- `retryable: yes` means the same invocation can succeed unchanged once the stated condition is
  gone. It never means the harness will retry for you.

## Exit codes (immutable)

| Code | Meaning |
| --- | --- |
| 0 | success (a request for help is never an error). |
| 1 | invalid input, refused operation or unexpected error. |
| 3 | refused: a session refusal or stop (it prevails over a PASS report). |
| 4 | evaluation FAIL with no higher-priority stop (including a failing required native check). |
| 5 | INCONCLUSIVE: evidence could not decide. |

## Catalog

107 codes.

| code | category | retryable | cause | action |
| --- | --- | --- | --- | --- |
| `ABORTED` | EXECUTION | yes | The run was interrupted by a signal. | Re-run when the environment is quiet; budgets already spent stay spent. |
| `ARTIFACT_AUTH_FAILURE` | STATE | no | A stored artifact failed its seal or integrity check. | Treat the artifact as tampered: restore it or re-capture; do not hand-edit sealed files. |
| `ARTIFACT_NOT_FRESH` | STATE | no | The artifact directory already exists from another run. | Choose a fresh --artifact-path; outputs are never reused or overwritten. |
| `AUDIT_CHAIN_CORRUPT` | STATE | no | The audit hash chain fails verification. | Restore the audit file from a trusted copy or rebuild it from a known head; never hand-edit. |
| `BASELINE_MISMATCH` | STATE | no | The build identity does not match the recorded baseline. | Rebuild from the declared inputs, or re-prepare if the baseline legitimately changed. |
| `BOOT_FAILED` | ENVIRONMENT | yes | The browser could not boot for a capture. | Verify Chromium availability for this environment; see docs/OS-PORTABILITY.md. |
| `BUDGET_EXHAUSTED` | EXECUTION | no | The session attempt or active-time budget is exhausted, so the session stopped. | Stop for a human decision; budgets are immutable and are never reset silently. |
| `BUILD_CHECK_FAILED` | ENVIRONMENT | yes | A declared build or check command failed. | Fix the failing command; its exit status is reported without raw output. |
| `BUILD_DISK_CHANGED` | ENVIRONMENT | yes | The build directory changed on disk during the run. | Quiesce other tooling touching the build directory and retry. |
| `BUILD_IDENTITY_MISMATCH` | EXECUTION | no | The served build does not match the expected build identity. | Rebuild both sides from the declared inputs and re-run. |
| `BUILD_INPUT_CHANGED` | ENVIRONMENT | yes | Build inputs changed while the build was running. | Quiesce writers and rebuild; a moving input set cannot be fingerprinted. |
| `BUILD_OUTPUT_MISSING` | ENVIRONMENT | no | The build produced no usable output. | Verify the build command and the output directory it writes to. |
| `BUILD_OUTPUT_TOO_LARGE` | ENVIRONMENT | no | Build output exceeds the size budget. | Exclude generated bulk from the output, or split the build. |
| `BUILD_OUTPUT_UNSAFE` | ENVIRONMENT | no | Build output contains unsafe entries (links, oversize or key-like files). | Clean the output directory; only regular files of bounded size are accepted. |
| `CAPTURE_ABORTED` | EXECUTION | yes | The capture was aborted before completing. | Re-run the capture once the interruption cause is gone. |
| `CAPTURE_INCOMPLETE` | EXECUTION | yes | The capture finished without recording every declared step. | Re-run the scenario; incomplete evidence can never become a PASS. |
| `CAPTURE_MISMATCH` | EXECUTION | no | A capture does not match its recorded identity or step list. | Investigate the identity mismatch before trusting any comparison result. |
| `CAPTURE_UNAVAILABLE` | EXECUTION | yes | A prepared capture is unavailable for the current identity. | Re-run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> so reference captures match the current build identity. |
| `COMPLETION_FAILED` | EXECUTION | yes | The scenario did not reach its completion state. | Fix the application flow or the scenario definition, then re-run. |
| `ENCRYPTION_REQUIRED` | CONFIGURATION | no | The operation needs an encryption-enabled private store. | Use a private store created with encryption enabled; the harness never widens permissions implicitly. |
| `EVALUATION_INPUT_IN_WRITE_SCOPE` | CONFIGURATION | no | target.writePaths covers fixtures or the critical contract. | Remove evaluation inputs from target.writePaths so candidates cannot edit them. |
| `EVIDENCE_CHANGED` | STATE | yes | An evidence file changed while it was being read. | Stop concurrent writers and re-run against stable evidence. |
| `EVIDENCE_UNAVAILABLE` | STATE | no | An evidence file is missing, linked or over the size cap. | Provide a regular evidence file within the cap. |
| `EXECUTION_NOT_AUTHORIZED` | AUTHORIZATION | no | Project commands were not authorized for this invocation. | Add --allow-project-commands in an authorized local environment, or run doctor --config <migration.json> --workspace-root <dir>, which inspects the environment without executing project commands. |
| `FILESYSTEM_ERROR` | ENVIRONMENT | no | A filesystem operation failed. | Check permissions, free space and the path in the cause, then retry. |
| `HEALTHCHECK_FAILED` | ENVIRONMENT | yes | The application failed its readiness health check. | Verify the served URL answers on the declared port before re-running. |
| `INPUT_FILE_CHANGED` | INPUT | yes | The input file changed while it was being read. | Stop concurrent writers and re-run against stable inputs. |
| `INPUT_FILE_INVALID` | INPUT | no | The input path is not a regular, usable file. | Point the flag at a regular file of the expected kind. |
| `INPUT_FILE_MISSING` | INPUT | no | A referenced input file does not exist. | Create the file or point the flag at an existing path. |
| `INPUT_FILE_NOT_JSON` | INPUT | no | The input file does not contain JSON. | Provide a JSON document at that path. |
| `INPUT_FILE_SYMLINK` | INPUT | no | The input resolves through a symlink, which the boundary refuses. | Pass the resolved real path; symlinks are never accepted at the read boundary. |
| `INPUT_FILE_UNREADABLE` | INPUT | no | The input file cannot be read with the current permissions. | Fix the file permissions or run as the owner of that file. |
| `INVALID_FLAG` | INPUT | no | A flag value is not valid for its option. | Correct the value named after "Invalid --"; see `<command> --help` for the accepted range. |
| `INVALID_INPUT` | INPUT | no | An input document failed schema validation. | Fix the fields named in the cause; the schema is the contract for that document type. |
| `INVALID_JSON` | INPUT | no | An input file is not valid JSON. | Fix or regenerate the file; the parser reports the position, never the content. |
| `INVALID_PSEUDONYMIZATION_KEY` | CONFIGURATION | no | The pseudonymization key is missing, too short or malformed. | Supply a 32-byte hex key, or let the harness create one in the private store. |
| `KEY_MISMATCH` | STATE | no | The stored private key does not match the preparation that used it. | Use the same private store as the preparation, or re-prepare with this store. |
| `KEY_PRUNING_DISABLED` | CONFIGURATION | no | Automatic key pruning is disabled because retained copies may still need old key versions. | Retire the retained copies that still need an old key version first; pruning stays off until none does. |
| `MISSING_FLAG` | INPUT | no | A flag required by this command was not provided. | Re-run with the flag named after "Required flag"; `<command> --help` lists required flags. |
| `MISSING_PREPARATION_PATH` | CONFIGURATION | no | The preparation path argument was not provided. | Provide `preparationPath`: the artifact written by prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir>. |
| `NO_PROGRESS_STOP` | EXECUTION | no | Repeated identical failures stopped the session before it consumed the whole budget. | Investigate the repeated failure before another attempt; a stopped session never restarts by itself. |
| `OUTPUT_EXISTS` | INPUT | no | The destination already exists; outputs are created exclusively. | Remove or rename the destination, or choose another --out path. |
| `OUTSIDE_WRITE_SCOPE` | STATE | no | The workspace changed outside the declared target write scope, so the session refused the attempt. | Move the change inside target.writePaths (or reconcile the scope with the owner), then retry. |
| `PORT_IN_USE` | ENVIRONMENT | yes | A declared port is already occupied. | Free the port or change it in the configuration, then retry. |
| `PREPARATION_HASH_MISMATCH` | STATE | no | The preparation artifact does not match its own reference hash. | Re-run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> to produce a consistent preparation artifact. |
| `PRIVACY_SCREENING_REFUSAL` | INPUT | no | Privacy screening refused the content: a pseudonymized token, a trace-derived value or a private-domain path. | Derive behavior from the source unit, never from observed data; drop the token or path. |
| `PRIVATE_KEY_UNAVAILABLE` | STATE | no | The private pseudonymization key is missing or not private enough. | Restore the key from the private store, or re-prepare in an environment that owns it. |
| `PRIVATE_PATH_REFUSED` | INPUT | no | A path points into the private artifact domain or the private state directory. | Use a public path outside `.migration-private` and the private state root; see docs/OS-PORTABILITY.md. |
| `PRIVATE_WORKSPACE` | CONFIGURATION | no | The workspace sits inside the private artifact domain. | Move the workspace outside the private domain; the harness never operates there. |
| `REFERENCE_CHANGE_REQUIRES_OWNER_DECISION` | AUTHORIZATION | no | The reference change weakens evaluation criteria. | Ask the owner for a decision and re-run reference --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> with --owner-decision <reference>; never weaken silently. |
| `REFERENCE_COVERAGE_MISMATCH` | STATE | no | The prepared reference does not cover every scenario/run the config declares. | Re-run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> so coverage matches the configuration. |
| `REFERENCE_EVIDENCE_CHANGED` | STATE | no | A prepared reference trace no longer matches its recorded hash. | Re-prepare; prepared evidence is immutable and must not be edited in place. |
| `REFERENCE_STATE_EVIDENCE_CHANGED` | STATE | no | A prepared reference state snapshot no longer matches its record. | Re-prepare; state evidence is immutable once the reference is built. |
| `REFERENCE_STATE_EVIDENCE_INCOMPLETE` | STATE | no | A prepared reference state pin is incomplete. | Re-prepare with complete state evidence, or drop the incomplete pin from the config. |
| `SCOPE_CHANGED_DURING_READ` | STATE | yes | Files changed while the scope snapshot was being read. | Quiesce writers and re-run once; a moving scope cannot be fingerprinted. |
| `SCOPE_HARD_LINK` | STATE | no | A scoped file has hard links, so its identity cannot be pinned. | Break the hard links before verifying; scope entries must have nlink 1. |
| `SCOPE_ROOT_MISMATCH` | STATE | no | The observed scope roots differ from the recorded baseline. | Reconcile the roots with the baseline, or start a new migration for the new layout. |
| `SCOPE_SIZE_LIMIT` | STATE | no | The workspace scope exceeds the entry/byte budget for a snapshot. | Exclude generated content from scope, or raise the declared scope with the owner. |
| `SERVED_BUILD_MISMATCH` | EXECUTION | no | The served build does not match the expected build identity. | Rebuild both sides from the declared inputs and re-run. |
| `SERVER_EXITED_EARLY` | ENVIRONMENT | yes | The served process exited before readiness. | Inspect the serve command output; the exit code is reported without child logs. |
| `SERVER_READY_TIMEOUT` | ENVIRONMENT | yes | The served application did not become ready in time. | Raise the readiness window or fix startup cost, then retry. |
| `SERVER_START_FAILED` | ENVIRONMENT | yes | The serve command failed to start. | Check the serve command in the configuration and start it manually to see the failure. |
| `SERVE_COMMAND_INVALID` | ENVIRONMENT | no | The serve executable or working directory is unusable. | Fix the serve argv/cwd; the harness runs commands by argv, never through a shell. |
| `SERVE_CONFIG_INVALID` | ENVIRONMENT | no | The serve declaration is invalid. | Fix the serve command fields in the configuration. |
| `SERVING_CONFIG_MISSING` | ENVIRONMENT | no | The side being served declares no serve command. | Add a serve command for that side in the configuration. |
| `SESSION_ALREADY_EXISTS` | STATE | no | A session already exists for this source/target pair. | Inspect it with status --config <migration.json> --workspace-root <dir>; sessions are never reset by starting again. |
| `SESSION_ATTEMPT_OPEN` | STATE | no | A previous attempt never recorded its finish. | Inspect the session; an open attempt must be finished or recovered before a new one. |
| `SESSION_DATA_CHANGED` | STATE | yes | A session file changed while it was being read. | Stop concurrent harness runs against this session and retry once. |
| `SESSION_DATA_INVALID` | STATE | no | A session file is not a valid session record. | Repair the session store from a trusted copy, or escalate for human recovery. |
| `SESSION_GENERATIONS_INVALID` | STATE | no | The session generation ledger failed verification. | Escalate for human recovery of the session store. |
| `SESSION_HISTORY_INVALID` | STATE | no | The recorded attempt history does not chain consistently. | Escalate for human recovery of the session store; never reset history to bypass it. |
| `SESSION_INPUT_MISMATCH` | STATE | no | The submitted configuration does not match the session that owns it. | Use the configuration the session was started with, or update the reference explicitly. |
| `SESSION_LIMITS_IMMUTABLE` | STATE | no | Session attempt/time budgets cannot change after start. | Keep limits as declared; a new migration needs a new session, not bigger budgets. |
| `SESSION_OVERLAPS_PROJECT_INPUTS` | STATE | no | The session store overlaps source, target, fixtures or contract paths. | Move the session store outside every declared project input. |
| `SESSION_PAIR_CHANGED` | STATE | no | The source/target pair changed after the session started. | Keep the pair fixed; a different pair is a different migration. |
| `SESSION_PATH_UNSAFE` | STATE | no | The session store path is a symlink or otherwise unsafe. | Remove the symlink and restore a real directory as the session store. |
| `SESSION_REFERENCE_NOT_VERIFIED` | STATE | no | The session reference no longer verifies against the evidence. | Re-prepare to establish a fresh, verifiable reference. |
| `SESSION_REFERENCE_UPDATE_INCONCLUSIVE` | STATE | yes | The proposed reference update could not be verified. | Collect the missing evidence and propose the update again. |
| `SESSION_REFERENCE_UPDATE_OUT_OF_SCOPE` | AUTHORIZATION | no | The requested reference update leaves the authorized scope. | Restrict the update to the authorized scope, or escalate to the owner. |
| `SESSION_REPORT_INVALID` | STATE | no | A recorded attempt report does not match its hash or outcome. | Escalate for human recovery; the recorded result cannot be trusted as-is. |
| `SESSION_SCOPE_CHANGED_DURING_UPDATE` | AUTHORIZATION | yes | The observed scope changed while the update was being adopted. | Quiesce writers and propose the update again. |
| `SESSION_SCOPE_EXPANSION_NOT_AUTHORIZED` | AUTHORIZATION | no | The update would expand the target write scope. | Get explicit owner authorization before expanding target.writePaths. |
| `SESSION_TIMEOUT` | EXECUTION | no | The session ran out of its active-time budget. | Stop for a human decision; budgets are immutable and never reset silently. |
| `STANDARD_PROFILE_REQUIRED` | CONFIGURATION | no | The operation requires profile: standard in the configuration. | Set profile: standard in the configuration; prepare/verify/status/reference refuse any other profile. |
| `STANDARD_SESSION_OWNS_REFERENCE_AND_OUTPUT` | CONFIGURATION | no | The session owns reference and output, so sessionless inputs were refused. | Drop the sessionless `preparationPath`/`artifactPath` inputs and run verify --config <migration.json> --workspace-root <dir>. |
| `STANDARD_SESSION_PROFILE_REQUIRED` | CONFIGURATION | no | A standard session already owns this migration; sessionless inputs are refused. | Drop the sessionless `preparationPath`/`artifactPath` inputs and let the session own reference, output and budget. |
| `STANDARD_SESSION_REQUIRED` | CONFIGURATION | no | The operation requires an existing standard session. | Run prepare --config <migration.json> --workspace-root <dir> --artifact-path <new-relative-dir> to open the session, then retry the operation. |
| `STATE_CLAIMS_INVALID` | STATE | no | Declared state claims are malformed. | Fix the claim records; claims are declarations, never observations. |
| `STATE_DECLARATION_INVALID` | CONFIGURATION | no | A declared state capture or probe is malformed or unresolved. | Fix the declaration named in the cause; declarations are configuration, not observations. |
| `STATE_EVIDENCE_INVALID` | STATE | no | State snapshot evidence is malformed or incomplete. | Re-capture state evidence; incomplete evidence can never become a PASS. |
| `STEP_FAILED` | EXECUTION | yes | A scenario step failed. | Fix the application or the scenario; the failing step id is reported. |
| `SUITE_PREFLIGHT_FAILED` | ENVIRONMENT | no | Project preflight failed before any capture ran. | Run doctor --config <migration.json> --workspace-root <dir> to see which declared input is not ready; it executes no project command. |
| `SUITE_UNAVAILABLE` | STATE | yes | The capture suite could not run or failed before producing evidence. | Fix the failure named in the cause (builds, serve, browser) and re-run. |
| `SYSTEM_ERROR` | ENVIRONMENT | yes | A system call or network operation failed. | Check the errno in the cause (dependency reachable, resources available) and retry. |
| `UNCLASSIFIED` | UNCLASSIFIED | no | The harness reported a code that is not in the published catalog. | Report the invocation and this code; docs/reference/errors.md lists every published code. |
| `UNEXPECTED_ERROR` | INTERNAL | no | An unexpected failure outside the published catalog. | Inspect the cause (already sanitized), re-run once if it looks transient, otherwise report this code. |
| `UNKNOWN_COMMAND` | INPUT | no | The invoked command does not exist. | Run `harness help` (or `harness --help`) for the full command list. |
| `UNKNOWN_OPTION` | INPUT | no | The option is not recognized by this command. | Remove it or check the spelling against `<command> --help`. |
| `UNSAFE_BUILD_DIRECTORY` | ENVIRONMENT | no | A build output directory is a symlink, overlapping or unsafe. | Point builds at a real, dedicated output directory. |
| `UNSAFE_INITIAL_WRITE_SCOPE` | CONFIGURATION | no | The initial target write scope is not exactly the declared one. | Reconcile target.writePaths with the filesystem before starting the session. |
| `UNSAFE_OPERATION_OUTPUT` | CONFIGURATION | no | The artifact output would overlap source, target, fixtures or the critical contract. | Choose an --artifact-path outside every declared project input. |
| `UNSAFE_REFERENCE_UPDATE_SCOPE` | CONFIGURATION | no | A reference update would leave the declared write scope. | Keep the update inside target.writePaths, or escalate to an owner decision. |
| `UNSAFE_SCOPE_ROOT` | CONFIGURATION | no | A source/target root is a symlink or does not resolve to itself. | Use a real directory as the root; do not link the workspace roots. |
| `UNSAFE_SUITE_OUTPUT` | CONFIGURATION | no | The capture suite output would overlap source, target or fixture inputs. | Choose an artifact root outside every declared project input. |
| `UNSAFE_SYMLINK` | INPUT | no | A symlink crosses a boundary the harness requires to be a real path. | Pass the resolved real path and keep symlinks out of artifact, reference and scope roots. |
| `UNSAFE_WRITE_SCOPE` | CONFIGURATION | no | target.writePaths contains an opaque path or a non-writable directory. | Declare concrete, relative, writable paths in target.writePaths. |
| `UNSUPPORTED_SCOPE_ENTRY` | STATE | no | The workspace contains a scope entry kind that is not a file or directory. | Remove the special entry (socket/device) from the declared workspace scope. |

## Not CLI error codes

- Report and finding codes (`MISSING_SCENARIO`, `STATE_DIVERGENCE`, `NETWORK_METHOD_MISMATCH`,
  diagnostics of `prepare`/`verify`) are evidence inside result documents, not envelope codes.
- `UNCLASSIFIED` means the harness reported a code that is not in this table: the raw code is kept
  as the envelope `code`, and it should be added here.
