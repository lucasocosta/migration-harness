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
| Configuration/reference | Versioned config/reference, working-tree fingerprints, input/build identity | Session reference refresh preserving budgets |
| Execution | Suite coordination, bindings, reset, managed static builds and cleanup | Real Cinema exercise; static SPAs only |
| Privacy | Sanitizer, safe value comparison, structural diagnostics, private keys | Same-user execution is not isolated |
| Comparison | Selected values, scoped assertions, navigation, storage, ARIA, causality, contracts | Measured real-migration coverage |
| Project validation | Native commands, baseline comparisons and aggregate required coverage | Real-migration regression evidence |
| Agent integration | Normal scoped edits, persistent session history, CLI repair decisions and standard agent | Complete P4 acceptance and P5/P6 demonstrations |
| Optional adapters | discovery, codemods, OpenAPI/test importers, manifests, bounded workers | Not prerequisites for standard verification |

No package-wide rewrite is required. Extend existing boundaries, version schemas
and preserve tested behavior where it still serves the product.

## Current versus proposed

Today `trace` captures one scenario; `compare` compares sanitized traces with an
optional contract/manifest. `run` requires an approved contract, expects both apps
already served, handles one scenario and has only a method-repair implementation.
Its output is not a complete migration report.

The existing `brief -> apply-patch -> run` integration is the **restricted**
profile. Keep issuance, protected hashes, read/write lists, patch screens, audit
and compatibility tests there. The two Copilot agents and hook implement that
profile; they are not an end-to-end standard agent.

The implemented P3 operation coordinates native project checks, current builds,
all required scenarios and destination regression. P1 provides configuration, reference
and PASS/FAIL/INCONCLUSIVE report schemas, a library aggregator and reference
collection/verification over real project inputs. P2 added selected value comparison,
unit-scoped semantic assertions, per-application bindings, persistence read-back and
source repeatability, all with structural diagnostics. P3 now adds check-projects
for input/cwd preflight and native commands with bounded process cleanup, plus
`withProjectBuildServers` for clean static builds, reserved loopback ports, bounded
immutable file snapshots, healthchecks and callback-scoped server cleanup.
`SERVED_BUILD` binds that session to configuration, declared inputs and served bytes;
build metadata participates in reference environment identity. `captureProjectSuite`
now coordinates native resets and all configured scenarios, uses the runner's
cancellation/build-navigation checks, sanitizes in memory and persists build-linked
capture outcomes plus observed source stability. It does not compare source/target
or issue/update references on its own. `prepare-migration` and `verify-migration`
now add reference integration, comparisons/assertions, aggregate reporting and CLI.

P4 wraps that verifier with `migration-session`: immutable baseline scope and
preparation, deterministic storage per project pair, exclusive attempt reservation,
hash-linked outcomes and reports, scope checks before/after the complete run and
persistent attempts/active-time/no-progress limits. `migration-scope` fingerprints
current public trees, never follows links and excludes declared generated outputs.
Private entries are opaque metadata; .git/dependencies are excluded. The new standard
agent makes normal edits, while restricted issuance/hooks remain unchanged.
Reference-refresh integration and full milestone acceptance remain pending.

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
and [USAGE.md](USAGE.md) for commands that actually exist.
