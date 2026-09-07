# CLI usage

Reference for **implemented commands**, not the future RFC v0.3 workflow.
See [PLAN.md](PLAN.md) for the consolidated standard operation still to be built.
No profile flag or aggregate verification command is available yet. Versioned
config/report schemas and aggregation are available as library APIs only.

| Need | Available operation | Limit |
| --- | --- | --- |
| Preflight and native build/typecheck/lint/test | `check-projects` | Project-check report only, not behavioral equivalence |
| Capture a running application | `trace` | One scenario; caller serves the app |
| Compare sanitized evidence | `compare` | Contract/manifest optional; payloads compared by shape |
| Execute both sides | `run` | Approved contract, one scenario, no build orchestration |
| Restricted submission | `brief`, `apply-patch` | Issuance and TS/TSX boundary; not normal editing |
| Optional assistance | `discover`, `plan`, `transform`, importers | Not universal prerequisites |

Do not simulate the proposed standard profile by disabling restricted checks.
Suite coverage and served-build freshness still need coordination beyond native
checks. Raw-input examples below are operator-only;
they do not authorize an assistant to read private traces or keys.

Install and build:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
```

When pnpm is unavailable, use `npx --yes pnpm@10.15.0` in its place.
Commands below use `node packages/cli/dist/index.js`; installing the CLI package also exposes `harness`.
Evidence outputs are created exclusively. Choose a new output path for each verification. The assistant commands may replace their current `--out` brief/apply result; their archived records remain exclusive.

## Native project checks (P3 partial)

Use a version-1 MigrationConfig (examples in tests/project-checks.test.mjs). The
agent can prepare it from the approved scope; the owner need not type JSON or
approve each individual invocation. The execution flag selects previously authorized
local project-command execution, not a sandbox or a new approval ceremony.

```bash
node packages/cli/dist/index.js check-projects --help
node packages/cli/dist/index.js check-projects \
  --config migrations/example/migration.json --workspace-root . \
  --artifact-root artifacts/example/checks --out preflight.json --preflight-only
node packages/cli/dist/index.js check-projects \
  --config migrations/example/migration.json --workspace-root . \
  --artifact-root artifacts/example/checks --out baseline.json \
  --allow-project-commands --phase baseline
node packages/cli/dist/index.js check-projects \
  --config migrations/example/migration.json --workspace-root . \
  --artifact-root artifacts/example/checks --out candidate-1.json \
  --allow-project-commands --phase candidate --baseline artifacts/example/checks/baseline.json
```

Paths are templates. Output is relative to artifact-root, exclusive and outside
project/fixture inputs. Existing/unsafe output is refused before commands. Preflight
reads declared public inputs and checks cwd, not ports/server readiness. Without
execution authorization checks are NOT_RUN/INCONCLUSIVE. Phase defaults to baseline;
a supplied baseline must match configuration/workspace and have consistent inputs.

Only commands referenced by config.checks run; serve/reset are not checks. Arguments
are literal (shell:false). Commands/npm scripts are trusted project code in an
authorized environment, not isolated code. Inherited environment is restricted to
PATH/HOME/locale/temp variables, with CI=1 and NO_COLOR=1; no arbitrary credentials
or NODE_OPTIONS. Configurable public env is not yet supported.

Per-command timeouts and maxDurationMs apply. Output over 1 MiB stops the command.
Ordinary children in its owned POSIX group are terminated after exit/timeout/abort.
Linux/WSL is supported; native Windows is not. Deliberately escaped processes and
hostile same-user mutation are not sandboxed.

PROJECT_CHECK_REPORT records native exit codes, safe reasons, byte counts (not raw
stdout/stderr), declared input hashes and baseline comparisons. BASELINE_CHECK_FAILED
says the same check failed before, not that the root cause is identical; it still
fails. Input changes, timeouts and launch failure are INCONCLUSIVE. Compiler-message
parsing and scenario-suite integration remain pending. Managed served-build identity
is a separate library operation described below.

Exit codes: 0 project checks passed; 4 required native check failed; 5 inconclusive;
1 invalid config/output/I/O. Project PASS is NOT migration success. APIs:
preflightProjectChecks and runProjectChecks from engine/project-checks.js.

## Managed static builds (P3 library)

`withProjectBuildServers` from engine/build-servers.js builds and serves both SPAs
for the lifetime of an async callback. It is not a new CLI command or a migration
verdict. Add this optional object to each project in MigrationConfig:

```json
"build": { "commandId": "build", "outputDir": "dist", "cleanOutput": true }
```

The referenced command must be kind build and appear as a required check on that
side. `outputDir` is project-relative and **exclusively generated/disposable**:
`cleanOutput: true` authorizes removing it before building, without backup/rollback
of old generated output. Never point it at source code or user work. Declared
inputs/scope/fixtures/contract and src/public/node_modules output roots are protected.
Use the actual directory containing index.html, e.g. dist/cinema-web/browser for
an Angular static browser build. Both baseUrls need distinct explicit non-default HTTP
ports on 127.0.0.1, localhost or [::1], with no path prefix/query/fragment.

```js
import { withProjectBuildServers } from '@migration-harness/engine';

