# REVIEW — Codex implementation audit

Date: 2026-09-05. Scope: uncommitted working tree (~2,500 LOC TS, 14 packages).
Provenance: (1) compliance check of RFC v0.2 + `docs/research.md` + `docs/MVP-PLAN.md`
against the implementation, (2) deep code review (security, correctness, quality),
(3) direct execution of the build and full test suite.

Nothing in this file has been applied yet — this is a record of findings and pending work.

## 1. Validation evidence (as reviewed)

| Check | Result |
| --- | --- |
| `tsc -b` (15 workspace projects) | PASS |
| Unit tests (`tests/*.test.mjs`) | 16/16 PASS |
| Browser tests (`tests/browser/*.test.mjs`, real Chromium) | 3/3 PASS |
| Pilot (`node scripts/pilot.mjs`, 4 runs in `artifacts/pilot-*`) | EQUIVALENT; synthetic approval labeled as such |
| Playwright 1.63.0 supports all APIs used (`ariaSnapshotJSON`, `routeWebSocket`, …) | CONFIRMED in lockfile |

## 2. Must-fix corrections

### MF-1 — FSM lets `CONTRACT_SYNTHESIS` bypass REVIEW
- Where: `packages/engine/src/state-machine.ts:51-53`
- Problem: `contractApproved()` accepts both `CONTRACT_REVIEW` and `CONTRACT_SYNTHESIS`,
  allowing `CONTRACT_SYNTHESIS → CONTRACT_APPROVED` without passing through
  `CONTRACT_REVIEW`. RFC mandates DRAFT → REVIEW → APPROVED. The `contract-review`
  package enforces this independently (`integrity-verifier.ts:45`), but the FSM is a
  second enforcement layer and here it isn't.
- Aggravator: `tests/transformation.test.mjs:18` ("FSM cannot skip human review") never
  exercises the bypass path — the suite asserts a guarantee the code does not provide.
- Fix: accept only `CONTRACT_REVIEW`; add a test asserting the bypass attempt throws.

### MF-2 — Dynamic-code AST scan is a bypassable denylist
- Where: `packages/llm-worker/src/bounded-worker.ts:55-64`
- Problem: catches literal `require` / `eval` / `Function` / `import()` identifiers and
  `new Function/Worker/SharedWorker`. Misses: aliased eval (`const e = eval; e(x)`),
  indirect eval (`(0, eval)(x)` — ParenthesizedExpression, not Identifier),
  `obj.constructor('code')`, `globalThis['eval']`, `setTimeout('code')`, `process.dlopen`,
  `vm`/`child_process` via any allowed re-exporting package. Patches are written to disk
  before any sandbox run, so this scan is the only pre-disk gate.
- Fix: invert to an allowlist (call targets must resolve to known-safe identifiers), or
  explicitly document `DockerSandbox` as the sole boundary and the scan as best-effort —
  and add adversarial tests (none exist today; `security.test.mjs:67-71` only tests a
  forbidden *import*).

### MF-3 — Contract hashes are machine-dependent (`localeCompare`)
- Where: `packages/contract-review/src/integrity-verifier.ts:10`
- Problem: `canonicalize` sorts keys with `a.localeCompare(b)` (default-locale collation,
  ICU-dependent). Contract hashes are persisted artifacts re-verified later, possibly on
  another machine: `'Z'` vs `'a'` order differently under case-insensitive collation vs
  codepoint order → false `CONTRACT_INTEGRITY_FAILURE`. The codebase also now has TWO
  divergent canonicalizations: core `canonical` (`normalization.ts:8`, codepoint `<`)
  used for the audit chain, and `canonicalize` (localeCompare) used for contract hashes.
- Fix: reuse core `canonical` for `computeContractHash` — one implementation, deterministic.

### MF-4 — Mock `fixturePath` is unvalidated filesystem access
- Where: `packages/scenario-runner/src/index.ts:74-76` (schema check: `schemas.ts:33`)
- Problem: `resolve(fixtureBaseDir ?? cwd(), fixturePath)` with no containment. A scenario
  file can point a mock at `../../.migration-private/raw/...` or any host file; content is
  served to the page, recorded into the trace, and lands in *sanitized* artifacts. Scenario
  authors are semi-trusted, but this crosses the raw/sanitized domain boundary the RFC
  explicitly separates.
- Fix: constrain to `fixtureBaseDir` via `relative()` containment + reject any path
  containing `.migration-private`.

## 3. Should-fix corrections

### Sanitization
- **SF-1** `trace-sanitizer/src/index.ts:30` — payload allowlist defaults to
  allow-all when no policy is set (`policy.allowedPayloadKeys && ...`), while storage
  keys (line 58) default to deny-all. Inverted defaults for the same risk class. Require
  an explicit payload allowlist (or default deny) for anything leaving the raw domain.
