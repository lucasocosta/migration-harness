# Assistant integration

Direction: [RFC v0.3](RFC.md). Status: [STATUS.md](STATUS.md).
No model API is required.

## Standard profile: implemented through P4 acceptance

One assistant, in the same conversation, can:
1. Read relevant application code and fill technical details of the owner's scope.
2. Prepare synthetic scenarios, identify existing tests and operate authorized commands.
3. Ask the harness to establish a versioned, reproducible source reference.
4. Edit destination code normally, including scoped styles/assets/tests.
5. Request complete verification, diagnose public results and repair implementation.
6. Repeat within a persisted budget and deliver evidence with remaining limitations.

The assistant may interpret and summarize results, never manufacture a tool verdict.
It does not need a codemod, successful discovery, mandatory manifest, submission
format, hidden scenarios or a fresh conversation to validate a migration.

Implemented integration capabilities:
- Runtime-validated migration config with roots, scope, commands/cwd, URLs, scenarios,
  bindings, fixture/reset policy, required checks and limits.
- Reference identity, stable-source checks, stale-input detection and explicit rebaseline.
- Verification of current served build, complete suite and native destination checks.
- PASS/FAIL/INCONCLUSIVE aggregate report, safe localized divergences and coverage gaps.
- Persisted attempt history across calls; no-progress detection and bounded retries.
- Diff checks for scoped edits, protected inputs and unrelated preexisting user changes.

Select `profile: "standard"` in config before preparation; profile rules are
owned by [AGENTS.md](../AGENTS.md). Use the `migracao-padrao` agent and the v2
cycle in [OPERATOR.md](OPERATOR.md).
Versioned reference updates are adopted into the open session by the v2
`reference` command with preserved history and budgets; a weakening needs an
explicit owner decision.
Implementation milestones and acceptance live in [PLAN.md](PLAN.md).

P1/P2 implement configuration/report schemas, reference collection from declared
project files, change verification, comparison and aggregation as libraries. P3
adds native checks, managed static build servers, suite capture with reset, observed
source stability and consolidated prepare/verify with source/target comparison and
aggregate reports. P4 adds normal scoped edits, persistent attempts/time and
repair decisions around that verifier. Hashes do not authenticate provenance.
Passing Cinema and component-first runs were recorded on 2026-09-12. The
Cinema-specific three controlled regressions and complete effort measurement
remain open in PLAN.md; the passing runs alone do not close those criteria.

## Evaluation independence

The same assistant can write code and run the tests. What must be independent is
the evaluator's verdict from the assistant's opinion and from edits to the criteria.
Public synthetic scenarios are readable; hiding them is not proof against overfitting.
Use varied data, source execution, explicit required behaviors and mutation checks.

Reference preservation and critical requirements are distinct. A formal approved
contract is optional in standard, not a replacement for a stable reference.
Existing approved contracts cannot be changed or fabricated by the assistant.

Preparation can create scenarios. After capture, additions/binding adaptations
need recorded new versions and validation on both sides. Removing requirements,
accepting a new difference or broadening ignore rules requires owner review.
A missing payload field is normally a target defect, not a contract-review request.
The session freezes config/reference. Use the `reference` command for a
controlled refresh; it preserves history and counters and requires an explicit
owner decision when the proposed reference weakens evaluation criteria.

Escalate ambiguity, scope/permission changes, secret exposure, unsupported evidence,
unsafe execution and exhausted budgets. Diagnose infrastructure separately from
behavior; an incomplete run is not a pass. Harness maintenance is a separate task.

## Restricted profile: WITHDRAWN (retired 2026-10-03)

The issued-workflow protocol, its CLI commands, boundary hook and the two Copilot
agent definitions for it were removed by owner decision ([PLAN-V2](PLAN-V2.md)
§8.2); the earlier operation tables and submission rules for that profile are
withdrawn with them. The invariants it enforced remain in force for the standard
flow through [AGENTS.md](../AGENTS.md) and [OPERATOR.md](OPERATOR.md): the harness
is the sole issuer of verdicts, scope and integrity checks cannot be disabled,
approvals are never fabricated, and recorded results of the retired profile are
historical evidence only — never a gate for the standard product.

## MCP transport (optional, agent-facing)

`packages/mcp-server` (`harness-mcp`) wraps the same engine tools as a stdio MCP
server: `prepare_migration`, `verify_migration`, `start_migration_session`,
`inspect_migration_session`, `update_migration_session`, `verify_migration_session`.
It is **transport only** — the harness remains the sole issuer of
PASS/FAIL/INCONCLUSIVE. Hygiene refuses pseudonyms (`p_`+24 hex) and private-root
paths in tool args/results. No tool auto-applies suggestions, bindings or policy.

Register with GitHub Copilot CLI (example):

```bash
copilot mcp add harness-mcp -- node $PWD/packages/mcp-server/dist/server.js
# workspace alternative: .mcp.json (see repository root)
```

Recorded spike (2026-09-27, GitHub Copilot CLI 1.0.83, model `gpt-5.4`):

- `tools/list` returned all six engine tools through Copilot.
- `inspect_migration_session` on a synthetic standard config reached the engine and
  returned `ENOENT ... artifacts/sessions/<pair>` — correct: inspect never creates a
  session (`start_migration_session` does).
- Environment note: if `COPILOT_PROVIDER_BASE_URL` is set to an unreachable BYOK
  endpoint, unset it (and `COPILOT_PROVIDER_TYPE`) to use GitHub Copilot auth, or
  point BYOK at a live provider and pass an explicit `--model`.

A recorded standard-session loop through Copilot + MCP is summarized in
[MCP-COPILOT-EVIDENCE.md](archive/MCP-COPILOT-EVIDENCE.md): `gpt-6-luna` drove
`prepare_migration` → `start_migration_session` → `verify_migration_session` on an
isolated component-first copy to `COMPLETE`/`PASS` (5/5 scenarios). A prior
`gpt-5.4` continuation returned `REVIEW_REFERENCE`/`INCONCLUSIVE` when source
build identity drifted despite green scenarios — the agent cannot manufacture a
completion.

## Data and execution safety

No raw traces, credentials or private paths enter assistant context. Prefer safe
structural reports; comparing values inside the harness does not require exposing
them. Same-user reads and archive tampering are policy-controlled residual risks.
Static scanning and hooks are defense in depth, not a sandbox.

The standard execution adapter must use declared commands in an authorized environment,
not arbitrary generated shell. No automatic dependency upgrades, destructive cleanup,
merge or push. Respect project-specific scope and commit permissions.

## Acceptance

The integration is usable when the owner supplies scope, the assistant completes a
page migration with ordinary edits and multiple non-method repairs, and the harness
reports all required evidence without manual JSON preparation or mandatory context
handoffs. Track owner interventions and verify candidate identity, failure handling,
coverage and privacy. Exact acceptance: RFC section 15,
PLAN P5/P6 — both demonstrated on 2026-09-12 (Cinema run 0001 PASS, commit
`2c98611`; component-first run 0001 PASS).