const result = await withProjectBuildServers({
  config, workspaceRoot, allowProjectCommands: true,
}, async ({ source, target, signal }) => {
  // Run authorized browser work using these origins and honor cancellation.
  return await captureBoth({ source, target, signal });
});
// result.value: callback result; result.builds: identities; result.checks: native report.
```

`captureBoth` is caller code, not an implemented harness API. Executable synthetic
examples: tests/build-servers.test.mjs and tests/browser/build-servers.test.mjs.
Use fresh browser contexts, the declared service-worker policy and close browser
resources in finally. The helper owns servers, not arbitrary callback resources;
callbacks must honor the provided AbortSignal. No reset/scenario suite is implicit.

Both ports are reserved before cleaning or executing commands; an occupied port is
refused without touching its listener. Native checks finish before apps are served;
tests needing these origins belong in the callback/scenario stage. Required native
checks must pass. Each build
needs nonempty index.html; symlinks, hard-linked files, credential paths and .pem/.key
artifacts are refused. Limits per side: 8 MiB/file, 64 MiB total, 5000 files and
10000 entries. Supported static MIME types are served from immutable memory with
no-store and x-migration-build; source maps/unknown types are fingerprinted but not
served. Extensionless HTML navigation gets SPA fallback, missing JS does not.

`/__migration_harness_health__` exposes a public SERVED_BUILD descriptor (run UUID,
origin, configuration/input/build hashes, byte/file counts). Health and disk/input
hashes are checked again after the callback. Changed output/inputs refuse the result;
owned servers close on success, error, cancellation and timeout. Errors expose a
ProjectBuildError code and, when attributable, side. Hashes are consistency evidence
over declared inputs, not authenticated provenance or a sandbox. Build declarations
affect the versioned reference environment hash. SSR, custom server commands, proxies,
HTTPS and automatic port reassignment are not supported by this static adapter.
Outputs must contain public test assets only: filename checks do not detect secrets
embedded in compiled JavaScript or other otherwise valid assets.

## Optional discovery and planning

```bash
node packages/cli/dist/index.js discover \
  --source-root examples/angular-react-pilot/source --out artifacts/discovery.json
node packages/cli/dist/index.js plan \
  --source-root examples/angular-react-pilot/source --out artifacts/plan.json
```

Use `--entrypoint 'customer-profile.ts#CustomerProfileComponent'` to select a specific symbol. Multiple components require an explicit entrypoint. Discovery follows resolved dependencies, constructor injection, template selectors/pipes and route-owned guards/resolvers; it reads tsconfig aliases. Dynamic and unresolved references remain visible in resolution metrics. Explicit `providedIn` and component `providers` lifetimes are recorded; complex scopes still require review.

## Capturing evidence

```bash
node packages/cli/dist/index.js trace \
  --scenario examples/angular-react-pilot/scenario.json \
  --base-url http://localhost:4200 --runs 3 \
  --policy examples/angular-react-pilot/policy.json \
  --artifact-root artifacts/source-run
