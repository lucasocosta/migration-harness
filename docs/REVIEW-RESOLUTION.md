# Review resolution

Source: `REVIEW.md`, supplied during implementation on 2026-09-05. The original review is preserved unchanged. `PROGRESS.md` tracks verification and remaining work.

## Must-fix findings

| Finding | Decision and implementation |
| --- | --- |
| MF-1 FSM approval bypass | Fixed. Only CONTRACT_REVIEW can approve. The regression test attempts the actual synthesis-to-approved shortcut. |
| MF-2 bypassable AST denylist | Accepted the review's boundary-documentation alternative. Added checks/tests for common aliases, indirect eval, constructors and string timers, but this remains defense in depth. Static scanning does not establish runtime safety. Worker providers return untrusted data; they do not execute patches. Generated commands must run through DockerSandbox, never on the host. The deterministic pilot provider is trusted test code, not untrusted generated execution. Live Docker verification is still blocked by the environment. |
| MF-3 locale-dependent contract hashes | Fixed. Contract and audit hashes share core codepoint canonicalization; tests replace localeCompare with a throwing function. Previously generated synthetic hashes may differ. Real approved contracts must not be silently rehashed. |
| MF-4 fixture filesystem escape | Fixed. Resolve real base/fixture paths and enforce containment before reading. Symlink escapes and private-domain paths are rejected. |

## Should-fix findings

| Finding | Decision and implementation |
| --- | --- |
| SF-1 default-open payload keys | Fixed. Payload and storage fields both default to deny. Unstructured strings are pseudonymized. Pilot policies explicitly allow required fields. |
| SF-2 malformed URLs | Fixed for malformed encoded URLs accepted by the trace schema: an opaque URL pseudonym replaces an undecodable URL. Invalid trace envelopes still fail runtime schema validation deliberately. |
| SF-3 ARIA URL secrets | Fixed in JSON and YAML. Nested ARIA URLs use URL sanitization, and YAML is regenerated from sanitized JSON. |
| SF-4 navigation multiset | Not adopted. A single main frame's route transitions and redirects are ordered observable behavior. `/login -> /account -> /done` and `/account -> /login -> /done` must not pass merely because their URL multisets/final destinations agree. RFC section 16's independent-request example is handled by the network multiset and declared causal-DAG comparator. Explicit navigation aliases remain available; this is not a reason to discard meaningful order. A regression test locks this down. |
| SF-5 volatile values | Added per-template volatile path parameters, volatile response fields and per-storage-type/key volatile values, alongside existing query/request-field policies. All require explicit declarations. |
| SF-6 fabricated path params | Fixed. Incompatible regex/template rules throw instead of inventing a literal parameter. |
| SF-7 replayed runs | Added recorder-generated runId and duplicate execution identity rejection, with startedAt fallback for older traces. This catches index-only replay; it is not cryptographic proof of independent execution. |
| SF-8 network-only synthesis | Implemented observational storage candidates and stable final navigation/ARIA candidates. They remain WARNING/INFORMATIONAL. External evidence corroborates only matching operations in the scenario. |
| SF-9 ignored needsReview argument | Removed the argument. Synthesis always enters review. |
| SF-10 success disposition | Successful repair/gate results use null, not UNKNOWN. |
| SF-11 false nondeterminism | Scenario failure is UNKNOWN/blocking. The repair coordinator now returns a structured SCENARIO_FAILED result when target execution throws. Nondeterminism is reserved for explicit evidence. |
| SF-12 artifact TOCTOU | Added O_NOFOLLOW and post-open realpath/device/inode checks before writing. Private roots require verified 0700 permissions. Same-UID hostile filesystem mutation is not a fully solved capability-isolation model in Node; do not treat path checks as protection against a privileged local attacker. |
| SF-13 mock origin bypass | Fixed. Every mock handler enforces the origin allowlist before fulfillment. Browser tests cover this independently of context routing. |
| SF-14 patch extensions | Bounded worker patches are restricted to TS/TSX. |
| SF-15 repair containment | CLI repair now requires `--candidate-root` and validates the target relative to that explicit root. |

## Additional review work

- One ARIA JSON capture supplies both representations; YAML is structured YAML of that JSON, not Playwright's old shorthand format.
- Missing terminal responses produce HTTP_FAILED; result divergence IDs are unique; ARIA checkpoints resolve actual interaction IDs rather than an `evt_` naming convention.
- Browser locale/viewport are configurable; the recorder reports the actual navigator locale.
- Public artifact writes reject structured raw traces, including nested traces.
- Unicode NFC normalization, prototype-like keys, malformed percent encodings, indirect evaluation, retention symlinks and hash portability have regression coverage.
- The actual Playwright dependency is pinned to 1.63.0, not merely held by the lockfile.
- Multiple discovered components now require explicit entrypoints. Route ownership, guards/resolvers, constructor injection, aliases, selectors and pipes have implementation and tests.
- Removed unused placeholder adapters instead of presenting empty interfaces as implemented features. The scrubber re-export remains an intentional compatibility facade for existing imports.
- Zero-step scenarios remain valid: boot-only behavior is a useful scenario, and is exercised by the browser mock-boundary test.
- Legacy Python/example fixtures remain clearly labeled historical. They are not used by current test commands.
- Added bounded OpenAPI and structured existing-test evidence importers, local HTTP-provider protocol tests, axe integration and a fixed trusted ESLint configuration. None of these execute an application's configuration scripts on the host.

No automatic commit or external publication is part of these corrections. The user's supplied review and all implementation changes remain available in the shared worktree.
