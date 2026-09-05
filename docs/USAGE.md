# CLI usage

Install and build:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
```

When pnpm is unavailable, use `npx --yes pnpm@10.15.0` in its place.
Commands below use `node packages/cli/dist/index.js`; installing the CLI package also exposes `harness`.
Output files are created exclusively. Choose a new output path or artifact root for each execution; existing evidence is never overwritten.

## Discovery and planning

```bash
node packages/cli/dist/index.js discover \
  --source-root examples/angular-react-pilot/source --out artifacts/discovery.json
node packages/cli/dist/index.js plan \
  --source-root examples/angular-react-pilot/source --out artifacts/plan.json
```

Use `--entrypoint 'customer-profile.ts#CustomerProfileComponent'` to select a specific symbol. Multiple components require an explicit entrypoint. Discovery follows resolved dependencies, constructor injection, template selectors/pipes and route-owned guards/resolvers; it reads tsconfig aliases. Dynamic and unresolved references remain visible in resolution metrics. Provider lifetime inference is limited to explicit root providers; complex scopes remain unknown.

## Capturing evidence

```bash
node packages/cli/dist/index.js trace \
  --scenario examples/angular-react-pilot/scenario.json \
  --base-url http://localhost:4200 --runs 3 \
  --policy examples/angular-react-pilot/policy.json \
  --artifact-root artifacts/source-run
```

The application must already be running. Each run gets a fresh browser context. Storage and mocks are installed before application boot. Fixture paths resolve relative to the scenario file. Only the application origin is allowed by default; additional origins require an explicit policy. WebSockets and service workers are blocked in this adapter.

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

Retention removes only expired files in that root's private raw domain. Keys and repair backups need a separate operational retention policy.

## Contract review

Synthesis creates nonblocking candidates for network, storage and stable final navigation/ARIA observations. It never creates blocking requirements from repeated runtime observations. Each recorded run has a distinct execution ID; changing runIndex alone does not create a new observation.

Import external evidence when available:

```bash
node packages/cli/dist/index.js import-openapi --input openapi.json --out artifacts/openapi-evidence.json
node packages/cli/dist/index.js import-test-evidence --input test-report.json --out artifacts/test-evidence.json
```

The OpenAPI adapter supports a bounded JSON object-schema subset of versions 3.0/3.1 and local references. Unsupported/external/cyclic references, composed schemas, conditional optional-body requirements and unrepresentable response statuses remain unresolved; no external reference is fetched. Test reports are arrays of `{testId, passed: true, network: HttpEndpointInvariant}` assertions, not free-form test text. Both importers preserve provenance and leave enforcement at WARNING. Pass reviewed reports with `synthesize --evidence report1.json,report2.json`; unresolved reports must be reviewed first. Only operations observed in the scenario are automatically corroborated; reviewers add missing critical obligations explicitly.

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

The codemod supports a single inline standalone component with ordinary TypeScript fields/methods, native elements and supported property/event bindings. It rejects lifecycle hooks, inheritance, decorated members, extra metadata, external dependencies and structural templates. React output must be independently typechecked, built and validated. Manifests record claims; claims do not relax comparisons.

Policy accepts `network.volatileQueryParams`, `network.volatilePayloadFields`, `network.volatileResponseFields`, `network.volatilePathParams` (template -> parameter names), `network.pathTemplates`, shape/status comparison flags, `observables.ariaSeverity`, navigation aliases, ignored storage keys, `observables.volatileStorageValues` (`{storageType,key}` entries), `sanitization` allowlists and `allowedOrigins`. Unknown fields are rejected. Every relaxed comparison is an explicit caller-owned policy choice. Main-frame navigation order remains meaningful; independent network exchanges are compared without strict temporal ordering.

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

Both applications must already be running. Target rebuilding/hot reload belongs to the application server. This command invokes only the conservative single-fetch method repair; the library API accepts a bounded worker for semantic patches. Every retry captures a new target trace. A stale target continues failing and exhausts the budget. Unclassified, nondeterministic, security and architectural failures do not enter automatic repair. The command never executes arbitrary build commands on the host.

`BoundedWorker` accepts an injected provider or `HttpWorkerProvider` for a user-configured service. The service receives `{system, data}` and returns `{patches, manifest}`. TS/TSX patches include a path, SHA-256 of the previous content and replacement content. The model has no file or command capabilities. Provider adapters themselves are trusted host code. Static import/dynamic-code checks are defense in depth, not a sandbox or proof of safety. `DockerSandbox` is the separate generated-command execution boundary: it requires a locally installed digest-pinned image and mounts only the candidate directory read-only, with networking disabled, resource limits and a deadline. There is no unsandboxed execution fallback.

Quality adapters expose `checkTypeScript`, `lintCandidate` (fixed trusted ESLint rules, no repository config loading), `checkAccessibility` (axe, explicit browser context required) and `measureCoverage`. Axe results always retain a manual-review requirement; passing automated checks is not a complete accessibility certification.

Exit codes: `0` success/equivalent, `1` invalid input or execution failure, `2` invalid contract digest, `4` behavioral divergence. EQUIVALENT is a comparison result, not automatic release authorization; use quality gates and reviewed coverage to determine eligibility.