```

The application must already be running. Each run gets a fresh browser context. Storage and mocks are installed before application boot. Fixture paths resolve from the scenario file's own directory and must stay inside it: paths that escape, including through symlinks, are refused. Only the application origin is allowed by default; additional origins require an explicit policy. WebSockets and service workers are blocked by default; their bounded adapters require explicit opt-in.

Capture evidence against a served production build rather than a framework dev server: dev servers keep an HMR WebSocket open, and WebSockets are blocked by default.

The public artifact root contains sanitized evidence. Private artifacts use a separate native filesystem directory keyed by the absolute artifact-root path:

```text
~/.local/state/migration-harness/<artifact-root-hash>/
  pseudonymization.key
  raw/<unit>/<scenario>/<run>.json
<artifact-root>/artifacts/units/<unit>/<scenario>/source/<run>.sanitized.json
```

Raw directories require mode 0700 and raw files 0600; the store verifies permissions before writing data. The library accepts an explicit private root on a filesystem that enforces these permissions. In WSL, keep it on the native Linux filesystem; `/mnt/c` without POSIX metadata is rejected for private artifacts. Sanitized artifacts are local validation evidence, not prompts: only `projectTraceForLlm` output may cross the worker boundary. That projection excludes all runtime free text, URLs, headers, keys and values.

Reuse the same artifact root/key for source and target pseudonyms. `--key-file` permits a separately managed shared key. Losing or changing the key makes pseudonym comparisons invalid. `--policy` explicitly selects observable storage and payload fields; both field sets default to deny. Sensitive keys remain denied even if allowlisted. Regex PII scrubbing is not a universal personal-data detector; field allowlists must be reviewed for the application. ARIA YAML is regenerated from sanitized JSON, avoiding a second raw URL/text channel.

```bash
node packages/cli/dist/index.js sanitize-trace \
  --input raw.json --out sanitized.json --key-file private.key
node packages/cli/dist/index.js purge-raw \
  --artifact-root artifacts/source-run --retention-hours 24
```

Retention removes only expired files in that root's private raw domain. Keys and repair backups need a separate operational retention policy. In assistant-driven work, minimize raw retention: once evidence review is complete and raw data is no longer needed, a human can run `purge-raw --retention-hours 0`. Do not read raw files into the assistant context. Same-user filesystem reads outside the CLI cannot be blocked or detected by the harness.

## Optional operational artifact lifecycle

All of the following default to off; without these flags behavior is byte-identical to plaintext storage.

```bash
node packages/cli/dist/index.js trace --encrypt --keys-root ~/.local/state/harness-keys \
  --scenario scenario.json --base-url http://localhost:4200 --artifact-root artifacts/source-run

node packages/cli/dist/index.js purge-raw --artifact-root artifacts/source-run \
  --retention-hours 0 --backup-root ~/.local/state/harness-backup --backup-generations 5

node packages/cli/dist/index.js rotate-raw-key --store-root artifacts/source-run \
  --audit artifacts/source-run/audit.json --artifact-root artifacts/source-run

node packages/cli/dist/index.js anchor-audit --audit artifacts/source-run/audit.json \
  --path ~/.local/state/harness-anchor/chain-head.json --artifact-root artifacts/source-run
