# MCP + GitHub Copilot CLI: integration evidence

This is a portable record of **agent-outside / harness-oracle** integration
spikes, not a new migration verdict. It does not replace Cinema or component-first
acceptance. Session artifacts stay in local workspaces; no private raw traces are
included here.

## Session A — full standard loop (`gpt-6-luna`)

| Identity | Recorded value |
| --- | --- |
| Date | 2026-09-28 |
| Agent transport | GitHub Copilot CLI 1.0.83, model **`gpt-6-luna`**, non-interactive `-p` |
| MCP server | `harness-mcp` → `packages/mcp-server/dist/server.js` (stdio) |
| Workspace | isolated copy of `examples/component-first` (rewritten roots `source`/`target`, fresh session path) |
| Config | `profile: "standard"`, 5 scenarios, 11 requirements, 3 checks |
| Session | `698f1ee413295864186134eaf3e923a9`, generation 0 |
| Preparation | `artifacts/prepared`, status `PASS`, referenceHash `257d0a3c45a26308…` |
| Verdict run | `0000`, evaluatedAt `2026-09-28T10:23:49.116Z` |
| Decision | **`COMPLETE`** |
| Report | **`PASS`** / preservation `PASS` / requirements `PASS` / projectChecks `PASS` / reference `VERIFIED` |
| Coverage | 5/5 scenarios, 11/11 requirements, 3/3 checks |
| Scenarios | `seletor-incrementar-ate-maximo`, `seletor-decrementar-ate-minimo`, `seletor-teclado`, `seletor-callback-host`, `pedido-fluxo-completo` — all `PASS` |
| Checks | `source-build`, `target-build`, `design-system-regression` — all `PASS` |
| Diagnostics | `[]` |
| Budget after | `attemptsUsed: 1/4`, `usedMs: 11690`, `remainingMs: 168310`, `scope: PASS`, `lastReportMatchesWorkspace: true` |

### Tool sequence issued by the agent (Copilot → MCP → engine)

1. `prepare_migration` (`allowProjectCommands: true`, `artifactPath: artifacts/prepared`) → `MIGRATION_PREPARATION` `PASS`.
2. `start_migration_session` (`preparationPath: …/preparation.json`) → `MIGRATION_SESSION_STARTED` (`maxAttempts: 4`, `maxActiveMs: 180000`).
3. `verify_migration_session` (`allowProjectCommands: true`) → `MIGRATION_SESSION_RESULT` `COMPLETE` / `PASS` on attempt 0.
4. `inspect_migration_session` → durable status matching the workspace.

The agent did **not** edit candidate files and did **not** run shell commands in
this sequence. The harness built, served, captured and compared; the agent only
called tools and read structured results.

## Session B — continued historical session (`gpt-5.4`)

Earlier spike on the published `examples/component-first` session
`16afbd43dd389ed382272b9939e73dae` (model `gpt-5.4`):

| Field | Value |
| --- | --- |
| Decision after Copilot `verify` | `REVIEW_REFERENCE` |
| Report | `INCONCLUSIVE` with preservation/requirements/projectChecks all `PASS`, coverage 5/5 · 11/11 · 3/3 |
| Diagnostics | `STALE_EVIDENCE` / `SOURCE_BUILD_MISMATCH`, `REFERENCE_UNVERIFIED` |
| Run | `0002`, `attemptsUsed: 3` |

### Why session B still counts as a successful spike

Behavioral checks were green, yet the harness refused `COMPLETE` because the
**source build identity no longer matched the prepared reference** after the
example apps were rebuilt. Independence means the agent cannot declare success
when evaluation inputs drift. Response: `REVIEW_REFERENCE`, not silent rebaseline.

## Session C — full standard loop (`gpt-6-luna`, post-change revalidation)

| Identity | Recorded value |
| --- | --- |
| Date | 2026-09-28 |
| Agent transport | GitHub Copilot CLI 1.0.88, model **`gpt-6-luna`**, non-interactive `-p` + `--resume` |
| MCP server | `harness-mcp` → `packages/mcp-server/dist/server.js` (stdio) |
| Workspace | isolated copy of `examples/component-first` (rewritten roots `angular`/`react`, fresh session path under `artifacts/pilot-luna-*`) |
| Config | `profile: "standard"`, 5 scenarios, 11 requirements, 3 checks |
| Session | `67a1d246f04c5477b8749d26da70974e`, generation 0 |
| Preparation | `artifacts/prepared`, status `PASS`, referenceHash `09fddb334227bf3d…` |
| Verdict run | `0000`, evaluatedAt `2026-09-29T01:44:57.379Z` |
| Decision | **`COMPLETE`** |
| Report | **`PASS`** / preservation `PASS` / requirements `PASS` / projectChecks `PASS` / reference `VERIFIED` |
| Coverage | 5/5 scenarios, 11/11 requirements, 3/3 checks |
| Diagnostics | `[]` |
| Budget after | `attemptsUsed: 1/4`, `usedMs: 15164`, `remainingMs: 164836`, `scope: PASS`, `lastReportMatchesWorkspace: true` |

### Tool sequence issued by the agent (Copilot → MCP → engine)

