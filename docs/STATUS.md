# Status

Updated: 2026-09-06. Branch `next/angular-forms-and-io`, on top of commit `3b0fad2`
plus an uncommitted correction set (audit findings R1-R9, read-only destination
context, Copilot manual and migration agents).

This file replaces the former `IMPLEMENTATION-STATUS.md`, `PROGRESS.md`,
`HANDOFF.md` and `MVP-PLAN.md`. RFC v0.2 and `research.md` remain the
architectural specification; `REVIEWS.md` records review decisions.

The RFC is **not production-complete**. The core workflow and the executable
pilots are delivered. The limits below must stay visible when the harness is
applied to a real migration: unsupported semantics must produce review or
escalation, never fabricated certainty.

## Verification snapshot

Measured on the current tree, in this order:

| Check | Result |
| --- | --- |
| Strict workspace build (`tsc -b`) | PASS |
| Unit/CLI suite (`node --test tests/*.test.mjs`) | 92/92 PASS |
| Chromium suite (`node --test tests/browser/*.test.mjs`) | 13/13 PASS |
| `scripts/smoke.mjs`, `scripts/smoke-v02.mjs` | PASS |
| `scripts/pilot.mjs` | PASS, `artifacts/pilot-5ZpYVI`, EQUIVALENT after one bounded repair |
| `scripts/pilot-assistant.mjs` | PASS, `artifacts/pilot-assistant-WSkbqf` |
| `git diff --check` | PASS |

Passing this baseline does not mean the implementation work is exhausted, and it
does not certify any real migration. See `VALIDATION.md` for what each run
covers and what it deliberately does not.

## Delivered, with limits

| RFC area | Delivered | Limits |
| --- | --- | --- |
| MigrationUnit / discovery | TypeScript symbols, tsconfig aliases, dependency closure, Angular templates/selectors/pipes, route ownership, guards/resolvers, constructor DI, explicit root lifetimes, fetch/HTTP endpoints, initial RxJS classification | Dynamic modules/routes, complex provider scopes, composite selectors and application-wide lifetime inference require review |
| Runtime schemas | Scenarios, events, traces, contracts, units, plans, manifests, results, CLI policy | Valid schema/metadata is not provenance authentication |
| Scenario execution | Fresh contexts, pre-boot mocks/storage at context level, typed actions, pre-armed response signals, explicit completion, origin filtering, opt-in WebSocket frame capture/prophecy, opt-in service workers with one-to-one forwarding verification | Automatic in-page causal instrumentation is a deliberate non-goal (see below). Causal attribution stays declared: scenario steps, request→response, WS-frame attribution |
| Trace recording | Request identity correlation, navigation, ARIA JSON/YAML, step storage deltas, async draining, body omission, deadline cleanup, worker-owned exchange observation | Recording stays protocol-level; nothing is injected into the page. App-internal provenance (timers, RxJS orchestration, postMessage, boot fetches) is not captured; unprompted requests carry the harness-declared trigger; step-boundary attribution is timing-sensitive |
| Sanitization | Strict event envelope, denylist, application allowlists, PII patterns, keyed pseudonyms, structural-only worker projection | PII patterns cannot recognize arbitrary personal data; application allowlists require review |
| Artifacts | Separate native-filesystem raw domain, verified 0700/0600, exclusive writes, path/symlink/inode checks, raw retention, hash-chained audit, opt-in AES-256-GCM sealing, versioned keyring with rotation, purge-time backup generations, external audit anchoring, exclusive locks on key generation, raw lifecycle, audit updates and anchor appends | External anchoring is an integrity-detection copy of the chain head, not trusted timestamping; same-UID attackers are not fully isolated; private roots must enforce POSIX modes |
| Critical contracts | Execution-ID mining, nonblocking network/storage/stable-navigation/ARIA synthesis, evidence fusion, OpenAPI local references, bounded `allOf` object-field extraction, `oneOf`/`anyOf` alternative convergence with disagreement findings, explicit local ref-map for external references, structured-test imports, explicit review/approval, portable SHA-256, critical gates | Conditional (`if`/`then`/`else`, `dependent*`) and general composed schemas and unstructured test extraction remain review gaps; external refs resolve only through the explicit local map and are never fetched; execution IDs are not provenance signatures |
| Equivalence | Network shapes/status/transport/path params, navigation, state, ARIA, declared causal partial-order alignment | Request values are compared by shape; causal edges are declared only, never inferred; app-autonomous requests are compared as unordered exchanges within (trigger, path) groups; graph alignment is bounded and fails closed |
| Transformation | Semantic plan, Angular codemod with decorated IO and synchronous reactive forms, normalized builder groups, manifest mappings; structured async-validator evidence and provider scopes feed the semantic/manual lanes | Async validators, FormArray, dynamic controls, ngModel mixing and side-effectful subscriptions require semantic/manual review; complex DI lifetimes and streams are unsupported by the codemod |
| Repair | Classification, method repair, candidate hashes, protected-oracle checks, bounded repair briefs, target recapture | Repair briefs localize HTTP-method mismatches only; caller-supplied attempt counters are not a global retry ledger |
| Worker execution | Primary assistant-driven CLI: issued briefs, baseline/protected-input checks, package/file boundaries, read-only destination context (`--context-files`), content screens, optional pre-write typecheck/lint, handled-failure rollback and audit; optional HTTP provider and Docker adapter retained | Same-user assistant reads and archive mutation are policy-controlled, not isolated or authenticated; static scanning is defense in depth; multi-file writes are not crash-atomic; Docker unavailable in this WSL |
| Quality gates | Integrity, security, required scenarios, equivalence, TypeScript, trusted-config ESLint, axe, measured coverage, eligibility precedence | Human accessibility evaluation and application-specific lint/security policy remain external review responsibilities |
| Pilot DoD | Deterministic Angular/React pilot and assistant-protocol CLI/browser demo: regression, repair, scope refusal, unchanged approved fixture, verified audit | Synthetic approval is test data only; the protocol demo uses a codemod, not a recorded human-driven assistant session |
| Migration workflow | Portuguese Copilot manual, reusable migration specification template, two tool-restricted Copilot agents and a `PreToolUse` boundary hook derived from the issued brief | Never executed against a real Angular/React pair; the hook is defense in depth, not isolation, and hooks in agent files are a Preview VS Code feature |