```

`--encrypt` seals private raw writes with AES-256-GCM using a versioned keyring under `--keys-root` (0700/0600 enforced, regular files only, no symlinks); legacy plaintext raw files stay readable. A truncated or damaged envelope reports an authentication failure instead of being read as plaintext.

`--backup-root` archives expired raw files during `purge-raw`, layout-preserving and resealed, capped by `--backup-generations` (default 5). The backup root must be outside the public artifact root and must not equal it.

`rotate-raw-key` re-seals in a fail-closed sweep and records `RAW_KEY_ROTATION` on the hash-chained audit only after the sweep succeeds. It retains older key versions by default; `--prune-key-versions <n>` is opt-in and refuses pruning that would orphan retained backups. Never delete key versions manually without a recovery plan.

`anchor-audit` appends an external append-only copy of the chain head and records `AUDIT_ANCHORED` in the chain. The anchor path must differ from the audit path and must not be inside a private domain. This detects tampering; it is not trusted timestamping.

All four serialize through exclusive locks. After a crash, inspect state before removing stale lock files.

## Optional critical contracts (required by current run/brief)

Synthesis creates nonblocking candidates for network, storage and stable final navigation/ARIA observations. It never creates blocking requirements from repeated runtime observations. Each recorded run has a distinct execution ID; changing runIndex alone does not create a new observation.

Import external evidence when available:

```bash
node packages/cli/dist/index.js import-openapi --input openapi.json --out artifacts/openapi-evidence.json
node packages/cli/dist/index.js import-openapi --input openapi.json --ref-map artifacts/ref-map.json \
  --out artifacts/openapi-evidence.json
node packages/cli/dist/index.js import-test-evidence --input test-report.json --out artifacts/test-evidence.json
```

The OpenAPI adapter supports a bounded JSON object-schema subset of versions 3.0/3.1 and local references. It extracts top-level required/optional fields from nested `allOf` object compositions, including local references. Required fields are combined conjunctively; common response obligations are still intersected across statuses. This follows [JSON Schema's allOf semantics](https://json-schema.org/understanding-json-schema/reference/combining), not object-oriented inheritance or a complete JSON Schema validator.

Alternatives converge conservatively: `oneOf` extracts a field only when every branch agrees, and field-level disagreements become findings; `anyOf` marks a field required only where every branch requires it. Conditionals (`not`, `if`/`then`/`else`, `dependent*`) stay review findings.

`--ref-map` is the only way external references resolve: a JSON object mapping each external document URI to a local file path, checked for containment and realpath and bounded by document/size budgets. No reference is ever fetched over the network. Without a map, external references remain unresolved findings.

Compositions require an explicit object type somewhere in the conjunction. Closed/constrained objects, differing definitions for overlapping properties, directional readOnly/writeOnly properties, nullable objects and semantic `$ref` siblings remain unresolved. Traversal is capped at depth 64, 64 branches per `allOf` and 512 schema visits per payload. Cyclic references, conditional optional-body requirements and unrepresentable response statuses also require review.

Test reports are arrays of `{testId, passed: true, network: HttpEndpointInvariant}` assertions, not free-form test text. Both importers preserve provenance and leave enforcement at WARNING. Pass reviewed reports with `synthesize --evidence report1.json,report2.json`; unresolved reports must be reviewed first. Only operations observed in the scenario are automatically corroborated; reviewers add missing critical obligations explicitly.

```bash
node packages/cli/dist/index.js synthesize \
  --unit-id CustomerProfileComponent \
  --input run1.sanitized.json,run2.sanitized.json,run3.sanitized.json \
  --out artifacts/contract.draft.json
node packages/cli/dist/index.js review-contract \
  --input artifacts/contract.draft.json --out artifacts/contract.review.json
node packages/cli/dist/index.js approve-contract \
  --input artifacts/contract.review.json --out artifacts/contract.approved.json \
  --approved-by actual-reviewer
node packages/cli/dist/index.js verify-contract \
  --contract artifacts/contract.approved.json
```

Reviewers add or promote critical invariants in a draft/review document. Runtime candidates do not create blocking requirements. Only REVIEW documents can be approved. Changes to approved content require a new draft/version and human review. The digest protects unit, contract identity, version and all nested scenario invariants; it is not a digital signature or authentication system.

## Transform and compare

```bash
node packages/cli/dist/index.js transform \
  --input examples/angular-react-pilot/source/customer-profile.ts \
  --unit-id CustomerProfileComponent --out artifacts/candidate.tsx \
  --manifest artifacts/transformation.manifest.json
