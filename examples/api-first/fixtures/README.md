# Fixtures

P7 pilot (API-pure PHP -> Java pair). No fixture files and no mocks: both APIs are
deterministic in-process handlers — `GET /api/profile` always answers the same fixed
document, and `PUT /api/customer` echoes or rejects the submitted email with no
persistence side effect between runs. The three scenarios in `../migration.json`
therefore declare this directory as `fixtureRoot` while it stays empty.

Nothing here derives from observed traces: the email, the name and the error strings
are invented specification values shared verbatim by both sides.