Delivery of RFC phases 1-5 (differential equivalence, critical contracts,
discovery, transformation, repair) is represented in the executable pilots.
`pnpm pilot` demonstrates the integration; `pnpm test` and `pnpm test:browser`
cover regressions and security constraints. Neither pilot needs model API
access.

## Resolved scope decisions

- **No model API integration** (2026-09-05). The Transform/Repair worker is a
  human-driven coding assistant driving the CLI with bounded briefs; every
  submission passes the same deterministic gates. RFC §33.II therefore shifted
  from architectural guarantee to policy plus tooling, with an honest residual-risk
  statement. `HttpWorkerProvider` stays as a demoted optional adapter; the former
  "external model service with credentials" item is obsolete by design.
- **Automatic application-wide causal instrumentation: deliberate non-goal**
  (2026-09-05). An injected in-page observer cannot be inert — wrapping app
  natives perturbs the execution it measures — and would run harness code inside
  untrusted page content. Auto-derived edges would normative-ize non-observable
  machinery (a framework-idiom detector, e.g. Zone.js asymmetry). Genuine causal
  requirements belong in approved contract invariants. Optional future lane, only
  on evidenced review pain: protocol-level `request.initiator()` provenance,
  raw-side only, non-comparable, dropped by the sanitizer projection.
- **Navigation order is meaningful** and must not be replaced by a URL multiset
  (rejected review suggestion SF-4; see `REVIEWS.md`).

## Remaining work

Not blocked, real work:

- [ ] Record a real human-driven, brief-only assistant session (integration
  §6.2). `pilot-assistant.mjs` uses deterministic codemod submissions and does
  **not** prove this. A maintenance session that has read harness internals
  cannot honestly be relabeled as that clean-context session.
- [ ] Execute the migration workflow end to end against a real Angular and a
  real existing React repository. `COPILOT-MIGRATION.md` and
  `templates/MIGRATION-SPEC.md` are written but unproven: no `apps/`,
  no `migrations/`, no filled specification, no real contract. This overlaps
  the §6.2 requirement; one real migration in a clean conversation closes both.
- [ ] Transformations for async validators, FormArray, dynamic controls, ngModel
  mixing, side-effectful `valueChanges`, complex provider lifetimes and stream
  orchestration. These stay in the LLM/MANUAL lanes today.
- [ ] OpenAPI conditional (`if`/`then`/`else`, `dependent*`) and general composed
  schemas, and extraction from arbitrary test frameworks beyond structured
  assertion imports.

Blocked by environment or reserved for humans:

- [ ] Execute `DockerSandbox` against a real local digest-pinned image. Docker is
  unavailable through this WSL integration. Still relevant: it bounds
  harness-side execution of generated code.
- [ ] Human accessibility review and actual approval of a real migration
  contract. Synthetic fixture approval does not satisfy this.
- [ ] `/mnt/c` does not enforce the required private modes, so private artifacts
  live on the native Linux filesystem. Same-UID isolation remains policy.

## Continuation notes

- The harness is the oracle. Apply `PASS` is neither behavioral equivalence nor
  `PR_READY`. EQUIVALENT holds for the scenarios and policy executed, nothing
  wider.
- Same-user filesystem reads, archive tampering and hostile concurrent directory
  mutation are not isolated or authenticated. `AGENTS.md`, the brief-only
  discipline and the boundary hook are policy plus tooling, not a sandbox.
- Issuance is local to the artifact root. Briefs from older checkpoints lack
  issuance records and must be reissued by the harness. Do not fabricate
  registry entries.
- Changing a candidate baseline requires a fresh brief, not just a new
  `beforeHash`. Unexpected changes to protected inputs require review.
- Repair attempt counters are caller-supplied, not a persisted retry ledger.
- The `next` command covers the first scenario only. Run every required scenario
  separately.
- Handled write/persistence failures roll back; multi-file writes are not
  crash-atomic. After a crash, confirm no writer remains, inspect
  candidates/audit, then remove `.harness-assistant.lock` from both roots. Never
  bypass locks automatically or reuse stale evidence.
- Key rotation retains old versions on purpose; automatic pruning was disabled so
  that retained backups stay readable. Never delete key versions without a
  recovery plan.

## Commands and environment

```bash
npx --yes pnpm@10.15.0 build
node --test tests/*.test.mjs
node --test tests/browser/*.test.mjs
node scripts/smoke.mjs
node scripts/smoke-v02.mjs
node scripts/pilot.mjs
node scripts/pilot-assistant.mjs
git diff --check
```

Tests import `dist/`; build first. Node 20.20.1; `pnpm` absent from PATH;
Playwright pinned to 1.63.0 with Chromium installed. Docker unavailable. Private
raw artifacts use native Linux storage (0700/0600) outside the repository; do not
inspect their contents. No dev server is required for CLI work; the pilots close
their own fixture servers.

No remote publication has been requested or performed.