node packages/cli/dist/index.js compare \
  --source source.sanitized.json --target target.sanitized.json \
  --contract artifacts/contract.approved.json \
  --policy examples/angular-react-pilot/policy.json --out artifacts/result.json
```

The codemod supports a single inline standalone component with ordinary TypeScript fields/methods, decorated inputs/outputs, supported property/event bindings and a conservative synchronous reactive-forms subset, including statically-normalizable builder groups. Async validators, dynamic controls, FormArray, mixed ngModel and side-effectful subscriptions require semantic/manual work. Unsupported lifecycle hooks, inheritance, metadata and structural templates are refused. React output must be independently typechecked, built and validated. Manifests record claims; claims do not relax comparisons.

Policy accepts `network.volatileQueryParams`, `network.volatilePayloadFields`, `network.volatileResponseFields`, `network.volatilePathParams` (template -> parameter names), `network.pathTemplates`, shape/status comparison flags, `network.comparePayloadValues`, `network.compareResponseValues`, `network.requiredValueFields`, `observables.ariaSeverity`, navigation aliases, ignored storage keys, `observables.volatileStorageValues` (`{storageType,key}` entries), `sanitization` allowlists and `allowedOrigins`. Unknown fields are rejected. Every relaxed comparison is an explicit caller-owned policy choice. Main-frame navigation order remains meaningful; independent network exchanges are compared without strict temporal ordering.

Value comparison is opt-in here: `parseValidationPolicy` keeps shape-only comparison so existing v0.2 results do not change meaning, while `migrationComparisonPolicy` (standard profile) enables payload and response value comparison, and a standard `MIGRATION_CONFIG` may not disable comparison criteria. With values enabled, a difference reports its structural path and the kinds involved (`payload.email`: `string` versus `absent`) and never the observed value; arrays are compared positionally; declared volatile field names are pruned at any depth, so a tolerated nested difference neither diverges nor shifts exchange identity. `requiredValueFields` entries (`{method?, path?, field}` with `field` rooted at `payload` or `response`) declare data that must be observable: when neither side exposes it — because the operation never happened or sanitization redacted it — the result carries `VALUE_EVIDENCE_OMITTED` and aggregates as INCONCLUSIVE rather than passing. Navigation, storage and ARIA diagnostics report safe paths with query keys, storage keys with a `VALUE`/`SEQUENCE`/`MISSING` classification, and ARIA roles per checkpoint.

## Compare and repair running applications

```bash
node packages/cli/dist/index.js run \
  --scenario examples/angular-react-pilot/scenario.json \
  --source-url http://localhost:4200 --target-url http://localhost:3000 \
  --contract artifacts/contract.approved.json \
  --policy examples/angular-react-pilot/policy.json \
  --artifact-root artifacts/verification-run \
  --max-repairs 1 --candidate-root candidate --target-file candidate/customer-profile.tsx \
  --out artifacts/run-result.json
