<?php
declare(strict_types=1);

/**
 * API-pure rules of the source side.
 *
 * The Java target (examples/api-first/target/src/main/java/com/example/apifirst/ApiSemantics.java)
 * implements exactly the same rules. Keep both sides byte-for-byte identical in behavior:
 * same pattern, same status codes, same response bodies, same key order.
 */

/** The validation rule, spelled identically on both sides. */
const EMAIL_PATTERN = '/^[^@\s]+@[^@\s]+\.[^@\s]+$/';

/** Fixed deterministic profile document served by GET /api/profile. */
function profileBody(): array
{
    return ['email' => 'user@example.test', 'name' => 'Example User'];
}

/** The validation rule: a string email matching EMAIL_PATTERN. */
function isValidEmail(string $email): bool
{
    return preg_match(EMAIL_PATTERN, $email) === 1;
}

/**
 * Raw PUT body -> the email echoed back, or null when the payload is not a JSON object
 * carrying a string email that matches the rule (malformed JSON, missing field, wrong type).
 * Extra request fields are ignored; only `email` is read.
 */
function validCustomerEmail(string $raw): ?string
{
    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !array_key_exists('email', $decoded)) {
        return null;
    }
    $email = $decoded['email'];
    if (!is_string($email)) {
        return null;
    }
    return isValidEmail($email) ? $email : null;
}

/**
 * Save outcome of PUT /api/customer: status code plus response body.
 * Mirrors saveOutcome() in ApiSemantics.java.
 */
function saveOutcome(?string $email): array
{
    if ($email === null || !isValidEmail($email)) {
        return ['status' => 422, 'body' => ['error' => 'invalid email']];
    }
    return ['status' => 200, 'body' => ['status' => 'saved', 'email' => $email]];
}

/**
 * Outcome of a validated save whose atomic write failed (declared fault injection or a
 * genuine store failure): 500 with the fixed body. Mirrors injectedFailure() in
 * ApiSemantics.java; the persistence layer returns it, never an exception, to the router.
 */
function saveFailureOutcome(): array
{
    return ['status' => 500, 'body' => ['error' => 'injected failure']];
}
