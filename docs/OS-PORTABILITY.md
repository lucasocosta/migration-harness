# OS Portability

Native support target: **Windows, Linux, and macOS**. Linux/WSL remains supported and
is the only environment with recorded migration evidence so far. This document is the
current security policy for private-artifact protection across operating systems, plus a
historical appendix of the blockers that were removed. Behavior on a strict Linux
filesystem does not change.

Status legend: **supported** (equivalent guarantees), **degraded** (runs with an
explicit disclosure), **unsupported** (feature refused or unavailable).

## Current state (2026-10-03)

Phases 0–5 of the portability plan are implemented in this tree: shared
`platform-paths`/`process-tree` modules, the degraded privacy policy with disclosures,
portable scripts, and multi-OS CI including Playwright browser e2e on
ubuntu/windows/macos. End-to-end migration acceptance evidence is still Linux-only, and
Windows runs use DEGRADED privacy unless NTFS ACLs land later.

| Feature | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Private artifact store (raw traces, keys) | supported (0700/0600) | supported (0700/0600) | degraded (opt-in insecure mode) |
| Project-command lifecycle / tree kill | supported (POSIX groups) | supported (POSIX groups) | supported (`taskkill /T`) |
| Path containment / scope fingerprints | supported | supported (case-fold in containment only) | supported |
| Symlink refusal / fingerprint | supported | supported | degraded (Developer Mode or admin to create) |
| Docker sandbox (restricted profile) | unverified | unverified | unsupported in v1 (disclosure) |
| Playwright scenario capture | supported | supported | supported; symlink tests skip without Developer Mode |
| Scripts / CI (`clean`, `e2e:fixture`) | supported | supported | supported (Node replacements) |

Already portable: `shell: false` for project commands, `execFile(process.execPath)` in
tests, an env allowlist that includes `TMP`/`TEMP`, an `ArtifactStore` `privateRoot`
override, and `\` → `/` normalization at the CLI and scenario-runner boundaries.

## Security policy: private artifacts

The harness stores raw traces and pseudonymization/sealing keys outside the workspace
under a private state root (default `~/.local/state/migration-harness/<hash>/`). On
filesystems that enforce POSIX modes, directories are `0700` and files `0600`;
anything else is refused.

On Windows, `chmod`/`stat.mode` permission bits are synthetic and do not enforce NTFS
ACLs. The harness therefore classifies each run:

- **STRICT** — private writes enforce `0700`/`0600` (Linux, macOS) or a future
  equivalent ACL check. Default. No privacy disclosure is required.
- **DEGRADED_INSECURE** — private writes proceed without enforceable isolation.
  Requires explicit opt-in (`--allow-insecure-private-store` or
  `privacy.allowInsecurePrivateStore` in MigrationConfig; the CLI flag wins).
  Without opt-in, private writes fail with an error citing this document.

Degraded mode is a documented weakening of **privacy** guarantees only. It never
weakens equivalence criteria, scope checks or evidence integrity, and it never passes
silently:

- Preflight / reports record `WEAK_PRIVATE_PERMISSIONS` and `DEGRADED_ISOLATION`.
- `MigrationReport.privacy.mode` is `DEGRADED_INSECURE`.
- Reports omit isolation-guarantee language while degraded.
- `PR_READY` and equivalence conclusions remain available, but consumers must display
  the privacy disclosure.

This policy was authorized by the maintainer for Windows portability. It does not
authorize reading `.migration-private` or the private artifact root from assistant
contexts on any OS.

## Risks

- **CRLF / `core.autocrlf`:** byte hashes (`beforeHash`, scope fingerprints, `fileHash`)
  change if line endings are rewritten. Keep candidate checkouts without `core.autocrlf`
  rewriting inside hashed inputs, or normalize before hashing consistently — the harness
  never rewrites bytes silently.
- **Case folding:** containment comparisons may case-fold on `win32`/`darwin`; declared
  relative path strings used in fingerprints are not case-folded.
- **Symlinks on Windows:** tests that create symlinks skip without Developer Mode; skips
  are recorded, never silent.
- **`taskkill /T` races:** a reparented grandchild can escape the tree kill; residual risk
  is documented and repeated `/T` is used on the hard pass.
- **Docker Desktop:** the restricted-profile sandbox remains Unix-oriented in v1.
- **Same-user access:** hashes, static scans and hooks are not isolation against a
  hostile same-user process.

## Non-goals (v1)

- NTFS ACL enforcement (optional later; v1 uses insecure mode + disclosure).
- Windows Job Objects (only if `taskkill /T` proves insufficient).
- Docker sandbox on Windows.
- Widening `MigrationPathSchema` to accept `\`. Config paths stay POSIX-relative;
  filesystem boundaries convert with `toPosix`/`fromPosix`.
- Isolation guarantees under weak permissions — explicitly not claimed.

## Schema notes for disclosure codes

`ProjectPreflightSchema` requires `status === 'PASS'` iff `findings` is empty
(`packages/core/src/project-check.ts`). Privacy disclosures therefore use a parallel
disclosure channel rather than blocking findings, so a run can PASS with an explicit
`WEAK_PRIVATE_PERMISSIONS` disclosure.

`MigrationDiagnosticSchema` PASS consistency (`packages/core/src/migration-report.ts`)
allowlists disclosure-class codes: `WEAK_PRIVATE_PERMISSIONS` and `DEGRADED_ISOLATION`
are on that allowlist so they accompany PASS without contradicting it.

## Appendix: historical blocker catalog

Recorded during the 2026-09 portability work and kept as history, not as a status
source. "Fixed in" names the phase that removed the blocker in this tree, and the code
references are contemporaneous citations that may no longer match current line numbers —
use the support matrix above for today's state.

| # | Blocker | Linux | macOS | Windows | Fixed in |
| --- | --- | --- | --- | --- | --- |
| 1 | Process-group kill (`process.kill(-pid)`) and hard reject of `win32` | OK | OK | hard fail | Phase 2 |
| 2 | POSIX mode enforcement (refuse unless 0700/0600) | OK | OK | hard fail | Phase 3 |
| 3 | Hardcoded `join(homedir(), '.local/state/migration-harness')` at 9 sites | OK | OK (non-idiomatic) | wrong layout | Phase 1 |
| 4 | Containment via `split('/')` / `startsWith(root+'/')` | OK | case-fold gap | broken | Phase 1 |
| 5 | `O_NOFOLLOW`, `nlink !== 1`, ino/dev identity checks | OK | OK | semantics differ | Phase 1 (policy) |
| 6 | Symlink-based checks and tests | OK | OK | Developer Mode required | Phase 4 (skip gate) |
| 7 | Docker sandbox PATH fallback `/usr/bin:/bin` | OK | OK | Docker Desktop required | Phase 4 (disclosure) |
| 8 | bash-only scripts and ubuntu-only CI | OK | OK | fail | Phase 4 |
| 9 | `MigrationPathSchema` rejects `\` | by design | by design | keep POSIX-relative contract | non-goal |
| 10 | CRLF/`core.autocrlf` vs sha256 of file bytes | OK | OK | silent mismatch risk | Phase 1 note + Phase 5 |
| 11 | Case-insensitive FS vs path-string fingerprints | OK | APFS default | NTFS | Phase 1 (containment only) |
| 12 | `/proc` in tests, `/usr/bin/chromium` in e2e | OK | partial | fail | Phase 4 |
