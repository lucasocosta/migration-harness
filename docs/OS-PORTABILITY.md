# OS Portability

Native support target: **Windows, Linux, and macOS**. Linux/WSL remains supported
and is the only environment with recorded migration evidence so far. This document
is the diagnosis and the security policy for private-artifact protection across
operating systems. Behavior on a strict Linux filesystem does not change.

**Implementation status (2026-09-12):** Phases 0–5 of the portability plan are
implemented in this tree (shared `platform-paths`/`process-tree` modules, degraded
privacy policy with disclosures, portable scripts, multi-OS CI including Playwright
browser e2e on ubuntu/windows/macos). End-to-end migration acceptance evidence is
still Linux-only; Windows runs use DEGRADED privacy unless NTFS ACLs land later.

Status legend: **supported** (equivalent guarantees), **degraded** (runs with an
explicit disclosure), **unsupported** (feature refused or unavailable).

## Support matrix

| Feature | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Private artifact store (raw traces, keys) | supported (0700/0600) | supported (0700/0600) | degraded (opt-in insecure mode) |
| Project-command lifecycle / tree kill | supported (POSIX groups) | supported (POSIX groups) | supported (`taskkill /T`, see Phase 2) |
| Path containment / scope fingerprints | supported | supported (case-fold in containment only) | supported after Phase 1 |
| Symlink refusal / fingerprint | supported | supported | degraded (Developer Mode or admin to create) |
| Docker sandbox (restricted profile) | unverified | unverified | unsupported in v1 (disclosure) |
| Playwright scenario capture | supported | supported | expected after Phase 4; symlink tests skipped without Developer Mode |
| Scripts / CI (`clean`, `e2e:fixture`) | supported | supported | supported after Phase 4 (Node replacements) |

## Security policy: private artifacts

The harness stores raw traces and pseudonymization/sealing keys outside the
workspace under a private state root (default `~/.local/state/migration-harness/<hash>/`).
On filesystems that enforce POSIX modes, directories are `0700` and files `0600`;
anything else is refused.

On Windows, `chmod`/`stat.mode` permission bits are synthetic and do not enforce
NTFS ACLs. The harness therefore classifies each run:

- **STRICT** — private writes enforce `0700`/`0600` (Linux, macOS) or a future
  equivalent ACL check. Default. No privacy disclosure is required.
- **DEGRADED_INSECURE** — private writes proceed without enforceable isolation.
  Requires explicit opt-in (`--allow-insecure-private-store` or
  `privacy.allowInsecurePrivateStore` in MigrationConfig; the CLI flag wins).
  Without opt-in, private writes fail with an error citing this document.

Degraded mode is a documented weakening of **privacy** guarantees only. It never
weakens equivalence criteria, scope checks, or evidence integrity. It never
passes silently:

- Preflight / reports record `WEAK_PRIVATE_PERMISSIONS` and `DEGRADED_ISOLATION`.
- `MigrationReport.privacy.mode` is `DEGRADED_INSECURE`.
- Reports omit isolation-guarantee language while degraded.
- `PR_READY` and equivalence conclusions remain available, but consumers must
  display the privacy disclosure.

This policy was authorized by the maintainer for Windows portability. It does
not authorize reading `.migration-private` or the private artifact root from
assistant contexts on any OS.

## Blocker catalog

