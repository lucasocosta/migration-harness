# Migration Harness — Operator guide (CLI v2)

The reading list for an operator (human or AI) driving the harness: with
[AGENTS.md](../AGENTS.md) it is everything you need. Commands, the envelope,
`decision`/`outcome`/exit codes, `nextActions` and the privacy policy have their **canonical
reference here**; AGENTS.md summarises the same contract for the assistant protocol.

The six commands form one cycle:

```
init → doctor → prepare → (agent edits the candidate) → verify → [reference | status]
```

`repair` is **not** a command: repairing the candidate is your work between two `verify` runs. These six
commands are the whole CLI surface: the previous 26-command compatibility layer and the
restricted profile were retired together (owner decision 2026-10-03,
[PLAN-V2](PLAN-V2.md) §8.2).

## 1. Install and build

Bash:

```bash
corepack pnpm install
corepack pnpm build
HARNESS="node packages/cli/dist/index.js"
$HARNESS --help
```

PowerShell:

```powershell
corepack pnpm install
corepack pnpm build
$Harness = "node packages/cli/dist/index.js"
node packages/cli/dist/index.js --help
```

Every command supports `--help` and `--help --json`.

## 2. First run — examples/validation-first

The bundled example ships a complete configuration with `profile: "standard"` — **skip `init`** (it
only creates new ones). Run from the repository root: its project commands resolve through the
workspace `node_modules`.

```bash
HARNESS="node packages/cli/dist/index.js"
CFG=examples/validation-first/migration.json
$HARNESS doctor --config "$CFG" --workspace-root . --json
$HARNESS prepare --config "$CFG" --workspace-root . \
  --artifact-path artifacts/validation-first --allow-project-commands --json
# edit examples/validation-first/react/** (writePaths: App.tsx)
$HARNESS verify --config "$CFG" --workspace-root . --allow-project-commands --json
$HARNESS status --config "$CFG" --workspace-root . --json
```

```powershell
$Cfg = "examples/validation-first/migration.json"
node packages/cli/dist/index.js doctor --config $Cfg --workspace-root . --json
node packages/cli/dist/index.js prepare --config $Cfg --workspace-root . `
  --artifact-path artifacts/validation-first --allow-project-commands --json
# edit examples/validation-first/react/** (writePaths: App.tsx)
node packages/cli/dist/index.js verify --config $Cfg --workspace-root . --allow-project-commands --json
node packages/cli/dist/index.js status --config $Cfg --workspace-root . --json
```

On Windows — or any filesystem that cannot enforce `0700`/`0600` — strict privacy is the fallback,
so the first operation that writes private state is **refused** unless the run opts in. That refusal
is the expected first outcome, not a failure: the owner makes the informed decision and re-runs the
operations that need it with `--allow-insecure-private-store` (the environment variable works too,
§9). The degraded run then stamps `WEAK_PRIVATE_PERMISSIONS` and `DEGRADED_ISOLATION` as expected
evidence:

```powershell
$Cfg = "examples/validation-first/migration.json"
# strict by default: on Windows the private write is refused until the owner opts in
node packages/cli/dist/index.js prepare --config $Cfg --workspace-root . `
  --artifact-path artifacts/validation-first --allow-project-commands --allow-insecure-private-store --json
node packages/cli/dist/index.js verify --config $Cfg --workspace-root . `
  --allow-project-commands --allow-insecure-private-store --json
node packages/cli/dist/index.js reference --config $Cfg --workspace-root . `
  --artifact-path artifacts/re-reference --allow-project-commands --allow-insecure-private-store --json
```

Expect: `doctor` also warns while `profile` is missing (the four session commands then refuse with
`STANDARD_PROFILE_REQUIRED`); `prepare` returns `decision: READY`; only `verify` spends an attempt
(§4).

## 3. The cycle at a glance

