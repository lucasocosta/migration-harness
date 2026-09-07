# Assistant integration

Direction: [RFC v0.3](RFC.md). Status: [STATUS.md](STATUS.md).
This replaces the mandatory brief-only product model. No model API is required.

## Standard profile: integration to implement

One assistant, in the same conversation, can:
1. Read relevant application code and fill technical details of the owner's scope.
2. Prepare synthetic scenarios, identify existing tests and operate authorized commands.
3. Ask the harness to establish a versioned, reproducible source reference.
4. Edit destination code normally, including scoped styles/assets/tests.
5. Request complete verification, diagnose public results and repair implementation.
6. Repeat within a persisted budget and deliver evidence with remaining limitations.

The assistant may interpret and summarize results, never manufacture a tool verdict.
It does not need a codemod, successful discovery, mandatory manifest, patch JSON,
hidden scenarios or a fresh conversation to validate a migration.

Required integration capabilities (not current commands):
- Runtime-validated migration config with roots, scope, commands/cwd, URLs, scenarios,
  bindings, fixture/reset policy, required checks and limits.
- Reference identity, stable-source checks, stale-input detection and explicit rebaseline.
- Verification of current served build, complete suite and native destination checks.
- PASS/FAIL/INCONCLUSIVE aggregate report, safe localized divergences and coverage gaps.
- Persisted attempt history across calls; no-progress detection and bounded retries.
- Diff checks for scoped edits, protected inputs and unrelated preexisting user changes.

Do not invent a `--profile` flag or present this interface as available. Implementation
milestones and interface decisions live in [PLAN.md](PLAN.md).

P1 now implements the configuration/report schemas and a library aggregator, not
the operational loop. It consumes collector declarations and does not read/build
the apps or verify reference provenance. Library entry points and limits: USAGE.md.

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

Escalate ambiguity, scope/permission changes, secret exposure, unsupported evidence,
unsafe execution and exhausted budgets. Diagnose infrastructure separately from
behavior; an incomplete run is not a pass. Harness maintenance is a separate task.

## Restricted profile: available compatibility path

Existing commands and hooks retain their semantics. See [USAGE.md](USAGE.md)
for arguments and root [AGENTS.md](../AGENTS.md) for enforceable worker instructions.

| Operation | Implemented behavior |
| --- | --- |
| `brief` | Requires approved intact contract, unit/plan/scenarios, sanitized source trace, policy, scoped files and optional read-only context |
| `apply-patch` | Accepts issued brief plus complete TS/TSX replacements and manifest; owns candidate writes |
| `run --max-repairs 0` | Recaptures source/target for one scenario and returns comparison plus disposition |
| `brief --repair` | Only localized supported HTTP-method mismatches; does not enable general semantic repairs |

Issuance records protect unit, plan, contract, scenarios, source trace, policy,
context and AGENTS.md fingerprints. The brief has references/hashes, not raw
runtime values. Contract content is screened too; even WARNING ARIA content can
make a brief unsafe. A new approved version must never be silently stripped.

Submissions contain `briefId`, `patches: [{path, beforeHash, content}]` and
`manifest`. New-file hashes use empty content; existing bytes must match issuance.
Read-only destination context may support imports, not writes. Scope, packages,
AST constructs, leak screens, submission limits and configured static gates apply.
A changed baseline requires a fresh issued brief, not editing `beforeHash`.

Apply PASS means permitted application, not behavioral success. Structured REFUSED
changes no candidate bytes. Handled write/persistence failures roll back; process
crashes are not a cross-file transaction. Stale locks require inspected recovery.

Use the same artifact/candidate roots at issue and apply. Issuance is local consistency,
not authenticated provenance. The returned next command covers only the first
scenario: rebuild and independently execute every required scenario plus project
regression. Repair counters are caller-supplied today.

The two existing Copilot agent definitions and boundary hook remain restricted.
Do not use them for standard end-to-end operation or disable their checks to mimic it.
A recorded clean-context session is an optional restricted-profile demonstration,
not a gate for the standard product. The deterministic protocol pilot is not that
session and must never be relabeled as one.

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
coverage, privacy and restricted compatibility. Exact acceptance: RFC section 15,
PLAN P5/P6. Until then, this is a direction, not a completion claim.
