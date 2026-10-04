# CLI usage

Reference index for the implemented CLI. The **guide** — install, the six commands,
the envelope, `decision`/`outcome`/exit codes, budgets and the privacy policy — has its
canonical reference in [OPERATOR.md](OPERATOR.md): this file only points at it.

Status (2026-10-03, owner decision recorded in [PLAN-V2](PLAN-V2.md) §8.2): the six v2
commands are the whole CLI surface, and the former 26-command legacy surface plus the
restricted profile were retired together. Nothing here documents or invokes them.
Codes still emitted are catalogued in [reference/errors.md](reference/errors.md).

```text
init → doctor → prepare → (you edit the candidate) → verify → [status | reference]
```

## Reading order

| Need | Where |
| --- | --- |
| Install and build | OPERATOR §1 |
| First run on the bundled example | OPERATOR §2 |
| The six commands, flag by flag | OPERATOR §3–§4; `<command> --help` and `<command> --help --json` |
| Envelope, valid combinations, exit codes | OPERATOR §5 |
| Reading a FAIL / INCONCLUSIVE | OPERATOR §6 plus [reference/errors.md](reference/errors.md) |
| `nextActions` and who authorizes them | OPERATOR §7 |
| Occupied `--artifact-path`, replays and conflicts | OPERATOR §8 |
| Privacy policy (flag or environment opts in; a conflict is refused) | OPERATOR §9 and [OS-PORTABILITY.md](OS-PORTABILITY.md) |
| Repair, stops and handoff | OPERATOR §10 |
| Assistant protocol and trust limits | [AGENTS.md](../AGENTS.md) |
| Executable examples | `examples/validation-first/README.md`, `examples/component-first/README.md` |
| Architecture and delivered boundaries | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Configuration notes

- Profile: `profile: "standard"` in the migration config — there is no `--profile`
  flag. `prepare`, `verify`, `status` and `reference` refuse any other profile with
  `STANDARD_PROFILE_REQUIRED` (exit 1). Writable scope is `target.writePaths` against
  `target.protectedPaths`, checked before and after each verification run; scope
  findings appear in the envelope and in `status`.
- Scenario schema in use: `captureStepCheckpoints`, exact `targetLabel` locators
  (including password fields) and `LOCATOR_VISIBLE.text`; mocks may declare `delayMs`
  (0-10000) and a `sequence` of responses (last repeats, each fresh context resets it,
  fixtures stay fingerprinted). `REQUEST_OBSERVED` accepts an exact `count` and
  `payloadValues` checked against sanitized evidence and never echoed; `NODE_ABSENT`
  may match `text`/`textMatch`.
- An approved `acceptedDifferences` entry may supply `resolution` with
  `sourceAssertions`, mandatory `targetRequirementIds` and exact `matches`
  (`NETWORK_PAYLOAD_VALUE_MISMATCH`, `NETWORK_MISSING_REQUEST`). Only the declared
  divergences resolve after every source and target guard passes; other failures and
  insufficient evidence stay blocking, and `EXPECTED_DIFFERENCE` discloses the
  exception. New or changed exceptions in a frozen reference still need the
  owner-decision/versioning protocol of the `reference` command.
- Noise/binding/scenario suggestions (HINT_ONLY) may appear as `STANDARD_WARNING`
  diagnostics with sidecar detail and never auto-edit policy or config. Optional
  visual checkpoints (`policy.visual.enabled`) capture PNG screenshots whose bytes
  stay private; the sanitized trace carries only `imageSha256` and dimensions, and
  `VISUAL_MISMATCH` is a WARNING unless `policy.visual.severity` is `BLOCKING`.

## Privacy (normative)

- Private raw artifacts stay outside the public artifact root, in the platform private
  store with 0700 directories and 0600 files where POSIX modes are enforceable. Where
  they are not, opt in with flag `--allow-insecure-private-store` **or** environment
  `MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE=1` (either alone is enough); the only
  refusal is a conflict — the flag opts in while the variable says otherwise —
  `INVALID_FLAG`. A degraded policy stamps the report with
  `WEAK_PRIVATE_PERMISSIONS` / `DEGRADED_ISOLATION` — expected disclosures, not
  failures (OPERATOR §9, [OS-PORTABILITY.md](OS-PORTABILITY.md)).
- Never read raw traces, keys or private-state paths into assistant context; the
  enforceable limits are [AGENTS.md](../AGENTS.md).

Library APIs (reference, capture, comparison, project checks) are typed in `packages/`
and described in [ARCHITECTURE.md](ARCHITECTURE.md); they issue no verdict of their
own. Behavior that has to hold is specified in [RFC.md](RFC.md), delivery state in
[STATUS.md](STATUS.md).
