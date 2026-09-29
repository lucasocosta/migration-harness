# Fixtures

P7 pilot (API-pure PHP -> Java pair with real persistence). No fixture files and no mocks:
both APIs are deterministic handlers over real stores — SQLite through PDO on the source
side, embedded H2 JSON documents on the target side — so `GET /api/profile` reads the
persisted customer, `PUT /api/customer` writes it atomically together with its audit
record, and the declared reset commands recreate the identical synthetic baseline
(`fixtureKey: "default"`, audit count 0) before every independent run. The six scenarios
in `../migration.json` therefore declare this directory as `fixtureRoot` while it stays
empty; the state evidence comes from each side's declared probe command, not from files
here.

Nothing here derives from observed traces: the emails, the name, the error strings and the
`faultPhase`/`X-Fault-Phase` fault trigger are invented specification values shared
verbatim by both sides.
