package com.example.apifirst;

import java.util.LinkedHashMap;
import java.util.regex.Pattern;

/**
 * API-pure rules of the target side.
 *
 * The PHP source (examples/api-first/source/validation.php) implements exactly the same
 * rules. Keep both sides byte-for-byte identical in behavior: same pattern, same status
 * codes, same response bodies, same key order. This class depends on the JDK only, so
 * RegressionTest can run it with {@code java -cp target/classes} and no extra classpath.
 */
public final class ApiSemantics {

    /** The validation rule, spelled identically on both sides: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ */
    static final Pattern EMAIL_PATTERN = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

    static final String PROFILE_EMAIL = "user@example.test";
    static final String PROFILE_NAME = "Example User";

    private ApiSemantics() {
    }

    /** Fixed deterministic profile document served by GET /api/profile. */
    static LinkedHashMap<String, String> profileBody() {
        LinkedHashMap<String, String> body = new LinkedHashMap<>();
        body.put("email", PROFILE_EMAIL);
        body.put("name", PROFILE_NAME);
        return body;
    }

    /** The validation rule: a string email matching EMAIL_PATTERN. */
    static boolean isValidEmail(String email) {
        return email != null && EMAIL_PATTERN.matcher(email).matches();
    }

    /**
     * Save outcome of PUT /api/customer: status code plus response body.
     * Mirrors saveOutcome() in validation.php. A null email (malformed JSON, missing
     * field, non-string field) is invalid, and a pattern mismatch is invalid too.
     */
    static Outcome saveOutcome(String email) {
        if (!isValidEmail(email)) {
            return new Outcome(422, body("error", "invalid email"));
        }
        return new Outcome(200, body("status", "saved", "email", email));
    }

    /**
     * Outcome of a validated save whose atomic write failed (declared fault injection or a
     * genuine store failure): 500 with the fixed body. Mirrors saveFailureOutcome() in
     * validation.php; the persistence layer returns it, never an exception, to the controller.
     */
    static Outcome injectedFailure() {
        return new Outcome(500, body("error", "injected failure"));
    }

    private static LinkedHashMap<String, String> body(String... keyValues) {
        LinkedHashMap<String, String> body = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            body.put(keyValues[i], keyValues[i + 1]);
        }
        return body;
    }

    /** One endpoint outcome: HTTP status plus the exact response body in key order. */
    record Outcome(int status, LinkedHashMap<String, String> body) {
    }
}