| # | Blocker | Evidence | Linux | macOS | Windows | Fixed in |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Process-group kill (`process.kill(-pid)`) and hard reject of `win32` | `packages/engine/src/project-checks.ts:56-57,105-124` | OK | OK | hard fail | Phase 2 |
| 2 | POSIX mode enforcement (refuse unless 0700/0600) | `packages/engine/src/artifacts.ts:47-53,83-87`, `sealing.ts`, `migration-operations.ts`, `cli/src/index.ts` | OK | OK | hard fail | Phase 3 |
| 3 | Hardcoded `join(homedir(), '.local/state/migration-harness')` | 9 sites (artifacts, project-checks, migration-scope, migration-operations, migration-session, assistant-files, importers, bounded-worker, copilot-boundary-hook) | OK | OK (non-idiomatic) | wrong layout | Phase 1 |
| 4 | Containment via `split('/')` / `startsWith(root+'/')` | project-checks, migration-scope, migration-session, migration-operations, build-servers, discover, capture-suite | OK | case-fold gap | broken | Phase 1 |
| 5 | `O_NOFOLLOW`, `nlink !== 1`, ino/dev identity checks | sealing, artifacts, migration-scope, migration-session | OK | OK | semantics differ | Phase 1 (policy) |
| 6 | Symlink-based checks and tests | engine tests, scenario-runner | OK | OK | Developer Mode required | Phase 4 (skip gate) |
| 7 | Docker sandbox PATH fallback `/usr/bin:/bin` | `packages/llm-worker/src/sandbox.ts` | OK | OK | Docker Desktop required | Phase 4 (disclosure) |
| 8 | bash-only scripts and ubuntu-only CI | root `package.json`, workflows | OK | OK | fail | Phase 4 |
| 9 | `MigrationPathSchema` rejects `\` | `packages/core/src/migration-config.ts:12-13` | by design | by design | keep POSIX-relative contract | non-goal |
| 10 | CRLF/`core.autocrlf` vs sha256 of file bytes | beforeHash, scope fingerprints | OK | OK | silent mismatch risk | Phase 1 note + Phase 5 |
| 11 | Case-insensitive FS vs path-string fingerprints | scope fingerprinting | OK | APFS default | NTFS | Phase 1 (containment only) |
| 12 | `/proc` in tests, `/usr/bin/chromium` in e2e | tests, `scripts/e2e_browser.py` | OK | partial | fail | Phase 4 |

Already portable: `shell: false` for project commands; `execFile(process.execPath)`
in tests; env allowlist includes `TMP`/`TEMP`; `ArtifactStore` accepts a
`privateRoot` override; some `\` → `/` normalization exists at CLI and
scenario-runner boundaries.

## Non-goals (v1)

- NTFS ACL enforcement (optional later; v1 uses insecure mode + disclosure).
- Windows Job Objects (only if `taskkill /T` proves insufficient).
- Docker sandbox on Windows.
- Widening `MigrationPathSchema` to accept `\`. Config paths stay POSIX-relative;
  filesystem boundaries convert with `toPosix`/`fromPosix`.
- Isolation guarantees under weak permissions — explicitly not claimed.

## Risks

- **CRLF / autocrlf:** byte hashes (`beforeHash`, scope fingerprints, `fileHash`)
  change if line endings are rewritten. Keep candidate checkouts without
  `core.autocrlf` rewriting inside hashed inputs, or normalize before hash
  consistently (documented; not silently rewritten by the harness).
- **Case folding:** containment comparisons may case-fold on `win32`/`darwin`;
  declared relative path strings used in fingerprints are not case-folded.
- **Symlinks on Windows:** tests that create symlinks skip without Developer Mode;
  skips are recorded, never silent.
- **`taskkill /T` races:** a reparented grandchild can escape the tree kill;
  residual risk is documented and repeated `/T` is used on the hard pass.
- **Docker Desktop:** restricted-profile sandbox remains Unix-oriented in v1.

## Schema notes for disclosure codes

`ProjectPreflightSchema` requires `status === 'PASS'` iff `findings` is empty
(`packages/core/src/project-check.ts`). Privacy disclosures therefore use a
parallel disclosure channel rather than blocking findings, so a run can PASS
with an explicit `WEAK_PRIVATE_PERMISSIONS` disclosure.

`MigrationDiagnosticSchema` PASS consistency
(`packages/core/src/migration-report.ts`) allowlists disclosure-class codes.
`WEAK_PRIVATE_PERMISSIONS` and `DEGRADED_ISOLATION` are added to that allowlist
so they accompany PASS without contradicting it.
