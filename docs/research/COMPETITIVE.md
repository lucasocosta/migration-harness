# Competitive research and borrowable patterns

Compiled: 2026-09-27. Companion to [research.md](./research.md) (theory and limits) and
[RFC.md](../RFC.md) (product boundaries). This file maps the competitive landscape and
what can be borrowed without compromising the harness as an independent equivalence
oracle. It is not an implementation plan and does not change product authority.

Positioning in one line: **the assistant migrates; the harness independently verifies
observable behavior.** The AI agent lives outside this repository and consumes the
CLI (`prepare-migration`, `start-migration-session`, `verify-migration`, ...).
Equivalence under declared scope and policy is the product; code generation is not.

Current concrete use case is Angular page/component into an existing React app.
The intended horizon is any source/target framework or language, so anything that
hard-codes Angular→React or bakes generation into the verdict scores lower on fit.

Sources below are public product/docs pages consulted in 2026-09; verify claims
before citing them externally. Research tooling was partially degraded; entries are
best-effort from official sites plus established technical literature.

---

## 1. Landscape categories

| Category | Representative players | What they claim | Relation to this harness |
| --- | --- | --- | --- |
| Deterministic refactoring / code fleets | OpenRewrite, Moderne, Codemod.com, ast-grep, ts-morph, jscodeshift | Transform and govern code at scale | Adjacent: they change code; we prove behavior after change |
| AI app modernization | Amazon Q Developer Transform, GitHub Copilot App Modernization, Google Gemini Code Assist | Assess + generate modernization PRs | Adjacent: they generate; we must not treat generation as equivalence |
| Visual / functional regression | Applitools, Chromatic, Percy, BackstopJS, BrowserStack | Compare UI across versions of one app | Adjacent: same-app regression vs cross-stack preservation |
| AI E2E testing | Momentic, Reflect (SmartBear), QA Wolf, Testim, Mabl | Author/repair/maintain tests | Partial overlap on scenarios; they keep suites, we use scenarios as migration oracles |
| Traffic capture / HTTP asserts | HAR exporters, Hurl, MSW fixtures, Diffy | Capture or assert network behavior | Direct input/evidence patterns, not verdict competitors |
| Academic foundations | Necula translation validation, Godlin/Strichman regression verification, Feathers characterization, Daikon | Framing and limits | Already reconciled in research.md |

There is no widely adopted product that owns "independent behavioral equivalence
evidence for framework migration, with protected criteria and agent-safe privacy."
That gap is the strategic asset. Competitors optimize generation or regression of
one codebase; this harness optimizes the **verdict**.

---

## 2. Project notes and borrowable patterns

### 2.1 Diffy (differential proxy) — highest leverage

Concept: fan out live traffic to two builds, diff responses; run the **same** build
twice to classify volatile ("noisy") fields automatically before judging a candidate.

Borrowable:
- **Noise classification as a proposal, never as auto-normalization.** The harness
  already runs `limits.sourceRuns` (≥2) and records `UNSTABLE` / `reviewPaths`
  (`packages/equivalence-validator/src/stability.ts`). Today those paths are
  reported for owner review; the owner must declare `volatile*` or
  `acceptedDifferences`. Diffy's per-field ranking (divergence frequency across
  source runs) can turn `reviewPaths` into a **suggestion report**: field path,
  codes observed, run count, candidate policy snippets. Applying them still
  requires owner decision and reference versioning (RFC §7). Silent ignore would
  weaken criteria; `stability.ts` explicitly refuses that.
- Multiset / canonical ordering for independent operations — partially present via
  sorted projections and "no strict temporal order" (research.md §6).
- Side-by-side report UX with noisy fields highlighted — the aggregate
  `MIGRATION_REPORT` is honest but dense; a diff view improves owner review.

Fit: **high**. Framework-agnostic, sits entirely in `equivalence-validator` +
reporting, uses data already collected, never touches the agent channel.

### 2.2 OpenRewrite / Moderne — deterministic layer under optional helpers

Concept: Lossless Semantic Trees + recipes; deterministic machinery between agents
and code; recipe catalogs, dry-run diffs, data tables (findings + provenance).