| Command | Does | Attempt |
|---|---|---|
| `init` | schema-valid config skeleton + fields still to fill (owner decisions vs. technical drafts) | no |
| `doctor` | preflight environment, permissions, browser, commands | no |
| `prepare` | versioned reference + resumable session in one operation | no |
| `verify` | check the candidate (session owns reference, output, budget) | one per run |
| `status` | state, budget, blocks, next action | no |
| `reference` | versioned reference update; weakening needs the owner | no |

`prepare`, `verify`, `status` and `reference` require `profile: "standard"`; outside it they refuse
with `STANDARD_PROFILE_REQUIRED` (exit 1) and name the offending config field — set the profile
before preparing.

## 4. Commands

### init — declare the migration

```bash
node packages/cli/dist/index.js init --out migration.json --json
```

```powershell
node packages/cli/dist/index.js init --out migration.json --json
```

Writes a schema-valid skeleton (`profile: standard`) and returns `report.missingDecisions` — every
field still to fill; nothing runs, nothing is authorized. Refuses `OUTPUT_EXISTS` (exit 1) instead of
overwriting.

#### Resolving `report.missingDecisions`

Each entry is `{ fieldPath, decision }`: `fieldPath` names a field of that document, and the paths
you write there are relative to `--workspace-root`. The list mixes two classes and only the first
needs to slow the operator down:

**Owner-only (normative): scope, acceptance criteria, budget.** Never derive or invent these:

| fieldPath | You decide |
|---|---|
| `source.root` / `target.root` | the app being migrated away from / the migrated application |
| `target.writePaths` | target paths the candidate may write |
| `target.protectedPaths` | target paths that must never be touched |
| `checks` | required native checks per side (≥1 required target check) |
| `requirements` | requirements turning behavior into acceptance criteria |
| `limits` | `sourceRuns`, `maxRepairAttempts`, `maxDurationMs` — the budget of §4 |

**Technical detail you may draft, owner confirms.** An agent can derive these from the workspace and
the owner's criteria — propose them and move on, do not stall:

| fieldPath | You draft |
|---|---|
| `source.baseUrl` / `target.baseUrl` | URL each side is served on |
| `source.commands` / `target.commands` | build/check/serve/reset argv each side really runs |
| `scenarios` | steps, bindings, fixtures of the behavior to preserve |
| `reset` | how each side returns to a clean state between captures |

Re-check with `doctor`: an invalid field is `INVALID_INPUT` with its `fieldPath` (exit 1), environment
gaps are `diagnostics[]` (exit 5); scenarios and requirements are judged by `verify`. The checklist is
static: repeating `init` on the same `--out` refuses `OUTPUT_EXISTS`; another `--out` returns it.

### doctor — check the environment first

```bash
node packages/cli/dist/index.js doctor --config migration.json --workspace-root . --json
```

```powershell
node packages/cli/dist/index.js doctor --config migration.json --workspace-root . --json
```

Exit 0 = environment ready (`outcome: "PASS"`); exit 5 = missing (`outcome: "INCONCLUSIVE"`,
`diagnostics[]` names each finding); exit 1 = unreadable
config (`INVALID_INPUT` names the `fieldPath`). It also warns when `profile` is absent; the session
commands refuse that config with `STANDARD_PROFILE_REQUIRED`. A doctor PASS is **not** a migration
approval: it only says the environment can run one.

### prepare — reference + session in one operation

```bash
node packages/cli/dist/index.js prepare --config migration.json --workspace-root . \
  --artifact-path artifacts/prepared --allow-project-commands --json
```

```powershell
node packages/cli/dist/index.js prepare --config migration.json --workspace-root . `
  --artifact-path artifacts/prepared --allow-project-commands --json
```

`--allow-project-commands` is your explicit consent to run the declared commands; without it prepare
refuses with `EXECUTION_NOT_AUTHORIZED` (exit 1) and recommends itself with the flag. On success:
`outcome: "PASS"`, `decision: "READY"`, `sessionId` and `requestKey` set. A fresh `--artifact-path`
is mandatory (§8).

### verify — one attempt, one envelope

```bash
node packages/cli/dist/index.js verify --config migration.json --workspace-root . \
  --allow-project-commands --json
