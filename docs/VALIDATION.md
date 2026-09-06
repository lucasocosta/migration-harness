# Validation record

What was actually executed, and what each run does not prove. Historical entries
for the pre-dependency, Python-fixture era (v0.2 and v0.2.1) were removed: their
counts and environment no longer describe this tree. `STATUS.md` holds the
current status; `REVIEWS.md` holds review decisions.

## Correction set and migration workflow — 2026-09-06

Tree: commit `3b0fad2` plus the uncommitted corrections for audit findings R1-R9,
the read-only destination context (`--context-files`), the Portuguese Copilot
manual, the migration specification template, and the two Copilot migration
agents with their boundary hook.

| Check | Result |
| --- | --- |
| Strict workspace build | PASS |
| Unit/CLI suite | 92/92 PASS |
| Chromium suite | 13/13 PASS |
| `smoke.mjs` and `smoke-v02.mjs` | PASS |
| Original pilot | PASS, `artifacts/pilot-5ZpYVI`, EQUIVALENT after one bounded repair |
| Assistant protocol pilot | PASS, `artifacts/pilot-assistant-WSkbqf` |
| `git diff --check` | PASS |

New coverage in this set: refusal of key pruning that would orphan retained
backups, with a synthetic restore regression; service-worker one-to-one
forwarding verification and context-level mock installation, in four focused
browser tests; reference-document ownership through local aliases and external
compositions; key mode/type/symlink verification and truncated-envelope
authentication failure; rejection of a backup root equal to the public root;
resolved private-domain guards for CLI inputs, audits and importers; exclusive
locks for key generation, raw lifecycle, audit updates and anchor appends; and
the read-only destination context, where a context file supports relative imports
without becoming writable, a patch targeting it is refused, and mutating it
produces `BASELINE_HASH_MISMATCH`.

The boundary hook for the Copilot agents has eight dedicated regressions
(`tests/copilot-hook.test.mjs`): fail-closed on unusable input, missing phase and
missing brief; refusal of the private raw domain, the native private state root
and credential files, including `~` and `file://` forms; preparation writes
limited to the tracking directory with no command execution; transformation reads
limited to brief, `AGENTS.md`, `allowedFiles`, `contextFiles` and the unit's
artifact root; writes limited to a submission JSON, with direct candidate writes
refused; oracle commands and git publish commands refused while `apply-patch`,
`run` and the destination build pass; and a JSONL decision log written as
evidence.

Not proven by this set: the workflow has never run against a real Angular and
real React repository pair; the hook is defense in depth on the assistant's tool
calls, not isolation; and hooks declared in agent files are a Preview VS Code
feature that requires `chat.useCustomAgentHooks`.

## Assistant integration — 2026-09-05

After checkpoint `a9a7f2d`: build PASS, 60/60 unit/CLI (15 assistant tests), 9/9
browser, both smokes, `git diff --check` PASS. Coverage included all ten refusal
codes, recomputed forged briefs, stale baselines, protected inputs, private
aliases, candidate symlinks, output collisions, issued submission caps, manifest
screens, aggregate repair budgets, configured static gates, locks, multi-file
rollback and injected partial writes.

The assistant protocol pilot ran real CLI and Chromium with typecheck and lint
enabled, rebuilt the applied bytes, produced a deliberate method regression, a
repair, an out-of-scope refusal, an unchanged synthetic contract and a verified
audit. It is explicitly labeled `DETERMINISTIC_PROTOCOL_SIMULATION`: integration
§6.2's recorded human-driven, brief-only session remains unverified.

## RFC pilot and review corrections — 2026-09-05

Executed in WSL with Node 20.20.1, TypeScript 5.9.3, pnpm 10.15.0 and Playwright
pinned to 1.63.0. Build PASS across all 15 projects, 28/28 unit/CLI, 5/5 browser,
both smokes, the Angular → generated React pilot with lint/typecheck, and
`git diff --check`.

That pilot recorded three source executions, detected `NETWORK_METHOD_MISMATCH`
after a `PUT → POST` regression, applied exactly one bounded repair, obtained
EQUIVALENT, and verified both the unchanged approved fixture contract and its
audit chain. Approval and provider are synthetic test fixtures: no production
contract was approved and no model reasoning was exercised.

Coverage included portable hashes, the actual FSM approval bypass, default-deny
payload fields, Unicode and prototype keys, malformed encoded URLs, ARIA URL
secrets, mock filesystem and origin boundaries, path/response/storage volatility,
replayed execution identities, causal comparison, static-scan bypass patterns and
worker HTTP error/redirect/size/deadline behavior.

## Environment facts that affect interpretation

- Private raw artifacts live under `~/.local/state/migration-harness/<hash>/raw`,
  with 0700 directories and 0600 files. `/mnt/c` was observed to expose 0777
  despite requested modes, so private artifacts must stay on the native Linux
  filesystem; permission, symlink and retention tests run against native
  temporary directories.
- The recorder handles Chromium's bodyless-response `ERR_ABORTED` case only when
  an actual 204/304/HEAD response exists; see
  [Playwright issue 26897](https://github.com/microsoft/playwright/issues/26897).
  Transport errors without a completed bodyless response remain failures.
- Never verified here: `DockerSandbox` execution (Docker unavailable through this
  WSL integration), external model inference, and framework behavior beyond the
  documented adapters.
- Automated axe results do not replace human accessibility evaluation, and no
  real migration contract has been approved by a human reviewer.
