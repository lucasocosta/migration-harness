<?php
declare(strict_types=1);

/**
 * Relational persistence of the source side: one SQLite file (data/app.sqlite) with two
 * tables. The Java target stores the same domain state as JSON documents in an embedded
 * H2 database (examples/api-first/java/.../CustomerStore.java); the physical schemas are
 * deliberately different while the observable domain state stays byte-for-byte identical.
 *
 * Domain state (both sides):
 *   - one customer row keyed by the fixture key "default": email + name;
 *   - an audit collection: exactly one record per successful PUT /api/customer.
 *
 * Writes are atomic: a successful save commits the customer write and the audit write in
 * ONE transaction, so both effects land or neither does (fault-rolls-back depends on it).
 *
 * Declared fixture control (not a store mock): header `X-Fault-Phase: audit` or the
 * equivalent JSON field `"faultPhase":"audit"` makes the AUDIT write fail AFTER the
 * customer write began — a real NOT NULL violation inside the transaction — so the whole
 * transaction rolls back with no partial state and the API answers 500 injected failure.
 *
 * All functions accept an optional $path so the native test can drive an isolated store;
 * the default path is the fixture store used by the serve router, reset.php and the probe.
 */

require_once __DIR__ . '/validation.php';

/** The domain key of the single customer this API manages (the fixtureKey of the projection). */
const STORE_FIXTURE_KEY = 'default';

/** Audit record written by every successful PUT /api/customer. */
const STORE_AUDIT_EVENT = 'customer.saved';

/** Value of the declared fault trigger: header X-Fault-Phase / JSON field faultPhase. */
const STORE_FAULT_VALUE = 'audit';

/** Absolute path of the fixture store (data/ is disposable runtime state, never source). */
function storePath(): string
{
    return __DIR__ . '/data/app.sqlite';
}

/** Open (creating directories when needed) the SQLite store with the fixture pragmas. */
function storeConnect(?string $path = null): PDO
{
    $path = $path ?? storePath();
    $directory = dirname($path);
    if (!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) {
        throw new RuntimeException('cannot create store directory: ' . $directory);
    }
    $pdo = new PDO('sqlite:' . $path);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA journal_mode = WAL');
    return $pdo;
}

/** Create the schema if it does not exist yet. Metadata only: no domain data is written. */
function storeSchema(PDO $pdo): void
{
    $pdo->exec('CREATE TABLE IF NOT EXISTS customer ('
        . 'fixture_key TEXT PRIMARY KEY NOT NULL,'
        . 'email TEXT NOT NULL,'
        . 'name TEXT NOT NULL)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS audit ('
        . 'audit_id INTEGER PRIMARY KEY AUTOINCREMENT,'
        . 'fixture_key TEXT NOT NULL,'
        . 'event TEXT NOT NULL)');
}

/** Seed the synthetic baseline (fixtureKey sentinel + empty audit) when no customer exists. */
function storeSeedIfEmpty(PDO $pdo): void
{
    $existing = $pdo->query('SELECT fixture_key FROM customer LIMIT 1')->fetch(PDO::FETCH_NUM);
    if ($existing !== false) {
        return;
    }
    $profile = profileBody();
    $seed = $pdo->prepare('INSERT INTO customer (fixture_key, email, name) VALUES (?, ?, ?)');
    $seed->execute([STORE_FIXTURE_KEY, $profile['email'], $profile['name']]);
}

/** Serve-router startup: open the store, create the schema and seed an empty baseline. */
function storeBootstrap(?string $path = null): void
{
    $pdo = storeConnect($path);
    storeSchema($pdo);
    storeSeedIfEmpty($pdo);
}

/**
 * Reset command: drop and recreate the schema, then seed the identical synthetic baseline
 * (fixtureKey sentinel customer, audit count 0) so every independent run starts from an
 * equivalent initial domain state on both sides.
 */
function storeReset(?string $path = null): void
{
    $pdo = storeConnect($path);
    $pdo->exec('DROP TABLE IF EXISTS audit');
    $pdo->exec('DROP TABLE IF EXISTS customer');
    storeSchema($pdo);
    storeSeedIfEmpty($pdo);
}

