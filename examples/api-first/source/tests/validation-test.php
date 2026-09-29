<?php
declare(strict_types=1);

/**
 * Source regression (migration.json: argv ["php","tests/validation-test.php"]).
 * Plain PHP, no framework: exits 0 when every check passes, 1 otherwise.
 * The Java target mirrors these checks in RegressionTest.java.
 *
 * The second half is the native persistence test (kind "test"): its OWN
 * reset -> action -> assert cycle against a real SQLite store in data/, so it never
 * depends on scenario state and runs before the suite capture. The Java target mirrors
 * it case for case in PersistenceTest.java.
 */

require __DIR__ . '/../validation.php';
require __DIR__ . '/../store.php';

$failures = 0;

function check(bool $ok, string $message): void
{
    global $failures;
    if ($ok) {
        fwrite(STDOUT, "ok: {$message}\n");
    } else {
        $failures++;
        fwrite(STDERR, "FAIL: {$message}\n");
    }
}

// The validation rule: strings matching the pattern are valid.
check(isValidEmail('new@example.test'), 'plain address matches the rule');
check(isValidEmail('user.name+tag@sub.example.test'), 'tagged subdomain address matches the rule');
check(isValidEmail('a@b.c'), 'minimal address matches the rule');
check(!isValidEmail('not-an-email'), 'address without @ and dot fails the rule');
check(!isValidEmail('a@b'), 'address without a dot part fails the rule');
check(!isValidEmail('@example.test'), 'empty local part fails the rule');
check(!isValidEmail('user@'), 'empty domain part fails the rule');
check(!isValidEmail('user@example.'), 'empty part after the dot fails the rule');
check(!isValidEmail('a b@example.test'), 'whitespace in the local part fails the rule');
check(!isValidEmail('a@b c.test'), 'whitespace in the domain fails the rule');
check(!isValidEmail('a@b@c.test'), 'two @ separators fail the rule');

// Raw payload -> echoed email, or null when the payload does not carry a valid email.
check(validCustomerEmail('{"email":"new@example.test"}') === 'new@example.test', 'valid payload echoes the email');
check(validCustomerEmail('{"email":"not-an-email"}') === null, 'invalid email payload is rejected');
check(validCustomerEmail('{"email":123}') === null, 'non-string email is rejected');
check(validCustomerEmail('{"email":null}') === null, 'null email is rejected');
check(validCustomerEmail('{"other":"a@b.test"}') === null, 'absent email is rejected');
check(validCustomerEmail('{"email":"a@b.test","name":"Ignored"}') === 'a@b.test', 'extra request fields are ignored');
check(validCustomerEmail('') === null, 'empty body is rejected');
check(validCustomerEmail('not json') === null, 'malformed body is rejected');
check(validCustomerEmail('[1,2]') === null, 'non-object body is rejected');

// Save outcome: exact status codes and exact response bodies.
$valid = saveOutcome(validCustomerEmail('{"email":"new@example.test"}'));
check($valid['status'] === 200, 'valid save answers 200');
check($valid['body'] === ['status' => 'saved', 'email' => 'new@example.test'], 'valid save body is exactly status+email');
$invalid = saveOutcome(validCustomerEmail('{"email":"not-an-email"}'));
check($invalid['status'] === 422, 'invalid save answers 422');
check($invalid['body'] === ['error' => 'invalid email'], 'invalid save body is exactly the error');
check(saveOutcome(null)['status'] === 422, 'missing email answers 422');
check(saveOutcome('a@b')['status'] === 422, 'saveOutcome re-checks the pattern');

// Profile document: exact body and key order.
check(profileBody() === ['email' => 'user@example.test', 'name' => 'Example User'], 'profile body is exactly email+name in order');

// ---------------------------------------------------------------------------
// Native persistence test: its own reset -> action -> assert cycle on an
// isolated SQLite store. Expectations are derived from profileBody() (never from
// literals), so a controlled regression of the profile constants cannot turn this
// native test into a false failure while still diverging in the HTTP scenarios.
// ---------------------------------------------------------------------------
$store = __DIR__ . '/../data/persistence-test.sqlite';
$baselineProfile = profileBody();

