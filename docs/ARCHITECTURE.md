# Architecture

Target: [RFC v0.3](RFC.md). Delivered behavior: [STATUS.md](STATUS.md).
Implementation sequence: [PLAN.md](PLAN.md).

## Validation-first flow (implemented standard profile)

```text
Owner scope -> assistant prepares project configuration and scenarios
                         |
                         v
                 versioned stable reference
                         |
Assistant edits target -> project checks + scenario suite -> comparison report
       ^                                                    |
       +----------- implementation feedback / repair -------+
                                                            |
                                                  owner release review
```

The assistant owns programming and loop orchestration. The harness owns evaluation
and attributable results, not the editor. One session can prepare, implement and
repair. Evaluation inputs remain protected independently of who runs the tools.

## Responsibilities

| Layer | Implemented | Remaining |
| --- | --- | --- |
| Configuration/reference | Versioned config/reference, working-tree fingerprints, input/build identity, session reference refresh that preserves budgets (v2 `reference`) | Weakened criteria still require an explicit owner decision reference |
| Execution | Suite coordination, bindings, reset, managed static builds and cleanup; Cinema exercised end to end | Static SPAs only; SSR and real Docker execution unverified |
| Privacy | Sanitizer, safe value comparison, structural diagnostics, private keys | Same-user execution is not isolated |
| Comparison | Selected values, scoped assertions, navigation, storage, ARIA, causality, contracts | Measured real-migration coverage; the three Cinema controlled regressions stay open |
| Project validation | Native commands, baseline comparisons and aggregate required coverage | Broader real-migration regression evidence beyond the recorded exercises |
| Agent integration | Normal scoped edits, persistent session history, CLI repair decisions, standard agent, complete P4 acceptance, recorded P5/P6 PASS | Cinema three-regression acceptance item and effort measurement |
| Optional helpers | Bounded worker privacy screens (contract content screening, trace projection) shipped as libraries inside `core` | discovery, codemods and the OpenAPI/test importers were retired with the restricted profile ([PLAN-V2](PLAN-V2.md) §8.2) and are not available |

No package-wide rewrite is required. Extend existing boundaries, version schemas
and preserve tested behavior where it still serves the product.

## Implemented surface

The CLI surface is the six v2 commands — `init`, `doctor`, `prepare`, `verify`,
`status`, `reference` — over the engine; the envelope and exit codes are specified
in [OPERATOR.md](OPERATOR.md). Capture, comparison and project-check building
blocks are reached through `prepare`/`verify` and the library APIs below, not as
standalone commands.

The repository is four packages. `core` holds the schemas and inferred types, the
platform paths, normalization, contract integrity, trace sanitization and the bounded
worker — the single source of truth the other packages import. `engine` holds
reference/session state, capture (scenario runner and temporal recorder) and
evaluation (equivalence, report and claim evaluation). `cli` (`harness`) and
`mcp-server` (`harness-mcp`) are thin front ends over the same engine.

The restricted profile and the previous 26-command surface were retired together
by owner decision on 2026-10-03 ([PLAN-V2](PLAN-V2.md) §8.2): the issued-workflow
protocol, its hooks and the other agent definitions went with them. The remaining
agent definition is
[.github/agents/migracao-padrao.agent.md](../.github/agents/migracao-padrao.agent.md),
an operator of the v2 cycle.

The implemented P3 operation coordinates native project checks, current builds,
all required scenarios and destination regression. P1 provides configuration, reference
and PASS/FAIL/INCONCLUSIVE report schemas, a library aggregator and reference
collection/verification over real project inputs. P2 added selected value comparison,
unit-scoped semantic assertions, per-application bindings, persistence read-back and
source repeatability, all with structural diagnostics. P3 now adds input/cwd
preflight and native commands with bounded process cleanup, plus
`withProjectBuildServers` for clean static builds, reserved loopback ports, bounded
immutable file snapshots, healthchecks and callback-scoped server cleanup.
`SERVED_BUILD` binds that session to configuration, declared inputs and served bytes;
build metadata participates in reference environment identity. `captureProjectSuite`
now coordinates native resets and all configured scenarios, uses the runner's
cancellation/build-navigation checks, sanitizes in memory and persists build-linked
capture outcomes plus observed source stability. It does not compare source/target
or issue/update references on its own. The operations behind `prepare` and `verify`
now add reference integration, comparisons/assertions, aggregate reporting and the
v2 envelope.

P4 wraps that verifier with the session layer — preparation with immutable baseline
scope in one operation, controlled reference refresh (`reference`) and state
inspection (`status`) — plus deterministic storage per project pair, exclusive
attempt reservation, hash-linked outcomes and reports, scope checks before/after the
complete run and persistent attempts/active-time/no-progress limits. The engine's
`migration-scope` module fingerprints
current public trees, never follows links and excludes declared generated outputs.
Private entries are opaque metadata; .git/dependencies are excluded. The standard
agent makes normal edits inside `target.writePaths`; no command edits the candidate.
P4 acceptance is complete and P5/P6 have recorded PASS runs; the Cinema
three-regression acceptance item remains open (see [STATUS.md](STATUS.md)).

## Trust and evidence boundaries

- Raw runtime data stays outside the assistant channel; diagnostics are safe projections.
- Code generation, mapping hints and the assistant's opinion cannot override results.
- Source/reference/required criteria cannot be changed during ordinary target repair.
- Coverage additions and legitimate binding changes are versioned and rerun on both sides.
- Changed requirements, ignored differences and reduced coverage require owner review.
- Candidate/build identity binds the final suite to the bytes actually served.
- Local hashes/hooks/scans are not isolation against same-user access. Local execution
  requires explicit project-command authorization; Docker is optional, not presumed.
- Approved critical contracts keep their approval/integrity semantics in both profiles.

See [ASSISTANT-INTEGRATION.md](ASSISTANT-INTEGRATION.md) for the integration contract
and [OPERATOR.md](OPERATOR.md) for the commands that actually exist.
