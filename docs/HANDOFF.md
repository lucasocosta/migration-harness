# Continuation handoff

Checkpoint: 2026-09-05. Branch: `next/angular-forms-and-io`. This handoff transfers
continuation from the OpenCode orchestrator back to the codex session. Read
`docs/ASSISTANT-INTEGRATION.md` first — it is the authoritative design for the pivot
described below.

## The pivot (decided, user-confirmed)

The harness does NOT call a model via API. The Transform/Repair "LLM worker" is a
human-driven coding assistant (Claude Code, Copilot, codex — i.e. you) driving the CLI
with bounded briefs. The harness is the oracle/gatekeeper; the assistant is the hands.
Consequence: RFC §33.II shifts from architectural guarantee to policy + tooling; the
docs pass below must restate it honestly. The "external model service with
credentials" item is obsolete by design.

## Committed state (all green at commit time)

Branch history (newest first):
- `ac7694e` feat: dedicated WebSocket scenario adapter (45/45 unit + 9/9 browser at commit)
- `8d9a96c` docs: assistant-driven worker integration contract and pivot record
- `3da64fc` feat: builder-group normalization, async-validator evidence and provider scopes
- `6b3a584` feat: angular decorated IO and synchronous reactive-forms slice
- `9df23e1` docs: record validated checkpoint and remaining RFC work
- `0af541e` feat: implement RFC migration pilot and harden validation boundaries

Delivered and committed: full RFC core workflow; review corrections (19/20 verified);
decorated IO + reactive forms slices; provider scopes; WebSocket adapter (opt-in
routeWebSocket capture, default-block preserved, strict within-connection pairing,
BLOCKING network-family divergences); `docs/ASSISTANT-INTEGRATION.md` (contract
design); PROGRESS pivot record.

## In-flight work (INTENTIONALLY LEFT UNFINISHED — stop request)

A checkpoint commit follows this handoff containing a PARTIAL implementation of the
assistant loop. Measured state at handoff: build ✅, 50/50 unit/CLI tests ✅,
9/9 browser tests ✅, both smokes ✅. UNVERIFIED: `scripts/pilot-assistant.mjs`
(the worked example was not run to completion).

Present in the tree (committed in the wip checkpoint):
- `packages/core/src/brief.ts` (new) — brief/submission schemas per design §1
- `packages/core/src/schemas.ts`, `packages/core/src/index.ts` — HarnessPolicySchema `assistant` block + exports
- `packages/llm-worker/src/bounded-worker.ts` — `screenPatchContent` export
- `packages/engine/src/artifacts.ts`, `packages/engine/src/repair-loop.ts` — small support changes
- `packages/cli/` — `brief` and `apply-patch` commands (+ `quality-gates` dep added to cli/package.json)
- `AGENTS.md` (new, repo root) — draft per design §4
- `tests/assistant-loop.test.mjs` — 5 passing tests (partial refusal matrix)
- `scripts/pilot-assistant.mjs` — worked example, UNVERIFIED/possibly incomplete

## Next steps for the codex session (ordered)

1. **Run `node scripts/pilot-assistant.mjs`.** Finish/fix it to green per
   `docs/ASSISTANT-INTEGRATION.md` §6 + checklist item 8 (8 demo requirements:
   brief hygiene asserts, apply PASS, `run --max-repairs 0` EQUIVALENT, injected
   regression → NOT_EQUIVALENT NETWORK_METHOD_MISMATCH → REPAIR_BRIEF, repair apply →
   EQUIVALENT, one deliberate out-of-allowlist submission → REFUSED atomically,
   contract contentHash unchanged, verifyAudit passes).
2. **Complete the apply-patch refusal matrix** (design §2): one test per code —
   PATCH_PATH_OUTSIDE_BOUNDARY, BASELINE_HASH_MISMATCH, AST_FORBIDDEN_CONSTRUCT,
   IMPORT_NOT_ALLOWED, PSEUDONYM_IN_PATCH, RAW_PATH_REFERENCE, SCHEMA_INVALID,
   MANIFEST_UNIT_MISMATCH, BRIEF_ID_MISMATCH, EDIT_BUDGET_EXCEEDED — plus
   brief-generation refusals (raw-domain path, un-sanitized trace, non-APPROVED
   contract, non-AUTO_REPAIRABLE repair). 5 exist; the matrix is partial.
3. **Review `AGENTS.md` copy** against design §4 (8 sections; refusal-code table).
4. **Run the full verification suite** (commands below), then commit.
5. **Docs pass**: RFC §33.II/§25 restate for the policy+tooling boundary model;
   update docs/USAGE.md (assistant loop usage); update docs/PROGRESS.md marks and
   docs/IMPLEMENTATION-STATUS.md (Worker execution row: assistant-driven loop
   delivered; HttpWorkerProvider demoted to optional adapter).
6. Then continue the remaining RFC list in docs/PROGRESS.md: service-worker adapter +
   application-wide causal instrumentation; OpenAPI composed/conditional schemas +
   external refs; operational encryption/key rotation/backup retention; DockerSandbox
   live validation (environment-blocked here).

## Verification commands

```bash
npx --yes pnpm@10.15.0 build
node --test tests/*.test.mjs
node --test tests/browser/*.test.mjs
node scripts/smoke.mjs
node scripts/smoke-v02.mjs
node scripts/pilot.mjs
node scripts/pilot-assistant.mjs
git diff --check
```

Do not repeat without new changes or a reason.

## Workspace / environment

- CWD: `/mnt/c/Users/Lucas/projects/migration-harness`. Node 20. pnpm NOT on PATH —
  use `npx --yes pnpm@10.15.0`.
- Tests import from `dist/`: always `pnpm build` before running tests.
- Docker unavailable through this WSL integration. No external LLM credentials; none
  needed — the pivot removed that dependency.
- Playwright pinned exactly 1.63.0. Private raw artifacts live under
  `~/.local/state/migration-harness/<hash>/raw` (0700/0600), NOT in-repo; `/mnt/c`
  cannot hold private modes.
- All current work is on `next/angular-forms-and-io`; main is untouched since `9df23e1`.

## Invariants you must preserve (do not weaken)

- The harness is the oracle: only harness output certifies EQUIVALENT/PR_READY.
- Manifest is hints, never authority. Briefs carry references + hashes, never raw
  content; generation goes through `projectTraceForLlm` only.
- `apply-patch` is atomic: any refusal applies NOTHING; reject, never sanitize.
- Repair-brief emission requires `classifyFailure() == AUTO_REPAIRABLE`.
- Contract, SourceTrace, scenarios, validation policy and AGENTS.md itself are
  protected inputs (fingerprints in the repair loop enforce this).
- Raw traces never reach briefs/results by construction; the assistant's unbounded
  read access is the documented residual risk (AGENTS.md + purge-raw discipline).