```

```powershell
node packages/cli/dist/index.js verify --config migration.json --workspace-root . `
  --allow-project-commands --json
```

You never pass a reference or an output path: the session owns both. Exit codes come from §5.
Before any attempt is spent, verify refuses (exit 1/3) for a missing session, missing authorization
or a workspace out of scope.

### status — where do I stand

```bash
node packages/cli/dist/index.js status --config migration.json --workspace-root . --json
```

```powershell
node packages/cli/dist/index.js status --config migration.json --workspace-root . --json
```

`report` carries `attemptsUsed`/`attemptsRemaining`, `usedMs`/`remainingMs`, scope findings,
reference status, `lastReportMatchesWorkspace` and `attempts[].reportPath` (evidence base: §6).
Exit 0 = readable, no block; exit 3 = session refused or stopped; exit 1 = no session / bad input.
Reading state never consumes an attempt.

#### Budget — where `attemptsRemaining` and `remainingMs` come from

Both derive from `limits` in the configuration, frozen when `prepare` opens the session:

- `attemptsRemaining = maxRepairAttempts + 1 − attemptsUsed` — one attempt beyond
  `limits.maxRepairAttempts`.
- `remainingMs = maxDurationMs − usedMs` — `limits.maxDurationMs` minus the recorded attempts'
  durations; an attempt with no finish charges its whole reserved slice.

| Operation | Attempt | Active time |
|---|---|---|
| `verify` | one, recorded before the run | its duration; hitting the limit ends it `SESSION_TIMEOUT` → `STOP_LIMIT` |
| `reference` | never (history and budgets stay frozen) | none in the budget — a full preparation runs in wall-clock time but never charges `usedMs` |
| `status`, `init`, `doctor` | none | none |
| refusals/replays (`ARTIFACT_NOT_FRESH`, `EXECUTION_NOT_AUTHORIZED`, stops) | none | none |

### reference — versioned reference updates

```bash
node packages/cli/dist/index.js reference --config migration.json --workspace-root . \
  --artifact-path artifacts/re-reference --allow-project-commands --json
```

```powershell
node packages/cli/dist/index.js reference --config migration.json --workspace-root . `
  --artifact-path artifacts/re-reference --allow-project-commands --json