- **SF-2** `trace-sanitizer/src/index.ts:36,45-46` — `new URL(value)` throws on invalid
  input; `decodeURIComponent` throws `URIError` on stray `%`. App/server-controlled URLs
  can abort the whole sanitize step. Wrap in try/catch → opaque marker + count.
- **SF-3** `trace-sanitizer/src/index.ts:56` — ARIA `url` values only get PII scrub;
  the dedicated `url()` handler (query stripping, credential removal) applies only to
  HTTP/NAVIGATION events. `?token=...` survives in sanitized artifacts. Route
  `ariaKeys`-`url` values through `url()`.

### Equivalence (direct RFC deviations)
- **SF-4** `equivalence-validator/src/dimensions.ts:15-18,31` — NAVIGATION compared as a
  strict ordered sequence of URLs. RFC: causal partial-order is the default; strict
  sequence is NOT. Multi-step flows will false-flag. Use multiset/ends-with or
  causality-based alignment.
- **SF-5** `equivalence-validator/src/network/index.ts` — no volatile *value* handling:
  path param values (line 78) and query values compare exactly; no `volatileBodyFields`
  policy exists; storage values compare literally (`dimensions.ts:23`). Server-generated
  ids will cause NOT_EQVALENT storms on real apps → escalation fatigue or policy
  loosening. Add per-template param-value volatility + body-field volatility mirroring
  `volatilePayloadFields`.
- **SF-6** `equivalence-validator/src/network/index.ts:35` — when a
  `PathTemplateRule.pattern` matches but `matchPath` fails, the raw path is injected as a
  "param". Throw or skip the rule — never fabricate params.

### Contracts
- **SF-7** `contract-synthesizer/src/invariant-miner.ts:23` — distinct-run check is
  index-only: the same trace replayed with different `runIndex` passes. Also require
  distinct `startedAt` (or distinct `eventId` sets).
- **SF-8** `contract-synthesizer/src/synthesize.ts:11` — network-only synthesis:
  `storageDeltas: []` hard-coded; ARIA/navigation invariants never mined. At minimum,
  surface this in the contract-approval UX so reviewers know what they are approving.

### FSM / disposition semantics
- **SF-9** `engine/src/state-machine.ts:47-50` — `synthesisCompleted(needsReview)`
  ignores its parameter. Behavior (always → CONTRACT_REVIEW) is the safe one, but the
  API lies. Drop the param or wire it.
- **SF-10** `engine/src/repair-loop.ts:32` — EQUIVALENT results return
  `disposition: 'UNKNOWN'`, a failure-class value. Model success as `null`/`'NONE'`.
- **SF-11** `quality-gates/src/evaluate.ts:8` — `SCENARIO_FAILED → NON_DETERMINISTIC`
  routes a deterministically failing scenario (a real regression) to contract escalation
  instead of blocking failure. Separate code or UNKNOWN.

### Boundaries / misc
- **SF-12** `engine/src/artifacts.ts:36-39` — TOCTOU between the lstat walk and
  `open('wx')`: a symlink swapped into an intermediate directory is followed. 0700 private
  root mitigates for raw; the public root (0755, shared) is exposed. After open,
  `realpath(target)` and verify prefix, or open via a dirfd chain.
- **SF-13** `scenario-runner/src/index.ts:69` (with `browser.ts:15`) — `page.route`
  mocks preempt the context-level origin allowlist: a mock glob can fulfill cross-origin
  requests without hitting the abort. Enforce the allowlist inside mock handlers too.
- **SF-14** `llm-worker/src/bounded-worker.ts:74` — candidate paths allow `.js`/`.jsx`;
  TSX detection `endsWith('x')` misclassifies. Restrict to `.ts`/`.tsx`.
- **SF-15** `cli/src/index.ts:98` — `safeArtifactPath(dirname(path), basename(path))` is
  a tautology (resolving a basename against its own dir can never escape). Remove or
  replace with a root-containment check; the real guards (regex + nlink +
  read-compare-rename) are decent.

## 4. Nits and test gaps

Nits:
- `dimensions.ts:13` — `divergenceId` is the bare `code`; duplicates possible across
  dimensions (schema does not enforce unique ids).
- `dimensions.ts:28` — `'evt_'` prefix convention couples validator to recorder id format.
- `temporal-recorder.ts:111-112` — `ariaSnapshot()` and `ariaSnapshotJSON()` are two
  separate captures; DOM change between calls yields an inconsistent pair.
- `temporal-recorder.ts:220-221` — `request.response()` returning null silently drops the
  terminal event; consider HTTP_FAILED fallback.