```

Both applications must already be running. This command invokes only the conservative single-fetch method repair; the library API accepts a bounded worker for semantic patches. Every retry captures a new target trace, but it does not rebuild or prove that the server serves the edited bytes. A stale server can invalidate the conclusion, even if the result is EQUIVALENT. Prefer explicit rebuild plus `run --max-repairs 0` for the restricted assistant loop. Unclassified, nondeterministic, security and architectural failures do not enter automatic repair. The command never executes arbitrary build commands on the host.

The implemented restricted semantic workflow is the assistant loop below, with no model API credentials. `BoundedWorker` and `HttpWorkerProvider` remain optional library adapters for an injected provider or JSON service (`{system,data}` -> `{patches,manifest}`); only that adapter's model has no inherited file/command capabilities. Provider adapters are trusted host code. Static checks are defense in depth, not a sandbox. `DockerSandbox` is the separate generated-command execution boundary: it requires a locally installed digest-pinned image and mounts only the candidate directory read-only, with networking disabled, resource limits and a deadline. There is no unsandboxed execution fallback.

Quality adapters expose `checkTypeScript`, `lintCandidate` (fixed trusted ESLint rules, no repository config loading), `checkAccessibility` (axe, explicit browser context required) and `measureCoverage`. Axe results always retain a manual-review requirement; passing automated checks is not a complete accessibility certification.

## Restricted assistant transform and repair

Read root `AGENTS.md` and `ASSISTANT-INTEGRATION.md`. A human prepares reviewed inputs and adds an `assistant` block to the policy:

```json
{
  "assistant": {
    "allowedPackages": ["react"],
    "targetConventions": { "framework": "react", "language": "typescript" },
    "maxBriefBytes": 262144,
    "maxSubmissionBytes": 2000000,
    "typecheck": true,
    "lint": true
  }
}
```

The static gates default to false and operate on the candidate overlay before writes. Type resolution requires dependencies accessible from the candidate root. `PASS` only means the configured apply gates passed, never behavioral equivalence.

```bash
node packages/cli/dist/index.js brief \
  --unit-id CustomerProfileComponent --unit artifacts/discovery.json \
  --plan artifacts/plan.json --contract artifacts/contract.approved.json \
  --scenario examples/angular-react-pilot/scenario.json \
  --source-trace artifacts/source.sanitized.json --policy artifacts/policy.json \
  --source-root examples/angular-react-pilot/source \
  --candidate-root candidate --candidate-files src/customer-profile.tsx \
  --context-files candidate/package.json,candidate/src/components/Button.tsx \
  --artifact-root artifacts/assistant-loop --out brief.json

node packages/cli/dist/index.js apply-patch \
  --brief artifacts/assistant-loop/brief.json --input artifacts/submission.json \
  --candidate-root candidate --artifact-root artifacts/assistant-loop \
  --source-url http://localhost:4200 --target-url http://localhost:3000 \
  --next-out artifacts/assistant-loop/verify-1.json --out apply.json