1. `prepare_migration` (`allowProjectCommands: true`, `artifactPath: artifacts/prepared`) → `MIGRATION_PREPARATION` `PASS` (source observations `STABLE` over 2 runs).
2. `start_migration_session` — the first call passed the artifact *directory* as `preparationPath` and failed with `ENOENT`; no session was created and no status was fabricated. With the corrected `preparationPath` (`…/preparation.json`) it returned `MIGRATION_SESSION_STARTED` (`maxAttempts: 4`, `maxActiveMs: 180000`).
3. `verify_migration_session` (`allowProjectCommands: true`) → `MIGRATION_SESSION_RESULT` `COMPLETE` / `PASS` on attempt 0.
4. `inspect_migration_session` → durable status matching the workspace.

The agent did **not** edit candidate files (`Changes +0 -0`) and did **not** run shell
commands. Two observations are recorded as evidence: the failed call surfaced as a
raw `MCP error -32000: ENOENT …` string carrying a filesystem path rather than a
stable refusal code (error-hygiene gap on this channel), and the missing session
failed closed instead of fabricating a report.

## Session D — full standard loop (`gpt-6-luna`, api-first P7 pilot)

| Identity | Recorded value |
| --- | --- |
| Date | 2026-09-29 |
| Agent transport | GitHub Copilot CLI 1.0.88, model **`gpt-6-luna`**, non-interactive `-p` + `--resume` |
| MCP server | `harness-mcp` → `packages/mcp-server/dist/server.js` (stdio, post-hardening channel) |
| Workspace | isolated copy of `examples/api-first` (rewritten roots `source`/`target`, fresh session path) |
| Config | `profile: "standard"`, 3 request-step scenarios, 5 `responseClaim` requirements, 4 checks |
| Session | `698f1ee413295864186134eaf3e923a9`, generation 0 |
| Preparation | `artifacts/prepared`, status `PASS`, referenceHash `8700817687ee1627…` |
| Verdict run | `0000`, evaluatedAt `2026-09-29T14:00:07.740Z` |
| Decision | **`COMPLETE`** |
| Report | **`PASS`** / preservation `PASS` / requirements `PASS` / projectChecks `PASS` / reference `VERIFIED` |
| Coverage | 3/3 scenarios, 5/5 requirements, 4/4 checks |
| Diagnostics | `[]` |
| Budget after | `attemptsUsed: 1/4`, `usedMs: 8017`, `remainingMs: 171983`, `scope: PASS`, `lastReportMatchesWorkspace: true` |

### Tool sequence issued by the agent (Copilot → MCP → engine)

1. `prepare_migration` (`allowProjectCommands: true`, `artifactPath: artifacts/prepared`) →
   `MIGRATION_PREPARATION` `PASS` (source `STABLE` over 2 runs).
2. `start_migration_session` (absolute `preparationPath`) → `MIGRATION_SESSION_STARTED`
   (`maxAttempts: 4`, `maxActiveMs: 180000`).
3. `verify_migration_session` (`allowProjectCommands: true`) → `MIGRATION_SESSION_RESULT`
   `COMPLETE` / `PASS` on attempt 0.
4. `inspect_migration_session` → durable status matching the workspace.

The agent did **not** edit candidate files (`Changes +0 -0`) and did **not** run shell
commands.

### What the failed attempts found (before the recorded run)

Three earlier attempts exposed two real engine defects on the re-prepare path, both
fixed in this cycle and covered by `tests/prepare-retry.test.mjs`:

1. **Re-prepare key crash**: `referenceKey` created the shared pseudonymization key
   with exclusive-create and crashed with `EEXIST` on any second prepare over the
   same artifact identity — surfaced as `TOOL_FAILED` on the MCP channel and
   `INVALID_MIGRATION_INPUT_OR_OUTPUT` on the CLI. Re-preparing now reuses the key
   (stable pseudonyms).
2. **Dirty artifact directory crash**: `beginOperation` crashed with raw `EEXIST` on
   `mkdir` over a non-empty artifact directory. It now refuses with the stable code
   `ARTIFACT_NOT_FRESH`.

Operator setup mistakes (incomplete workspace copy, stale partial artifacts) produce
the same opaque codes: diagnostics stay content-free by design, and stable sub-codes
(like `ARTIFACT_NOT_FRESH`) are what make a harness defect distinguishable from an
operator error.

## Limits

- Session A used an isolated workspace (fresh session id); it is not the published
  developer session and is not a production migration proof.
- Session B did not re-run `prepare`/`start` (it continued an existing session).
- Environment: when `COPILOT_PROVIDER_BASE_URL` points at an unreachable BYOK
  provider, unset `COPILOT_PROVIDER_BASE_URL`/`COPILOT_PROVIDER_TYPE` to use GitHub
  Copilot auth (or point BYOK at a live provider and pass `--model`).
- MCP is transport only. No tool auto-applied suggestions, bindings or policy.
  Hygiene screens reject pseudonyms and private-root paths on this channel.

## Reproduction sketch

```bash
copilot mcp add harness-mcp -- node "$PWD/packages/mcp-server/dist/server.js"
# or workspace .mcp.json
env -u COPILOT_PROVIDER_BASE_URL -u COPILOT_PROVIDER_TYPE \
  copilot --model gpt-6-luna --allow-all-tools \
  -p 'Call harness-mcp.prepare_migration with {"configPath":"...","workspaceRoot":"...","artifactPath":"artifacts/prepared","allowProjectCommands":true}'
```

Related: [ASSISTANT-INTEGRATION](../ASSISTANT-INTEGRATION.md), [USAGE](../USAGE.md),
[component-first example](../../examples/component-first/README.md),
[STATUS](../STATUS.md).
