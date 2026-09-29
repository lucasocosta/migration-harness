<?php
declare(strict_types=1);

/**
 * Source regression (migration.json: argv ["php","tests/validation-test.php"]).
 * Plain PHP, no framework: exits 0 when every check passes, 1 otherwise.
 * The Java target mirrors these checks in RegressionTest.java.
 */

require __DIR__ . '/../validation.php';

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

if ($failures > 0) {
    fwrite(STDERR, "{$failures} failure(s)\n");
    exit(1);
}
fwrite(STDOUT, "All regression checks passed\n");
exit(0);