```

`--source-root` resolves discovered symbol paths into absolute `contextFiles`. `--context-files` adds explicitly listed read-only files inside the source or candidate roots — existing destination components, HTTP client, styles, `package.json`, conventions — restricted to `.ts/.tsx/.json/.html/.css/.scss/.md` regular files. They are hash-protected as brief-time inputs: a candidate patch targeting one is refused, and mutating one invalidates the brief with `BASELINE_HASH_MISMATCH`. Destination context files may back relative imports without becoming writable. The same file must not appear in both `--context-files` and `--candidate-files`.

`allowedFiles` is relative to `--candidate-root`; its hashes and existence are fixed at issuance. The brief embeds a command with both roots. The assistant creates a public submission JSON `{briefId, patches:[{path,beforeHash,content}], manifest}` without directly editing candidate files. If a baseline changes, obtain a fresh harness-issued brief; changing only `beforeHash` is insufficient.

`apply-patch` checks the issued record, protected-input fingerprints, file/package boundaries, AST constructs, full repair byte budget and content screens (including manifest). Submission limits and static-gate settings come from issuance, not a replacement apply-time policy. A successful result archives the validated manifest and includes `next.command` for `run --max-repairs 0`, using the original contract/scenario/policy. With multiple scenarios, that command covers the first; execute every required scenario before claiming eligibility.

Run the returned command with the CLI executable prefix. The target server must rebuild the applied bytes. Consume its public `--out` result and disposition. For `AUTO_REPAIRABLE`, repeat the issuance command with `--repair --equivalence <verify-result.json> --attempt 1 --max-repairs 3`; preserve all scope flags. The localized repair currently requires a blocking HTTP-method mismatch in the same scenario. Other dispositions require human review. The attempt counter is caller-supplied, not a persisted global retry budget.

Briefs are rejected if any section contains pseudonym tokens or private-domain references. Never remove data from an approved contract to bypass this: a human must prepare/review a new version. The synthetic protocol pilot chooses its invariant subset before fixture approval.

Archives are under `assistant/{issued,briefs,submissions,manifests,results,refusals}` with `assistant/audit.json`. Treat issuance records as harness-only inputs under policy; they are local consistency records, not authenticated provenance. Output paths cannot overwrite protected inputs or non-assistant artifacts. Cooperative writers are serialized using `.harness-assistant.lock` in both roots. After a crash, a human must inspect candidates/audit and confirm no writer remains before removing stale locks and issuing new briefs. Handled failures roll back candidate/artifact writes; crashes and hostile same-user concurrent filesystem mutations are not transactionally isolated.

Run `pnpm pilot:assistant` for the deterministic restricted-protocol demonstration. A recorded brief-only session is an optional proof of that profile, not a universal migration requirement under RFC v0.3.

For existing React migrations, `COPILOT-MIGRATION.md` distinguishes proposed and available flows; `templates/MIGRATION-SPEC.md` records scope/profile. The two `.github/agents/` definitions and `scripts/copilot-boundary-hook.mjs` apply only to the restricted profile, not the proposed standard loop.

Exit codes: `0` success/equivalent, `1` invalid input or I/O failure, `2` invalid contract digest, `3` structured apply refusal (candidate files unchanged), `4` behavioral divergence. Unsafe output locations or persistence failures may return `1` without a new result artifact. EQUIVALENT is not release authorization; use quality gates and reviewed coverage to determine eligibility.

## P1 library APIs (not an executable migration flow)

- Core: `MigrationConfigSchema`, `parseMigrationConfig`, `migrationConfigHash`,
  `MigrationReferenceSchema`, `parseMigrationReference`, `migrationReferenceHash`,
  `classifyReferenceChange`, `ReferenceVerificationSchema`,
  `UnitAssertionSchema`, `parseUnitAssertion`, `unitAssertionsForScenario`,
  `resolveScenarioForSide`, `scenarioSemanticProjection`, `scenarioBindingProjection`,
  `MigrationReportSchema`, `parseMigrationReport`.
- Engine: `collectMigrationReference(input)`, `verifyMigrationReference(input)` and
  `ReferenceWeakeningError`; lightweight module is
  `@migration-harness/engine/dist/migration-reference.js`.
- Equivalence validator: `migrationComparisonPolicy(policy)` for the standard value
  comparison, `evaluateUnitAssertions({source,target,assertions,unitScopes,mocks})`,
  `discloseMockedCoverage(trace, mocks)`, `verifySourceStability({runs,requiredRuns,reset,policy})`,
  plus `diffValues`, `valuePathPresent`, `resolveValuePath`, `executionHash` and `safeUrl`.
- Quality gates: `buildMigrationReport(configuration, evidence)`,
  `assertionRequirementStatuses(outcomes)` and
  `adaptLegacyComparison(result, identity)`; lightweight module is
  `@migration-harness/quality-gates/dist/migration-report.js`.
- Executable configuration/evidence examples: `tests/migration-report.test.mjs`,
  `tests/migration-reference.test.mjs`, `tests/equivalence-values.test.mjs`,
  `tests/unit-assertions.test.mjs`, `tests/scenario-bindings.test.mjs` and
  `tests/persistence-stability.test.mjs`.

Version 1 configuration embeds existing ScenarioDefinitions, explicit side bindings,
workspace-relative roots, project-relative file scope/cwd, argv commands, requirements,
accepted-difference records, reset, environment, policy and limits. It does not read
files, run commands or approve criteria. Path checks there are lexical, not a sandbox.

`collectMigrationReference` fingerprints the actual working-tree bytes of the declared
source/target files, the protected destination subtrees, every scenario fixture and an
optional approved critical contract, resolving a `.git` revision when available and
recording `UNVERSIONED` otherwise. It refuses symlinked, escaping, missing, oversized
and private-domain paths, a declared mock fixture that does not exist, a contract whose
bytes differ from the configured digest, and a contract that is not APPROVED or fails
its own integrity check. Only hashes are recorded; file contents never enter the artifact.

`verifyMigrationReference` re-checks those inputs against the workspace. Changed or
missing source inputs, changed or added fixtures and changed protected files make the
reference STALE; a configuration change, a hand-edited reference, an unreadable input,
a tampered contract or missing/unstable source observations make it UNVERIFIABLE.
Changes to declared target files are expected during a migration and stay
INFORMATIONAL, as does newly added unrelated work under a protected path.

A new version passes `previous`; additions, binding adaptations and input updates are
classified automatically, while any weakening (removed or demoted scenario/requirement/
check, new accepted difference, broader ignore rules, changed step semantics, changed
fixtures, smaller stability budget, changed protected work) raises
`ReferenceWeakeningError` unless an explicit `ownerDecisionReference` is supplied, which
is then recorded together with the superseded version and its hash.

The collector supplies reference/config/candidate/build hashes and whether it verified
the reference. Aggregation rejects mismatched/duplicate/unknown or missing required
evidence and separates preservation, requirements and project checks. `referenceStatus`
distinguishes a DECLARED flag from a VERIFIED/STALE/UNVERIFIABLE reference verification,
and a configured critical contract only passes with a verified reference whose observed
digest matches the configuration. Those hashes are not authenticated provenance, and
`sourceObservations` remains caller-supplied: without repeated source executions, which
P3 implements, verification stays UNVERIFIABLE.

The legacy adapter discards arbitrary runtime messages/values and cannot promote
shape-only EQUIVALENT to standard PASS. It never treats an APPLY_RESULT as equivalence.

A configuration requirement may declare a unit assertion: `{checkpoint, scope?, claim}`
where the checkpoint is `AFTER_STEP` (a scenario step id) or `SCENARIO_END`, the scope is
the migrated unit's `role`/`name` inside the accessibility snapshot, and the claim is one
of `NODE_PRESENT` (with optional state flags and text), `NODE_ABSENT`, `NO_REQUEST`,
`REQUEST_OBSERVED` (with required payload fields), `STORAGE_MUTATION` or `NAVIGATED`.
`evaluateUnitAssertions` checks each assertion on both sides and returns outcomes plus
divergences: a required violation in the destination is BLOCKING regardless of
`observables.ariaSeverity`, a missing checkpoint, empty capture or unresolved scope is
NOT_EVALUABLE and aggregates as INCONCLUSIVE, and a requirement the source does not meet
is disclosed as INFORMATIONAL instead of failing the destination. Declared literals are
owner configuration — declare labels and messages, not user data — and diagnostics carry
the requirement id, a reason code and the declared role only. Component output callbacks
are asserted through their observable effects; direct output capture needs a component
host. Requirements without an assertion still need caller-supplied evidence.

Each scenario binding declares one application's `entryUrl`, control locator overrides
and optional `unitScope`. `resolveScenarioForSide(config, scenarioId, side)` returns that
side's executable ScenarioDefinition plus its unit scope, refusing any change to the
shared semantic projection (actions, values, order, preconditions, completion). Pass the
resolved scopes as `unitScopes` when evaluating assertions: an adapted scope that does
not resolve is NOT_EVALUABLE and a control missing inside the scope still fails, so an
adaptation cannot hide it. Changing a binding changes the configuration hash and is
classified as `BINDING_ADAPTATION`, which requires a new reference version and a rerun of
both sides.

A `READ_BACK` claim (`{writeMethod, writePathPattern, readMethod?, readPathPattern,
fields:[{payloadField, responseField}]}`) separates a correct request from actual
persistence: the written values must return from a later read. Pass the scenario's declared
`mocks` so a read answered by a fixture is reported as `READ_BACK_MOCKED` instead of proof,
and so `discloseMockedCoverage` records how much of the execution came from fixtures — that
disclosure reaches the report as `MOCKED_COVERAGE` and may accompany a PASS.
`verifySourceStability({runs, requiredRuns, reset, policy})` compares repeated source
executions with the migration's own policy under the declared reset and returns the
`sourceObservations` a reference records (`STABLE`, `UNSTABLE` or `NOT_COLLECTED`) plus the
codes and structural locations that moved. It never declares a field volatile: making an
unstable source stable requires an explicit policy decision, which the reference then
classifies as a criteria change.