```

`report.classification` is `INITIAL | INPUT_UPDATE | BINDING_ADAPTATION | EXTENSION | WEAKENING`.
A `WEAKENING` is refused (`REFERENCE_CHANGE_REQUIRES_OWNER_DECISION`, exit 1) until you pass
`--owner-decision <reference>` **yourself** after the owner's decision: no recommendation ever
supplies that value — approvals are never fabricated.

A successful update appends a new **generation**: attempts, budgets and session identity stay
frozen, but the last report belongs to a superseded reference, so `lastReportMatchesWorkspace` turns
`false`. `status` still reports the recorded decision (an old `COMPLETE` stays `COMPLETE`) and, while
the flag is false, hands you `verify` again — an old PASS is never the current result.

## 5. The envelope (one JSON document per `--json` run)

### Scope: the six commands

`--json` and this envelope belong to the six commands above — `init`, `doctor`, `prepare`, `verify`,
`status`, `reference` — and those six are the entire CLI surface. There is no second interface to
reconcile: the compatibility layer was retired with the restricted profile (§1). Each code's
`cause → action` row lives in [reference/errors.md](reference/errors.md).

Within those six, `--json` writes exactly **one** envelope to stdout; progress and diagnostics go to
stderr (text: `ERROR <code>: <cause>`).

```json
{
  "schemaVersion": "1",
  "operation": "verify",
  "operationStatus": "processed",
  "sessionId": "artifacts/sessions/698f…",
  "runId": "4f9c…",
  "decision": "COMPLETE",
  "outcome": "PASS",
  "report": { "kind": "MIGRATION_SESSION_RESULT" },
  "diagnostics": [],
  "nextActions": [],
  "requestKey": "0a1e…",
  "replayOf": "0a1e…"
}
```

The three axes are independent — never collapse them:

- **`operationStatus`** — how the *operation* was processed: `processed` (ran and produced a result),
  `refused` (harness, session or policy refused it; nothing evaluated), `failed` (processing broke
  outside the published flow).
- **`outcome`** — the evaluation: `PASS` | `FAIL` | `INCONCLUSIVE`; **absent when nothing was
  evaluated** (status reads, refusals, crashes never invent one).
- **`decision`** — the *session* disposition: `READY`, `COMPLETE`, `REPAIR_IMPLEMENTATION`,
  `FIX_ENVIRONMENT`, `REVIEW_REFERENCE`, `REFUSED_SCOPE`, `STOP_LIMIT`, `STOP_NO_PROGRESS`,
  `INTERRUPTED`. It comes from the engine's disposition over a report or from session state — it is
  never inferred from `outcome` alone. **On `status`, `decision` can be historical:** it is the
  disposition of the *last recorded report*, so a `reference` update leaves `status` reporting the old
  `COMPLETE` while `report.lastReportMatchesWorkspace` is `false`. A *current* conclusion therefore
  needs both the recorded disposition **and** a valid report that still matches the workspace with no
  pending block — never `decision` alone. Operationally `COMPLETE` = the last verification recorded a
  PASS, the workspace still matches it and no next action is pending — a property of the session,
  never the owner's final acceptance.

`sessionId` and `report` appear only when they exist. `requestKey` identifies the normalized request
of artifact-consuming operations (`prepare`, `reference`); `replayOf` appears when that same request
already occupies the artifact path (§8).

### Valid combinations and exit codes

Only these combinations are emitted; anything else is a contract violation (tested in
`tests/v2-envelope.test.mjs`). Exit codes are immutable: `0` operation success (doctor/status never
approve a migration), `1` processing error or non-session refusal, `3` session refusal/stop — it
outranks a PASS report — `4`/`5` FAIL/INCONCLUSIVE only when no stop applies.

| operationStatus | decision | outcome | exit | Meaning |
|---|---|---|---|---|
| processed | — | — | 0 | operation completed, nothing evaluated |
| processed | — | PASS | 0 | PASS, no session decision (doctor, prepare) |
| processed | — | FAIL | 4 | FAIL, no session decision (prepare) |
| processed | — | INCONCLUSIVE | 5 | INCONCLUSIVE, no session decision (doctor, prepare) |
| processed | READY | — | 0 | awaiting first verification (status/reference) |
| processed | READY | PASS | 0 | preparation PASS, session opened (prepare) |
| processed | COMPLETE | — | 0 | status: recorded COMPLETE, no fresh evaluation |
| processed | COMPLETE | PASS | 0 | verification PASS |
| processed | REPAIR_IMPLEMENTATION | — | 0 | status: recorded, candidate to repair |
| processed | REPAIR_IMPLEMENTATION | FAIL | 4 | FAIL, candidate to repair |
| processed | REPAIR_IMPLEMENTATION | INCONCLUSIVE | 5 | exit follows the outcome |
| processed | FIX_ENVIRONMENT | — | 0 | status: recorded, environment to fix |
| processed | FIX_ENVIRONMENT | INCONCLUSIVE | 5 | environment blocked the evaluation |
| processed | REVIEW_REFERENCE | — | 0 | status: reference needs owner review |
| processed | REVIEW_REFERENCE | FAIL | 4 | FAIL, reference also to review |
| processed | REVIEW_REFERENCE | INCONCLUSIVE | 5 | INCONCLUSIVE, reference to review |
| processed | REFUSED_SCOPE | — | 3 | scope refusal (status or mid-run) |
| processed | STOP_LIMIT | — / PASS / FAIL / INCONCLUSIVE | 3 | budget exhausted; outranks any report |
| processed | STOP_NO_PROGRESS | — / PASS / FAIL / INCONCLUSIVE | 3 | identical failures; outranks any report |
| processed | INTERRUPTED | — | 3 | attempt never recorded its finish |
| refused | — | — | 1 | refusal outside the session (auth, input, path, privacy) |
| refused | REFUSED_SCOPE | — | 3 | refused before executing (scope) |
| refused | STOP_LIMIT | — | 3 | refused: budget exhausted |
| refused | STOP_NO_PROGRESS | — | 3 | refused: stopped for no progress |
| refused | INTERRUPTED | — | 3 | refused: previous attempt still open |
| failed | — | — | 1 | processing failure; diagnostics only |

Reading aid: a **stop decision always yields 3** (even next to PASS), `4`/`5` only an evaluation that
was allowed to run, `0` only the *operation* — check `decision` and `outcome` before treating
anything as approved. On `status`, also read `report.lastReportMatchesWorkspace`: a `COMPLETE` over a
`false` flag is historical, not the current result.

## 6. Reading a failure

A `verify` with `outcome: "FAIL"` (exit 4) or `INCONCLUSIVE` (exit 5) is read in this order. First
locate the report, because `envelope.report` is the **session result**, not the `MigrationReport`:
read `envelope.report.kind` before indexing. `verify` returns `MIGRATION_SESSION_RESULT` with the
`MigrationReport` nested at `report.report`; `status` returns `MIGRATION_SESSION_STATUS`, which
embeds no report and instead names the stored file at `report.attempts[].reportPath`; `prepare`
(`MIGRATION_PREPARATION`), `reference` (`MIGRATION_SESSION_REFERENCE_UPDATED`), `doctor`
(`MIGRATION_PREFLIGHT`) and `init` (`MIGRATION_CONFIG_INIT`) each carry their own structure.

1. **`diagnostics[]`** — envelope-level `{ code, category, retryable, fieldPath?, cause, action }`;
   each code's `cause → action` row is in [reference/errors.md](reference/errors.md).
2. **The `MigrationReport`** — `verify`: `report.report.diagnostics` (findings naming
   `scenarioId`/`stepId`/`checkId`/`side`/`detailCode`), with `report.report.scenarios[]` and
   `report.report.checks[]` for each unit's status. `status`: read the `MIGRATION_REPORT` file named
   by `report.attempts[].reportPath` (relative to `--workspace-root`), whose top level is that same
   shape. `doctor`: `report.diagnostics`/`report.checks[]` are the preflight's own, not a migration
   report.
3. **`evidencePaths`** — inside each scenario/check result
   (`report.report.scenarios[].evidencePaths` on `verify`), relative to the directory holding the
   report, the run's artifact root `<workspace-root>/artifacts/sessions/<id>/runs/<n>/`; `verify`
   returns the zero-padded `index` (`n`) at `report.index`, `status` returns `attempts[].reportPath`.
4. **`comparisons/<scenarioId>.json`** — beside the report: every divergence with sanitized
   `expected`/`actual` — what differed, without opening a trace.

Act on the decision, not the exit code: a diverging comparison is candidate work — fix the candidate
(never the reference, the criteria or a report) and `verify` again. `REPAIR_IMPLEMENTATION` = repair;
`FIX_ENVIRONMENT` = run `doctor` first; `REVIEW_REFERENCE` = the reference needs the owner (§7). On
`status`, confirm the recorded decision is current first (`report.lastReportMatchesWorkspace` true and
no block) — but always read the decision of a fresh `verify` directly, where it is not historical.

## 7. nextActions — what to do, and who must authorize it

Every action is `{ operation, args, preconditions, requiresApproval }` with one of exactly three
approval values:

| requiresApproval | Meaning |
|---|---|
| `automatic` | Safe to run right now (`status`, diagnostic `doctor`). |
| `after_correction` | Only after the listed precondition is fixed (e.g. `verify` after a repair). |
| `requires_authorization` | An authorization only you can give: `--allow-project-commands`, or an owner decision. |

Rules enforced in code, not by convention:

- Operations come only from the migration flow (the six commands); argument names are registered
  flags, values plain scalars — never a runtime-derived shell string.
- An ambiguous cause (`UNCLASSIFIED`/`INTERNAL`) recommends a diagnostic (`doctor`), never an edit.
- `REVIEW_REFERENCE` — or any reference that is not `VERIFIED` — never authorizes a reference
  **adoption**: no action carries `--owner-decision` in that state. Adoption always needs
  `requires_authorization`, and you supply the owner's reference yourself.
- No action ever edits the candidate — repair is your work between verifications.
- Empty `nextActions` + exit 3 = the session stopped (`STOP_LIMIT`, `STOP_NO_PROGRESS`,
  `INTERRUPTED`): budgets and history are immutable, so a human decides what happens next.

## 8. Idempotency: occupied artifact paths

Outputs are exclusive: re-running `prepare`/`reference` on an existing `--artifact-path` is a
structured refusal, never a silent reuse:

- `diagnostics[0].code = "ARTIFACT_NOT_FRESH"` (exit 1) plus `requestKey`, the identity of your
  normalized request; when the path holds a record of **this same request**, `replayOf`
  equals it.
- A recorded run with no preparation is *interrupted*: nothing concluded, no attempt consumed; a
  different configuration is a *conflict* (no `replayOf`).
- Every case offers the way out in `nextActions`: `status` to inspect the recorded state, or
  `prepare`/`reference` on a fresh `--artifact-path` (`FRESH_ARTIFACT_PATH`). Reuse is never
  heuristic: a replay starts no session, consumes no attempt, and an old PASS is never current
  (`lastReportMatchesWorkspace` says whether the last result still matches the workspace).

## 9. Privacy policy (one decision per operation)

Two declarations feed one decision — flag `--allow-insecure-private-store` and environment
`MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE=1`. **Either one alone opts in:** the effective policy
records where it came from (`source: 'flag' | 'environment' | 'flag+environment'`), so the variable is
not required when the flag is passed, and the flag is not required when the variable is set.

Each operation resolves them **once** into one effective policy, propagated to the preflight probe,
the private store and the report: the channels can never disagree. The single refused case is a
**conflict** — the flag opts in while the variable is set to anything other than `1` (non-empty) —
refused with `INVALID_FLAG` on `fieldPath: "MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE"` (exit 1):
permissions are never widened silently. A degraded policy surfaces `WEAK_PRIVATE_PERMISSIONS` and
`DEGRADED_ISOLATION` disclosures in the report/preflight — **expected evidence**, not failures (see
[OS-PORTABILITY.md](OS-PORTABILITY.md)).

```bash
# strict is the default: on a filesystem without enforceable modes the private write is refused
node packages/cli/dist/index.js doctor --config migration.json --workspace-root . --json
# the owner opts in (flag or environment) and re-runs the operations that need it
node packages/cli/dist/index.js doctor --config migration.json --workspace-root . --allow-insecure-private-store --json
```

## 10. Repairing and stopping

1. `verify` → `decision: REPAIR_IMPLEMENTATION` → fix the candidate yourself → `verify` again
   (`nextActions` shows `after_correction`).
2. `decision: FIX_ENVIRONMENT` or an ambiguous cause → run the recommended `doctor` before touching
   the candidate.
3. `decision: REVIEW_REFERENCE` → the reference needs review; `nextActions` may propose `reference`
   (proposal only, `requires_authorization`).
4. Exit 3 / a stop decision → stop for a human: attempts, budgets and history are never reset
   silently; a timeout is never authorization to change the reference.

Catalog (`code → cause → action`): [reference/errors.md](reference/errors.md). Flags:
`<command> --help` (and `--help --json` for the machine-readable form). Index of this
guide: [USAGE.md](USAGE.md).
