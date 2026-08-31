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
2. Raw traces never cross the LLM boundary.
3. Blocking gates cannot be overridden by confidence scores.
4. Transformation manifests are hints, not truth.
5. Runtime observations are evidence, not automatically requirements.
6. Validation is independent from transformation.

## Validation dimensions

MVP starts with network equivalence. Next: navigation, storage/state, ARIA semantics, causal ordering, then contract gates.