/** Persisted profile document: the customer row, or the fixed profile when no customer exists. */
function storeReadProfile(?string $path = null): array
{
    $pdo = storeConnect($path);
    $read = $pdo->prepare('SELECT email, name FROM customer WHERE fixture_key = ?');
    $read->execute([STORE_FIXTURE_KEY]);
    $row = $read->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        return profileBody();
    }
    return ['email' => $row['email'], 'name' => $row['name']];
}

/**
 * Persist one customer AND exactly one audit record atomically (single transaction; both
 * effects or none). The customer upsert keeps the stored name, so only the email changes.
 *
 * $injectAuditFault is the declared fixture control: the audit INSERT then carries a NULL
 * event, which the NOT NULL rule rejects AFTER the customer write began, and the whole
 * transaction rolls back — no customer change, no audit record.
 */
function storeSave(string $email, bool $injectAuditFault = false, ?string $path = null): void
{
    $pdo = storeConnect($path);
    storeSchema($pdo);
    $profile = profileBody();
    $pdo->beginTransaction();
    try {
        $customer = $pdo->prepare(
            'INSERT INTO customer (fixture_key, email, name) VALUES (?, ?, ?) '
            . 'ON CONFLICT(fixture_key) DO UPDATE SET email = excluded.email');
        $customer->execute([STORE_FIXTURE_KEY, $email, $profile['name']]);
        $audit = $pdo->prepare('INSERT INTO audit (fixture_key, event) VALUES (?, ?)');
        $audit->execute([STORE_FIXTURE_KEY, $injectAuditFault ? null : STORE_AUDIT_EVENT]);
        $pdo->commit();
    } catch (Throwable $failure) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $failure;
    }
}

/** Number of audit records: the domain-level side effect of successful saves. */
function storeAuditCount(?string $path = null): int
{
    $pdo = storeConnect($path);
    return (int) $pdo->query('SELECT COUNT(*) FROM audit')->fetchColumn();
}

/**
 * Declared fault trigger of PUT /api/customer: request header `X-Fault-Phase: audit`, or
 * the documented equivalent JSON field `"faultPhase":"audit"` (the scenario vocabulary has
 * no request-header step, so scenarios declare the field). Both sides spell this rule
 * identically; see CustomerStore.faultInjected(...) on the Java side.
 */
function storeFaultInjected(?string $headerValue, string $raw): bool
{
    if ($headerValue === STORE_FAULT_VALUE) {
        return true;
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return false;
    }
    return array_key_exists('faultPhase', $decoded) && $decoded['faultPhase'] === STORE_FAULT_VALUE;
}

/**
 * PUT /api/customer semantics without an HTTP layer, shared by the serve router and the
 * native persistence test: validate first (invalid input never touches the store), then
 * the atomic save. A store failure on the save path answers the declared 500.
 */
function storeSaveRequest(string $raw, ?string $faultHeader = null, ?string $path = null): array
{
    $email = validCustomerEmail($raw);
    $outcome = saveOutcome($email);
    if ($outcome['status'] !== 200 || $email === null) {
        return $outcome;
    }
    try {
        storeSave($email, storeFaultInjected($faultHeader, $raw), $path);
    } catch (Throwable $failure) {
        return saveFailureOutcome();
    }
    return $outcome;
}

/**
 * Canonical JSON domain projection served by evaluation/state-probe.php:
 *
 *   {"_settle":"complete","audit":{"count":N},"customers":[{"email":"...","fixtureKey":"...","name":"..."}]}
 *
 * Keys are sorted at every level, only declared domain fields appear, and `_settle` reports
 * the declared completion marker (writes are synchronous, so a projection that was read
 * successfully is settled). The probe is read-only: it never writes domain data.
 */
function storeProjection(?string $path = null): array
{
    $pdo = storeConnect($path);
    $customers = [];
    foreach ($pdo->query('SELECT fixture_key, email, name FROM customer ORDER BY fixture_key')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $customers[] = ['email' => $row['email'], 'fixtureKey' => $row['fixture_key'], 'name' => $row['name']];
    }
    $auditCount = (int) $pdo->query('SELECT COUNT(*) FROM audit')->fetchColumn();
    return ['_settle' => 'complete', 'audit' => ['count' => $auditCount], 'customers' => $customers];
}