Borrowable:
- **Provenance data tables for discovery.** `static-analyzer/discover.ts` and
  `planTransformation` can emit finding rows (symbol, location, severity, suggested
  unit) instead of only planner shapes. Helps owner-authored SPEC, not the verdict.
- **Dry-run diff semantics** for any codemod/transform preview before applying.
- Delegation idea: replace dense hand-rolled Angular transforms with maintained
  AST libraries (ts-morph / OpenRewrite JS) only where the restricted profile wants
  deterministic assists. `codemods/angular-component.ts` is ~409 lines of Angular
  specific logic — optional helper, not core.

Fit: **medium for inventory/DX, low for the equivalence core**. Angular/Java-centric
transform catalogs conflict with the "any framework later" horizon if promoted to
core. Keep as optional adapters (STATUS already lists discovery/codemods as optional).

### 2.3 Codemod.com — campaign control plane

Concept: structural search (ast-grep), org-wide campaigns, agent guardrails,
measurable progress, PR orchestration across teams.

Borrowable:
- **Campaign dashboard / progress metrics** over multiple units: attempts, budgets
  spent, PASS/FAIL/INCONCLUSIVE, coverage of declared inventory. Session state in
  `engine/migration-session.ts` already holds the raw material.
- Agent guardrail framing (blast radius before edits) — maps to scope checks that
  already run before/after verification.
- Fleet inventory UX for multi-repo pairs.

Fit: **medium**, mostly product surface and reporting. Do not import their
"reliably automate code changes" product identity.

### 2.4 Amazon Q Developer Transform / GitHub Copilot App Modernization

Concept: assess → plan → transform → validate → deliver, waves/hubs, multi-repo PR
campaigns; enterprise modernization programs.

Borrowable:
- Explicit **assessment/audit phase** as first-class SPEC input (inventory + risk +
  suggested waves). Aligns with expanded `discover`.
- Phased delivery narrative and audit artifacts for the owner — documentation shape,
  not engine behavior.

Do **not** borrow: generated tests as self-approval, or "transform success =
migration success". RFC §11 forbids mapping generation/apply success to behavioral
PASS. That anti-pattern is exactly what this product exists to refuse.

Fit: **low–medium** as process/UX; negative as oracle.

### 2.5 Applitools / Chromatic / Percy — visual and interaction layers

Concept: Visual AI, interaction checks, a11y snapshots, human UI sign-off, MCP for
coding agents, "do not let probabilistic AI validate AI code" marketing.

Borrowable:
- **Per-checkpoint screenshot / perceptual diff as optional evidence** (RFC §9
  already allows optional visual evidence with disclosed limits). A broken CSS with
  identical ARIA/network currently can pass. Start non-blocking (WARNING), disclose
  flake/CI limits.
- **Viewport matrix** as an optional environment dimension (today
  `environment.viewport` is a single size).
- Chromatic-style **owner sign-off** workflow around evidence (maps to human review
  before release; do not auto-approve).
- Component-scoped capture via existing `unitScope` / component host (P6).

Privacy constraint (already in product rules): screenshots are raw observations
(PII risk). Keep them in private artifacts like traces; public report gets hashes,
dimensions, and structural diffs only. Never feed screenshots into the assistant
channel by default.

Fit: **medium–high** for visual dimension and sign-off UX. They compare one app
across time; this harness compares source vs target — do not rebrand as a visual
regression tool.

### 2.6 Momentic / Reflect / QA Wolf — scenario authoring and maintenance

Concept: natural-language tests, self-healing locators, app mapping, MCP servers so
coding agents write/run/fix tests from failures.

Borrowable:
- **NL / recorder-assisted scenario drafting** as preparation aid (assistant fills
  SPEC; human still authorizes scenarios and requirements).
- **Self-healing binding suggestions** when target DOM shifts: propose locator/binding
  updates under RFC §7 (versioned binding adaptation; semantic actions unchanged;
  cannot hide a missing control). Ambiguous mapping stays owner review.
- **Platform / workflow map** → proposed scenario inventory (coverage gaps then
  become explicit in reports).
- **MCP surface for the CLI** so external agents (Claude Code, Cursor, Codex) call
  prepare/verify/status/repair feedback without fragile shell glue. Completeness is
  still defined by harness checks, not by the agent.

