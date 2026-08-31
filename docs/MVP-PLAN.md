# MVP Plan — v0.2

## Phase 1 — Differential equivalence

Use a real Angular implementation and a manually equivalent React implementation. Do not add LLM migration yet.

1. Runtime schemas.
2. ScenarioRunner.
3. Robust TraceRecorder.
4. Sanitization boundary.
5. Source/target execution.
6. Normalization.
7. Network EquivalenceValidator.
8. Structured EquivalenceResult.
9. Intentional PUT→POST regression test.

Current scaffold implements items 2, a substantial part of 3, initial 4, and the network core of 6–9.

## Phase 2 — Critical contracts

Evidence candidates → evidence fusion → review/approval → integrity → contract gates.

## Phase 3 — Discovery

TypeScript + Angular template + routes + APIs/services + RxJS classification + dependency graph.

## Phase 4 — Transformation

TransformationPlan → codemods → bounded LLM transform → TransformationManifest → existing validator.

## Phase 5 — Repair

Failure classification → localized context → minimal patch → sandbox → retry budget → revalidation → audit.