/** The canonical projection printed by evaluation/state-probe.php. */
function projectionOf(string $path): string
{
    $json = json_encode(storeProjection($path), JSON_UNESCAPED_SLASHES);
    return $json === false ? '' : $json;
}

// Reset: identical synthetic baseline (fixtureKey sentinel customer, audit count 0).
storeReset($store);
$baseline = storeProjection($store);
check($baseline['_settle'] === 'complete', 'projection reports the declared completion marker');
check($baseline['audit'] === ['count' => 0], 'reset seeds an empty audit collection');
check($baseline['customers'] === [[
    'email' => $baselineProfile['email'],
    'fixtureKey' => STORE_FIXTURE_KEY,
    'name' => $baselineProfile['name'],
]], 'reset seeds exactly one sentinel customer with the baseline profile');

// (1) Save-then-read: the write survives a fresh read through a new connection.
$saved = storeSaveRequest('{"email":"persisted@example.test"}', null, $store);
check($saved === ['status' => 200, 'body' => ['status' => 'saved', 'email' => 'persisted@example.test']], 'valid save answers 200 and persists');
check(storeReadProfile($store) === ['email' => 'persisted@example.test', 'name' => $baselineProfile['name']],
    'a fresh read returns the persisted email and the unchanged name');
check(storeProjection($store)['audit'] === ['count' => 1], 'one successful save leaves exactly one audit record');

// (2) Invalid input leaves the state untouched.
$before = projectionOf($store);
$invalid = storeSaveRequest('{"email":"not-an-email"}', null, $store);
check($invalid === ['status' => 422, 'body' => ['error' => 'invalid email']], 'invalid save answers 422');
check(projectionOf($store) === $before, 'invalid input changes no persisted state');

// (3) Injected audit failure rolls back completely: customer AND audit.
$before = projectionOf($store);
$faulted = storeSaveRequest('{"email":"faulted@example.test"}', 'audit', $store);
check($faulted === saveFailureOutcome(), 'header-triggered fault answers 500 injected failure');
check(projectionOf($store) === $before, 'header-triggered fault leaves no partial state');
$faulted = storeSaveRequest('{"email":"faulted@example.test","faultPhase":"audit"}', null, $store);
check($faulted === saveFailureOutcome(), 'body-field-triggered fault answers 500 injected failure');
check(projectionOf($store) === $before, 'body-field-triggered fault leaves no partial state');
check(storeReadProfile($store)['email'] === 'persisted@example.test', 'the rolled-back save never overwrote the customer');

// (4) Audit exactly once per successful save.
storeReset($store);
storeSaveRequest('{"email":"first@example.test"}', null, $store);
check(storeAuditCount($store) === 1, 'the first save adds exactly one audit record');
storeSaveRequest('{"email":"second@example.test"}', null, $store);
check(storeAuditCount($store) === 2, 'the second save adds exactly one more audit record');
check(storeReadProfile($store)['email'] === 'second@example.test', 'the latest save is the one that persists');

// (5) The declared fault trigger, spelled exactly as the Java side spells it.
check(storeFaultInjected('audit', '{"email":"a@b.test"}') === true, 'header value audit triggers the fault');
check(storeFaultInjected(null, '{"email":"a@b.test","faultPhase":"audit"}') === true, 'body field faultPhase=audit triggers the fault');
check(storeFaultInjected(null, '{"other":"x"}') === false, 'an absent trigger never fires');
check(storeFaultInjected('other', '{"email":"a@b.test","faultPhase":"other"}') === false, 'a different fault value never fires');
check(storeFaultInjected(null, 'not json') === false, 'a malformed body never fires the fault');

// Reset restores the identical baseline: probe before/after a mutation cycle must agree.
storeReset($store);
check(projectionOf($store) === json_encode($baseline, JSON_UNESCAPED_SLASHES), 'reset restores the identical synthetic baseline');

if ($failures > 0) {
    fwrite(STDERR, "{$failures} failure(s)\n");
    exit(1);
}
fwrite(STDOUT, "All regression checks passed\n");
exit(0);