- `codemods/angular-component.ts:53` — regex permits `-` then `includes('-')` rejects it.
- `static-analyzer/src/discover.ts:76` — `node.parent as ts.NamedDeclaration` cast;
  `:118` default entrypoint = first component (arbitrary); `:126` `resolvedSymbolsCount`
  counts all symbols, not unit-internal.
- `core/src/schemas.ts:35` — `steps` has no `.min(1)`; zero-step scenarios validate.
- `engine/src/artifacts.ts:33` — public `write()` accepts any value; nothing type-level
  prevents writing a raw trace to the public domain (current call sites are correct).
- `contract-synthesizer/src/scrubber.ts` — pure re-export facade; no value.
- `scenario-runner/src/index.ts:94,110` — `as never` casts bridging schema enums to
  Playwright (document them).
- `browser.ts:12` / recorder — hard-coded `pt-BR` locale in a generic harness.
- `package.json:21` — `^1.63.0` caret, not a pin (lockfile holds 1.63.0 today).
- `state-machine.ts:77` — UNKNOWN disposition and budget-exhausted both land in
  `ESCALATE_PR`; clarify semantics.

Adversarial test gaps (none covered today):
- `__proto__` / `constructor` key pollution in the sanitizer projection
- unicode / NFC normalization in PII scrubbing
- malformed-URL sanitizer input
- indirect-eval / aliased-eval patch rejection
- purge with symlink inside raw root
- contract hash stability across locales

## 5. Remaining work (from the compliance pass)

Confirmed-compliance gaps and process items not yet addressed by anyone:

1. **Commit the work.** 48 modified + ~20 new files, the entire implementation, is
   uncommitted. One bad `git clean` loses everything. Commit in logical slices.
2. **Document the synthesis gap.** `IMPLEMENTATION-STATUS.md` lists missing
   OpenAPI/existing-tests importers but not that synthesis is network-only (SF-8) — the
   "Limits" table should say storage/ARIA/navigation invariants are never auto-synthesized.
3. **Dead placeholder adapters.** 13 "Week 2 adapter" files with ZERO consumers (verified
   by grep): `static-analyzer/{typescript,angular-template,rxjs,routes,graph}`,
   `quality-gates/{a11y,aria,eslint,network,storage}`,
   `llm-worker/{repair,transform}/index.ts`, `engine/context/index.ts` — plus
   `MVP_MINIMUM_COVERAGE_POLICY`. Type-only, no runtime risk, but dead API surface:
   delete, or mark clearly as RFC extension seams.
4. **Self-declared, still-open limits** (per `IMPLEMENTATION-STATUS.md`, verified honest):
   - No real LLM ever exercised: `HttpWorkerProvider` untested; `BoundedWorker` only ever
     driven by a deterministic in-script provider; `DockerSandbox` never executed (no
     Docker in this WSL).
   - CLI automatic repair localizes exactly one fetch-method case.
   - Discovery is shallow: guards/resolvers, constructor DI lifetime, complex imports,
     route ownership unresolved.
   - No WebSocket / service-worker scenario adapters.
   - No ESLint / axe integrations; human accessibility evaluation external.
   - Encryption, key rotation, backup retention, external audit anchoring remain
     operational responsibilities.
   - `examples/e2e-customer-profile/` + `scripts/e2e_browser.py` are orphaned legacy
     (unused by npm scripts) — delete or repurpose.

## 6. Suggested fix order

1. MF-3 (portable hash — ~1 line, reuse core `canonical`)
2. MF-1 (FSM guard + bypass-rejection test)
3. MF-4 (fixturePath containment)
4. MF-2 (allowlist or document Docker as sole boundary + adversarial tests)
5. SF-4 / SF-5 (partial-order navigation + volatile values — RFC-critical)
6. SF-1 / SF-2 / SF-3 (sanitization defaults and robustness)
7. Remaining SFs, then nits and adversarial test gaps
8. Item 5.2 (status doc), 5.3 (placeholders), 5.1 (commit slices) as hygiene

## 7. Overall verdict

Unusually disciplined for agent-generated code: strict zod schemas at every IO boundary,
fail-closed defaults in most paths (empty-trace BLOCKING, causal budget → BLOCKING,
exclusive writes, WeakMap correlation, listener cleanup in `finally`, pre-armed signals),
near-zero `any` (two `as never` casts total), and an honest status doc. Tests are real
(live Chromium E2E, real Angular fixture, injected regression) and pass. Weaknesses
concentrate where correctness meets policy: default-open sanitization knobs, a denylist
where the threat model demands an allowlist, an FSM guard that lags its package-level
twin, and non-portable contract hashes. Solid MVP core; not yet production-hardened at
the boundaries flagged above.
