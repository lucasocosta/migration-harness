# Architecture — RFC v0.2

## Center of gravity

The `EquivalenceValidator` is the core of the product. Angular, React, codemods and LLMs are adapters/mechanisms around it.

```text
MigrationUnit
     │
     ├──────────────► ScenarioRunner ─► SourceTrace
     │
     ▼
TransformationPlan
     │
  Codemod / LLM
     │
     ├──────────────► TransformationManifest
     ▼
Target Candidate
     │
     └──────────────► ScenarioRunner ─► TargetTrace

SourceTrace + TargetTrace + BehaviorContract + TransformationManifest
                              │
                              ▼
                    EquivalenceValidator
                       │           │
                  EQUIVALENT   NOT_EQUIVALENT
                                    │
                             FailureClassifier
                                    │
                              Bounded Repair
                                    └──► verify again
```

## Non-negotiable invariants

1. Approved contracts are immutable to transform/repair workers.
2. Raw traces never cross the harness-to-assistant channel; same-user reads outside that channel remain a policy-controlled residual risk.
3. Blocking gates cannot be overridden by confidence scores.
4. Transformation manifests are hints, not truth.
5. Runtime observations are evidence, not automatically requirements.
6. Validation is independent from transformation.

## Validation dimensions

The validator now evaluates network, navigation, storage/state, ARIA semantics, declared causal ordering and approved critical contract gates. Runtime JSON is validated at boundaries. The trace-sanitizer owns the raw-to-sanitized boundary and emits a separate structural projection for workers.

The engine provides private artifact storage, an audit chain and a bounded repair coordinator. Workers return data-only patches; DockerSandbox is the explicit adapter for isolated generated-code execution. The pilot uses a conservative codemod and deterministic repair provider with real Angular/React browser execution. See `STATUS.md` for remaining production scope.

The primary semantic workflow is now external composition: harness-issued `brief` ->
human-driven assistant submission -> `apply-patch` -> `run --max-repairs 0`. Apply
binds candidate paths, hashes and static gates to issuance and records public artifacts.
The HTTP worker is an optional adapter, not a required model API integration. See
`ASSISTANT-INTEGRATION.md` for boundaries and the separate recorded-session requirement.