Fit: **high for DX and the "agent outside uses CLI" mandate**; medium for self-healing
because bindings are semantic, not just selectors.

### 2.7 Hurl / HAR / MSW — human inputs and traffic carving

Borrowable:
- **HAR importer** next to existing OpenAPI/test-evidence importers
  (`contract-synthesizer/src/importers.ts`): HAR → mock sequences, fixture candidates,
  optional invariant hints. Attacks the "synthetic-only evidence" limitation without
  weakening protection (still operator-supplied files, still fingerprinted fixtures).
- **Hurl-like human-readable frontend** for network expectations and critical
  contracts that compiles to the strict migration schemas. JSON stays the schema of
  record; a `.hurl`-style authoring format is DX only.
- MSW-style default-deny unhandled requests is already the mock discipline; keep.

Fit: **high** for HAR + contract authoring DX; orthogonal to frameworks.

### 2.8 Harness engineering / long-running agent loops

Checkpointing, budgets, no-progress detection, testable definition of done — largely
present (`maxRepairAttempts`, `maxDurationMs`, session persistence). Borrow only the
language of "completion behaviors that can be tested" for docs/evaluation papers.
This harness's budget and protected-evidence model is already stronger than most
agent-loop writeups.

### 2.9 Formal methods (Alive2 / CompCert / translation validation)

Keep as **positioning and research framing** (research.md §2). Porting equivalence
modulo theories to UI traces is research, not an integration. Use in publications
and in the case for independent validation.

---

## 3. Match analysis vs this migration-harness

Scoring axes used below: (A) strengthens equivalence quality, (B) framework/language
agnostic on the multi-stack horizon, (C) respects "agent outside + CLI", (D) reduces
owner/assistant effort without weakening criteria, (E) does not blur independence.

| Candidate adoption | A | B | C | D | E | Overall match | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Noise suggestions from source runs (Diffy-style) | ● | ● | ● | ● | ● | **Best match** | Sits in stability/compare; proposes owner decisions; uses existing multi-run evidence; never auto-ignores |
| HAR importer | ● | ● | ● | ● | ● | **Best match** | Real-world fixtures behind existing import hygiene; improves realism of evidence |
| MCP CLI surface | ○ | ● | ● | ● | ● | **Best match** | Directly serves external agents; no change to verdict logic |
| Visual/screenshot dimension (optional) | ● | ● | ● | ○ | ● | Strong | Fails closed on CSS/layout; privacy rules already defined |
| Binding self-heal suggestions | ○ | ● | ● | ● | ● | Strong | Aligns with RFC §7; must stay versioned + human-on-ambiguity |
| Scenario inventory mapping / NL draft | ○ | ● | ● | ● | ● | Strong | Preparation speed; scenarios remain authorized inventory |
| Hurl-like contract authoring | ○ | ● | ● | ● | ● | Strong | Pure DX over existing schemas |
| Campaign dashboard / multi-unit metrics | ○ | ● | ● | ● | ● | Medium | Product surface on session state; not new evidence |
| Owner sign-off workflow | ○ | ● | ● | ● | ● | Medium | Formalizes human review already required by RFC |
| Viewport matrix | ● | ● | ● | ○ | ● | Medium | Small config/compare extension |
| Provenance tables from discover | ○ | partial | ● | ● | ● | Medium | Angular-biased today; format is generic |
| Codemods via ts-morph/OpenRewrite | ○ | ○ | ● | ● | ○ | Low–medium | Optional restricted helpers only; not core |
| Q/Copilot wave process UX | ○ | ● | ○ | ● | ○ | Low | Process fiction risk if it implies auto-validation |
| Deterministic recipe marketplace | ○ | ○ | ○ | ● | ○ | Low | Competes with generation players; wrong battlefield |

Legend: ● strong, ○ weak/partial.

### Best-fit summary

Given the stated responsibility — **guarantee equivalence**, with a **non-harness AI
agent** driving the CLI, on a path to **any framework/language** — the top matches
are the ones that improve the oracle and the agent/owner interface without importing
generation authority:

