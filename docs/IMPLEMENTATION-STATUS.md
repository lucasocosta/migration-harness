# RFC implementation status

Updated 2026-09-05. RFC v0.2 and research.md remain the architectural specification. This file distinguishes executable functionality from broader production work.

| RFC area | Delivered | Limits |
| --- | --- | --- |
| MigrationUnit / discovery | TypeScript symbols, tsconfig aliases, dependency closure, Angular templates/selectors/pipes, route ownership, guards/resolvers, constructor DI, explicit root lifetimes, fetch/HTTP endpoints, initial RxJS classification | Dynamic modules/routes, complex provider scopes, composite selectors and application-wide lifetime inference still require review |
| Runtime schemas | Scenarios, events, traces, contracts, units, plans, manifests, results, CLI policy | Valid schema/metadata is not provenance authentication |
| Scenario execution | Fresh contexts, pre-boot mocks/storage, typed actions, pre-armed response signals, explicit completion, origin filtering | No WebSocket/service-worker scenario adapter |
| Trace recording | Request identity correlation, navigation, ARIA JSON/YAML, step storage deltas, async draining, body omission, deadline cleanup | No complete application causal instrumentation; chunked bodies are capped after Playwright reads them |
| Sanitization | Strict event envelope, denylist, application allowlists, PII patterns, keyed pseudonyms, structural-only worker projection | PII patterns cannot recognize arbitrary personal data; application allowlists require review |
| Artifacts | Separate native-filesystem raw domain, verified 0700/0600 permissions, exclusive writes, path/symlink checks, raw retention, hash-chained audit | Encryption, key rotation, backup retention and external audit anchoring remain operational responsibilities; private roots must enforce POSIX modes |
| Critical contracts | Execution-ID mining, nonblocking network/storage/stable-navigation/ARIA synthesis, evidence fusion, OpenAPI/structured-test imports, explicit review/approval, portable SHA-256, critical gates | Importers cover documented subsets; unsupported schemas and unstructured test extraction remain explicit gaps; execution IDs are not provenance signatures |
| Equivalence | Network shapes/status/transport/path params, navigation, state, ARIA, declared causal partial-order alignment | Request values are compared by shape; unspecified causal edges cannot be inferred; graph alignment is bounded and fails closed |
| Transformation | Semantic plan, narrow Angular component codemod, manifest generation, bounded semantic worker API | Complex forms, DI lifetime, streams and general application conversion require further adapters or a configured worker |
| Repair | Classification, method repair, file/hash/dependency constraints, bounded worker, target recapture, protected-oracle checks | CLI automatic repair currently localizes one fetch method; general repairs use the library provider interface |
| Worker execution | Data-only provider, deadline/output/context budgets, locally tested HTTP transport, Docker adapter with restricted mounts/network/resources | Static code scanning is defense in depth only; Docker unavailable in this WSL; live container execution and external model reasoning not validated here |
| Quality gates | Integrity, security, required scenarios, equivalence, TypeScript, trusted-config ESLint, axe, measured coverage, eligibility precedence | Human accessibility evaluation and application-specific lint/security policy remain external review responsibilities |
| Pilot DoD | Real Angular, generated React, three source runs, synthetic review, deliberate regression, one bounded repair, equivalent rerun, unchanged contract and audit | Synthetic approval is test data only; not approval of a production contract |

The full pilot is reproducible with `pnpm pilot`; no external model access is needed. Its deterministic provider exercises the same bounded patch interface available to a model-backed provider. This validates the orchestration and constraints, not the quality of an external model's reasoning.

The broader RFC is **not fully production-complete**. The executable pilot and core workflow are delivered. The limits above must remain visible when applying the harness to a real migration; unsupported semantics should produce review/escalation rather than fabricated certainty.

Live completion tracking is in `PROGRESS.md`; `REVIEW-RESOLUTION.md` records accepted/rejected review findings; `HANDOFF.md` contains continuation instructions.
