# Continuation handoff

Updated: 2026-09-05. Branch: `next/angular-forms-and-io`.
Read `ASSISTANT-INTEGRATION.md`, root `AGENTS.md` and `PROGRESS.md` first.

## Current continuation

The inherited checkpoint was `a9a7f2d`, after Angular decorated IO/reactive forms,
builder normalization/provider evidence and the opt-in WebSocket adapter. The user
requested continuation and authorized commits. No remote publication was requested.

The assistant-protocol pilot initially failed its brief archive count (three briefs,
not four). The continuation also fixed real boundary weaknesses in the partial CLI:

- Separate assistant orchestration and filesystem helpers under `packages/cli/src/`.
- Match briefs against harness issuance, not only a recomputable hash; bind candidate
  root, brief-time hash/existence, protected source/oracle inputs and gate settings.
- Resolve public inputs before reading, refuse private-root aliases and candidate
  links/overlaps, bound JSON reads, reserve archive paths and protect output collisions.
- Strict LLM projection schema; screen every brief section, patches and manifests.
  Unsafe approved contracts are refused, not stripped or rehashed.
- Aggregate repair byte budget and scenario-local method failure projection.
- Pre-write optional TypeScript/lint gates, archived validated manifest in the next
  verify command, cooperative locks, staged writes and handled-failure rollback of
  candidates plus artifacts/audit. Partial-write cleanup has a fault-injection test.
- Corrected pilot: typecheck/lint enabled; Chromium rebuilds actual applied bytes;
  exact divergence exit asserted; deterministic simulation explicitly identified.
- Updated RFC 25/33.II, integration contract, AGENTS, USAGE, architecture and status.
  The primary workflow has no model API call; HTTP provider is optional.

## Verification

Final assistant-loop checkpoint: strict build and 60/60 unit/CLI tests passed,
including partial-write fault injection. Browser suite: 9/9 passed. Both smoke scripts
and the original pilot passed (`artifacts/pilot-ZCQfPl/`). The assistant protocol
pilot passed with unchanged fixture contract and valid audit
(`artifacts/pilot-assistant-hBzp77/`). `git diff --check` passed.

The next independent slice, bounded OpenAPI allOf field extraction, is being developed
after this validated checkpoint; do not claim it verified until its own build/tests.

## Remaining work

- Record a real human-driven, brief-only assistant session for integration section 6.2.
  `pilot-assistant.mjs` uses deterministic codemod submissions and does NOT prove this.
  The current maintenance session has read harness internals, so cannot honestly be
  relabeled as that clean-context migration session.
- Broader RFC: service-worker adapter, application-wide causal instrumentation,
  composed/conditional OpenAPI schemas and external references, advanced forms/DI/
  streams transformations, encryption/key rotation/backup retention/external audit.
- DockerSandbox live validation remains environment-blocked.
- Human accessibility review and approval of real migration contracts remain human
  responsibilities; all pilot approvals are synthetic.

Keep completed and pending items explicit in `PROGRESS.md`. The user asked for a
handoff near 5% quota, but no reliable remaining-account-quota indicator is exposed
in this session; keep this handoff current rather than inventing a percentage.

## Boundary limitations and recovery

- The harness is the oracle; apply PASS is not behavioral equivalence or PR_READY.
- Same-user filesystem reads, archive tampering and hostile concurrent directory
  mutation are not isolated/authenticated. AGENTS and brief-only discipline are policy.
- Issuance is local to the artifact root. Briefs from the old checkpoint lack issuance
  records and must be reissued by the harness. Do not fabricate registry entries.
- Changing a candidate baseline requires a fresh brief, not just a new beforeHash.
  Changing protected inputs unexpectedly requires review.
- Repair attempt counters are caller-supplied, not a persisted global retry ledger.
- The next command covers the first scenario. Run every required scenario separately.
- Handled write/persistence failures roll back; multi-file writes are not crash-atomic.
  A crash or rollback failure needs human recovery. After confirming no writer remains,
  inspect candidates/audit before removing `.harness-assistant.lock` from both roots.
  Do not automatically bypass locks or reuse stale evidence.

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

Tests import `dist/`; build first. Do not rerun without changes or another reason.
Node 20.20.1; pnpm absent from PATH; Playwright pinned to 1.63.0; Chromium installed.
Docker is unavailable through this WSL integration. Private raw artifacts use native
Linux storage (0700/0600) outside the repository; do not inspect their contents.
The WSL `/mnt/c` filesystem does not enforce the necessary private modes.
No dev server is required for this CLI task; pilots close their fixture servers.