1. **Diffy-style noise proposals** on top of `verifySourceStability` (highest ROI).
2. **HAR → fixtures/invariants importer** (realism, framework-agnostic).
3. **MCP (and clearer CLI feedback) for external agents** (distribution + mandate).
4. **Optional visual dimension + privacy-safe screenshots** (coverage hole today).
5. **Binding/scenario assistance with human gates** (preparation effort).

Everything else is either optional helper debt (Angular codemods), reporting polish
(dashboard, sign-off), or wrong category (transform marketplaces, self-approving
test generation).

Angular→React remains the proving ground (Cinema P5, component-first P6). The items
above deliberately avoid encoding Angular DOM or React idioms into the comparison
engine so the same oracle can later face other pairs.

---

## 4. Suggested priority order (not a committed PLAN backlog)

| # | Item | Impact | Effort | Primary packages | Constraint to preserve |
| --- | --- | --- | --- | --- | --- |
| 1 | Per-field noise **suggestions** from source runs | High | Low–med | `equivalence-validator`, `quality-gates` | No auto `acceptedDifferences`; owner decision + reference version (RFC §7) |
| 2 | HAR importer | High | Med | `contract-synthesizer` | Operator-supplied, fingerprinted fixtures; no raw leakage |
| 3 | MCP server / structured CLI events for agents | High | Med | `cli`, docs | Harness still sole issuer of PASS/FAIL/INCONCLUSIVE |
| 4 | Optional screenshot/visual diff at checkpoints | Med | Med | `scenario-runner`, `trace-recorder`, compare | Private artifacts; WARNING-first; disclosed limits |
| 5 | Binding adaptation suggestions | Med | Med | compare + session | RFC §7 versioning; cannot hide missing controls |
| 6 | Scenario/workflow map → inventory proposals | Med | Med | `static-analyzer` | Inventory is declared; gaps stay visible in reports |
| 7 | Human-readable contract frontend (Hurl-like) | Med | Low | docs + schema compile step | Strict schemas remain source of truth |
| 8 | Multi-unit campaign dashboard | Low–med | Med | `engine` reports | Metrics are not a verdict |
| 9 | Provenance tables for discover/plan | Low | Low | `static-analyzer`, `transformation-planner` | Generic rows, not Angular-only vocabulary in core |
| 10 | External AST libs for optional codemods | Low | High* | `codemods` | *Low if delegated; high if rewritten. Stay optional |

---

## 5. Explicit non-goals (do not adopt)

- Treating generated code, recipe success, or apply PASS as behavioral success.
- Auto-approving contracts, accepted differences, or volatility from mined data.
- Becoming a codemod marketplace or an AI modernization PR generator as the core.
- Sending raw traces, screenshots with PII, or secrets into any assistant channel
  (including MCP tool results).
- Silent weakening of the suite to turn FAIL into PASS (RFC §7).
- Formal equivalence claims beyond declared scenarios and policy.

## 6. Licensing and repo policy

- Diffy, OpenRewrite/Moderne recipes: Apache-2.0 ecosystem; ast-grep: MIT; Hurl: MIT;
  ts-morph: MIT. Check each dependency’s NOTICE before vendoring or linking.
- This repository is MIT-licensed ([LICENSE](../../LICENSE)) and remains private on
  GitHub. External derivative work and reusable recipes must keep license
  compatibility and attribution; do not silently mix licenses.
- Borrow ideas and formats freely; do not copy code without license compatibility
  and attribution.

## 7. Open questions

1. Should noise suggestions live in the public report or only in an operator
   preparation tool (safer for criteria, less discoverable)?
2. Is MCP a first-class supported agent surface or an adapter that must not become
   a second authority?
3. For multi-stack horizon: is Playwright-only observation a portability ceiling
   (e.g. native mobile, SSR)? RFC already defers SSR/Docker verification.
4. Does visual evidence ever become blocking, and under what owner-approved policy?
5. How to measure owner interruptions (RFC §15) when adopting the DX items above?

## 8. Related docs

- [research.md](./research.md) — translation validation, characterization, Playwright limits.
- [RFC.md](../RFC.md) — roles, profiles, comparison dimensions, repair, security.
- [STATUS.md](../STATUS.md) / [PLAN.md](../PLAN.md) — what is actually delivered.
- [USAGE.md](../USAGE.md) — implemented CLI and current limits.
