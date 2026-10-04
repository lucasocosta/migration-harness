# Executable API-first example (P7 pilot)

A tiny **API-pure migration pair**: a PHP 8.3 source API (built-in web server) and a
Java 21 Spring Boot target API (Maven, `spring-boot-starter-web` + embedded H2). Both sides
implement the same two endpoints with byte-for-byte behavioral parity **against real
persistence**, so the example exercises **managed serve mode** (`serve` command +
`readyTimeoutMs` per side), **HTTP request scenarios** (`action: "request"` steps) and the
**database Tier 1 / Tier 2 state vocabulary** (declared resets, native persistence checks,
state probes, `stateCaptures` and `stateClaim`s) instead of a browser UI.

| Endpoint | Behavior (identical on both sides) |
| --- | --- |
| `GET /api/profile` | 200 `{"email":...,"name":...}` **read from the persisted customer** (the reset baseline answers `{"email":"user@example.test","name":"Example User"}` until a save) |
| `PUT /api/customer` with `{"email":"..."}` | email matching `^[^@\s]+@[^@\s]+\.[^@\s]+$` -> 200 `{"status":"saved","email":"<echoed unchanged>"}` **and, atomically, the customer write plus exactly one audit record**; otherwise -> 422 `{"error":"invalid email"}` with the store untouched |
| `PUT /api/customer` with the declared fault trigger | header `X-Fault-Phase: audit` (or the documented equivalent JSON field `"faultPhase":"audit"`) makes the **audit write fail after the customer write began** -> 500 `{"error":"injected failure"}` and a **full rollback**: no customer change, no audit record |
| anything else | other method on the known paths -> 405 `{"error":"method not allowed"}`; other path -> 404 `{"error":"not found"}`; `TRACE` (any path) -> 405 with an empty body, mirroring the target container's refusal |

No other request fields are read as domain input (`faultPhase` only declares the fixture
fault), no other response fields are written, and the rules are spelled identically in
`source/validation.php` + `source/store.php` + `source/index.php` and
`target/.../ApiSemantics.java` + `target/.../CustomerStore.java` +
`target/.../ProfileController.java`.

## Cross-engine stores (deliberately different physical schemas)

| | Source (PHP) | Target (Java) |
| --- | --- | --- |
| Engine | SQLite file `source/data/app.sqlite` (PDO) | Embedded H2 file `java/data/app` (`AUTO_SERVER=TRUE`) |
| Physical schema | relational: `customer` row + `audit` rows | one `documents` table of **JSON DOCUMENT columns** (`customer.default`, `audit.summary` holding the audit count) |
| Customer | row `(fixture_key, email, name)` | document `{"fixtureKey","email","name"}` |
| Audit | one row per successful save | counter document `{"count":N}` |
| Atomicity | one SQLite transaction: customer upsert + audit insert, or neither | one H2 transaction: customer document + audit document, or neither |
| Fault injection | audit insert carries a NULL into the `NOT NULL` column after the customer write began -> real constraint rejection -> rollback | audit document write carries a NULL payload into the `NOT NULL` column after the customer write began -> real constraint rejection -> rollback |

Same domain state, different physical representation: that is the Tier 2 cross-engine
fixture. Both sides share the same **synthetic baseline** (`fixtureKey: "default"`,
email/name from the fixed profile, audit count 0), seeded by the serve bootstrap and
recreated by the reset commands.

## Canonical state probe

Each side declares a `kind: "probe"` command that prints ONE canonical JSON domain
projection to stdout (keys sorted at every level, declared domain fields only, no SQL, no
paths, no secrets, exit 0):

```json
{"_settle":"complete","audit":{"count":1},"customers":[{"email":"roundtrip@example.test","fixtureKey":"default","name":"Example User"}]}
```

- source: `php evaluation/state-probe.php` (read-only; a missing store is exit 1, never an
  invented projection)
- target: `java -cp target/classes com.example.apifirst.StateProbe`

`_settle` is the declared completion marker for the harness's `PROBE_BARRIER` (writes are
synchronous, so a projection that was read successfully is settled). The projections of the
two engines are byte-identical for equivalent state — `tests/api-first-persistence.test.mjs`
asserts exactly that after identical operations.

## Layout

```
migration.json            profile "standard", 6 HTTP scenarios (3 with stateCaptures),
                          14 requirements (9 stateClaim/responseClaim additions),
                          stateProjections (KEYED /customers by fixtureKey + privacy
                          allowlist), reset: COMMANDS, 6 checks (5 native + builds)
source/                   index.php (router + serve bootstrap), validation.php (rules),
                          store.php (SQLite store, atomic save, fault trigger, projection),
                          reset.php (drop/recreate + baseline seed),
                          build.php (php -l every file + dist/),
                          evaluation/state-probe.php (canonical projection),
                          tests/validation-test.php (rules + native persistence cycle)
java/                     pom.xml (Spring Boot 3.3, Java 21, H2 unpacked into
                          target/classes), src/main/java/.../ApiFirstApplication
                          (bootstrap), ApiSemantics (JDK-only rules), ApiExceptionHandler,
                          ProfileController (single controller), CustomerStore (H2 document
                          store), RegressionTest + PersistenceTest (plain mains, no JUnit),
                          Reset, StateProbe
fixtures/README.md        no mocks: both APIs are deterministic and persist for real
examples/api-first/.gitignore  source/data/ + java/data/ (runtime stores, never source)
```

## Requirements

