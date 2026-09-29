# Executable API-first example (P7 pilot)

A tiny **API-pure migration pair**: a PHP 8.3 source API (built-in web server) and a
Java 21 Spring Boot target API (Maven, `spring-boot-starter-web` only). Both sides
implement the same two endpoints with byte-for-byte behavioral parity, so the example
exercises **managed serve mode** (`serve` command + `readyTimeoutMs` per side) and
**HTTP request scenarios** (`action: "request"` steps) instead of a browser UI.

| Endpoint | Behavior (identical on both sides) |
| --- | --- |
| `GET /api/profile` | 200 `{"email":"user@example.test","name":"Example User"}` (fixed, deterministic) |
| `PUT /api/customer` with `{"email":"..."}` | email is a string matching `^[^@\s]+@[^@\s]+\.[^@\s]+$` -> 200 `{"status":"saved","email":"<echoed unchanged>"}`; otherwise -> 422 `{"error":"invalid email"}` |
| anything else | other method on the known paths -> 405 `{"error":"method not allowed"}`; other path -> 404 `{"error":"not found"}`; `TRACE` (any path) -> 405 with an empty body, mirroring the target container's refusal |

No other request fields are read, no other response fields are written, and there is
no persistence side effect between runs. The rules are spelled identically in
`source/validation.php` + `source/index.php` and `target/.../ApiSemantics.java` +
`target/.../ProfileController.java`.

## Layout

```
migration.json            profile "standard", 3 HTTP scenarios, 5 RESPONSE_FIELD requirements
source/                   index.php (router), validation.php (rules), build.php (php -l + dist/),
                          tests/validation-test.php (plain PHP regression, exit 0/1)
target/                   pom.xml (Spring Boot 3.3, Java 21), src/main/java/.../ApiFirstApplication,
                          ApiSemantics (JDK-only rules), ProfileController (single controller),
                          RegressionTest (plain main, no JUnit)
fixtures/README.md        no mocks: both APIs are deterministic, so nothing is fetched or stored
```

## Requirements

- PHP 8.3+ (`php`, `php -S`)
- JDK 21 (`java`, `javac` via Maven toolchain)
- Maven 3.8.7+ (`mvn`; first run downloads `spring-boot-starter-web` from Maven Central)

## Build and test locally

```bash
php examples/api-first/source/build.php                    # php -l all files + stage dist/
php examples/api-first/source/tests/validation-test.php    # source regression, exit 0/1
mvn -q -DskipTests package -f examples/api-first/target/pom.xml   # executable jar + classes
java -cp examples/api-first/target/classes com.example.apifirst.RegressionTest
```

Build output (`source/dist/`, `target/target/`) is disposable managed output; the root
`.gitignore` already excludes it.

## Verify the implemented example

Ports **8310** (source) and **8353** (target) must be free; the harness owns and
closes both servers. Use a fresh `--artifact-path` for preparation, and never reset a
session to dodge a budget.

```bash
node packages/cli/dist/index.js prepare-migration \
  --config examples/api-first/migration.json --workspace-root . \
  --artifact-path artifacts/api-first/prepared --allow-project-commands
node packages/cli/dist/index.js start-migration-session \
  --config examples/api-first/migration.json --workspace-root . \
  --preparation artifacts/api-first/prepared/preparation.json
# Both APIs are implemented; verify the complete suite:
node packages/cli/dist/index.js verify-migration \
  --config examples/api-first/migration.json --workspace-root . --allow-project-commands
node packages/cli/dist/index.js migration-session-status \
  --config examples/api-first/migration.json --workspace-root .
```

## What this example exercises

- Managed serve mode: each side declares a `serve` command
  (`php -S 127.0.0.1:8310 -t . index.php` / `java -jar target/api-first-target.jar --server.port=8353`)
  with `readyTimeoutMs: 60000`, so the harness starts and stops both APIs itself.
- HTTP request scenarios: three scenarios drive `action: "request"` steps
  (`GET /api/profile`, `PUT` with `new@example.test`, `PUT` with `not-an-email`) with
  per-side `entryUrl` bindings under the fixed ports above.
- Requirements use `RESPONSE_FIELD` claims (`path` + `valueType: "string"`) at
  `SCENARIO_END`, covering the profile email/name, the save status/email and the
  invalid-email error.
- Native checks are the two build commands plus both regressions
  (`source-regression`, `target-regression`, both `kind: "test"` and required).
- Everything here is invented (emails, names, error strings). No value derives from a
  trace. Preparation fixes source behavior but does not approve a migration, and a
  verification PASS covers only this declared suite: three requests and five field
  claims, not exhaustive input ranges.