- PHP 8.3+ (`php`, `php -S`, `pdo_sqlite`)
- JDK 21 (`java`, `javac` via Maven toolchain)
- Maven 3.8.7+ (`mvn`; first run downloads `spring-boot-starter-web` and H2 from Maven Central)

## Build and test locally

```bash
php examples/api-first/source/build.php                    # php -l every PHP file + stage dist/
php examples/api-first/source/tests/validation-test.php    # source regression + persistence, exit 0/1
mvn -q -DskipTests package -f examples/api-first/java/pom.xml   # executable jar + classes + H2 driver
java -cp examples/api-first/java/target/classes com.example.apifirst.RegressionTest
java -cp examples/api-first/java/target/classes com.example.apifirst.PersistenceTest
php examples/api-first/source/reset.php                    # reset: drop/recreate + baseline seed
java -cp examples/api-first/java/target/classes com.example.apifirst.Reset
php examples/api-first/source/evaluation/state-probe.php   # canonical projection
java -cp examples/api-first/java/target/classes com.example.apifirst.StateProbe
node --test tests/api-first-persistence.test.mjs           # the persistence suite (toolchain-gated)
```

Build output (`source/dist/`, `java/target/`) and the runtime stores (`source/data/`,
`java/data/`) are disposable; the root `.gitignore` covers the build outputs and
`examples/api-first/.gitignore` covers the stores.

## Verify the implemented example

Ports **8310** (source) and **8353** (target) must be free; the harness owns and
closes both servers. Use a fresh `--artifact-path` for `prepare`, and never reset a
session to dodge a budget. The shipped config already carries `profile: "standard"`,
so there is no `init` step. Run from the repository root after `corepack pnpm build`:

```bash
HARNESS="node packages/cli/dist/index.js"
CFG=examples/api-first/migration.json

$HARNESS doctor --config "$CFG" --workspace-root . --json
$HARNESS prepare --config "$CFG" --workspace-root . \
  --artifact-path artifacts/api-first/prepared --allow-project-commands --json
# Both APIs are implemented; if a repair is needed, edit only the target files listed
# in target.writePaths between two verify runs — no command edits the candidate:
$HARNESS verify --config "$CFG" --workspace-root . --allow-project-commands --json
$HARNESS status --config "$CFG" --workspace-root . --json
```

`doctor` runs no project command; `prepare` opens the session (`decision: READY`) with
`--allow-project-commands` as the explicit consent to run the declared commands;
`verify` spends one attempt per run and takes no reference or output path — the session
owns both; `status` reads budget, blocks and next action without spending an attempt.
For a versioned reference update use `reference` (a weakening is refused until the
owner passes `--owner-decision`); the envelope and exit codes are documented in
[OPERATOR.md](../../docs/OPERATOR.md).

## What this example exercises

- Managed serve mode: each side declares a `serve` command
  (`php -S 127.0.0.1:8310 -t . index.php` / `java -jar target/api-first-target.jar --server.port=8353`)
  with `readyTimeoutMs: 60000`, so the harness starts and stops both APIs itself; both
  applications bootstrap their store (schema + baseline) at startup.
- HTTP request scenarios: six scenarios drive `action: "request"` steps — the original
  three (`GET /api/profile`, `PUT` with `new@example.test`, `PUT` with `not-an-email`) plus
  `save-persists` (save then read back), `invalid-leaves-state` (rejected save, state
  unchanged) and `fault-rolls-back` (declared fault trigger, full rollback) — with per-side
  `entryUrl` bindings under the fixed ports above.
- Declared resets: `reset: {"kind":"COMMANDS"}` runs `php reset.php` / `java ... Reset`
  before every independent run, dropping and recreating each schema and reseeding the same
  synthetic baseline (fixtureKey sentinel), so source stability compares like for like.
- State vocabulary: `stateProjections` declares the `customer-domain` projection
  (`KEYED` collection `/customers` by `fixtureKey`, privacy allowlist on the declared
  paths, `KEYED_EQUALITY` for the customer email); each new scenario carries a
  `stateCaptures` entry at `SCENARIO_END` bound to its side's `probe-state` command with a
  `PROBE_BARRIER` settle on `/_settle == "complete"`; nine requirements add `stateClaim`s
  (`/audit/count` equals 1/0, `/customers/0/email` equals the baseline or saved value) and
  response claims on the new scenarios.
- Requirements use `RESPONSE_FIELD` claims (`path` + `valueType: "string"`) at
  `SCENARIO_END`, covering the profile email/name, the save status/email, the
  invalid-email error and the new scenarios' response fields.
- Native checks are two builds plus three regressions (`source-regression`,
  `target-regression`, `target-persistence`, all `kind: "test"` and required). The
  persistence tests run their OWN reset -> action -> assert cycle against a real store
  (save-then-read, invalid-no-effect, injected-failure rollback, audit exactly-once) before
  the suite capture, so they never depend on scenario state.
- Everything here is invented (emails, names, error strings, the `faultPhase` trigger).
  No value derives from a trace. Preparation fixes source behavior but does not approve a
  migration, and a verification PASS covers only this declared suite: six requests, the
  declared state captures and their claims — not exhaustive input ranges.

Known cross-lane note: the state vocabulary (`kind: "probe"` commands, `stateProjections`,
`stateCaptures`, `stateClaim`) is the P7.8 contract implemented in
`packages/core/src/migration-config.ts` by the schema lane; this example is its first
shipped consumer.