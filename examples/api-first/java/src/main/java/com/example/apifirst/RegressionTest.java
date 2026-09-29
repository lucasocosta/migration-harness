package com.example.apifirst;

import java.util.ArrayList;
import java.util.List;

/**
 * Target regression: a plain Java main with explicit checks, no JUnit and no test
 * dependency. Run after the build with:
 *
 *   java -cp target/classes com.example.apifirst.RegressionTest
 *
 * The classpath deliberately contains only target/classes, so everything it touches
 * (ApiSemantics) must be JDK-only. Raw-JSON extraction lives in ProfileController and
 * is exercised end-to-end by the HTTP scenarios; the checks below mirror
 * examples/api-first/source/tests/validation-test.php case for case.
 */
public final class RegressionTest {

    private static final List<String> failures = new ArrayList<>();

    private static void check(boolean condition, String message) {
        if (condition) {
            System.out.println("ok: " + message);
        } else {
            failures.add(message);
            System.err.println("FAIL: " + message);
        }
    }

    public static void main(String[] args) {
        // The validation rule: strings matching the pattern are valid.
        check(ApiSemantics.isValidEmail("new@example.test"), "plain address matches the rule");
        check(ApiSemantics.isValidEmail("user.name+tag@sub.example.test"), "tagged subdomain address matches the rule");
        check(ApiSemantics.isValidEmail("a@b.c"), "minimal address matches the rule");
        check(!ApiSemantics.isValidEmail("not-an-email"), "address without @ and dot fails the rule");
        check(!ApiSemantics.isValidEmail("a@b"), "address without a dot part fails the rule");
        check(!ApiSemantics.isValidEmail("@example.test"), "empty local part fails the rule");
        check(!ApiSemantics.isValidEmail("user@"), "empty domain part fails the rule");
        check(!ApiSemantics.isValidEmail("user@example."), "empty part after the dot fails the rule");
        check(!ApiSemantics.isValidEmail("a b@example.test"), "whitespace in the local part fails the rule");
        check(!ApiSemantics.isValidEmail("a@b c.test"), "whitespace in the domain fails the rule");
        check(!ApiSemantics.isValidEmail("a@b@c.test"), "two @ separators fail the rule");
        check(!ApiSemantics.isValidEmail(null), "null email fails the rule");

        // Save outcome: exact status codes and exact response bodies.
        ApiSemantics.Outcome valid = ApiSemantics.saveOutcome("new@example.test");
        check(valid.status() == 200, "valid save answers 200");
        check(valid.body().size() == 2, "valid save body has exactly two fields");
        check("saved".equals(valid.body().get("status")), "valid save status is exactly saved");
        check("new@example.test".equals(valid.body().get("email")), "valid save echoes the email unchanged");
        check(List.of("status", "email").equals(List.copyOf(valid.body().keySet())),
                "valid save body key order is status then email");

        ApiSemantics.Outcome invalid = ApiSemantics.saveOutcome("not-an-email");
        check(invalid.status() == 422, "invalid save answers 422");
        check(invalid.body().size() == 1, "invalid save body has exactly one field");
        check("invalid email".equals(invalid.body().get("error")), "invalid save body is exactly the error");

        ApiSemantics.Outcome missing = ApiSemantics.saveOutcome(null);
        check(missing.status() == 422, "missing email answers 422");
        check("invalid email".equals(missing.body().get("error")), "missing email body is exactly the error");
        check(ApiSemantics.saveOutcome("a@b").status() == 422, "saveOutcome re-checks the pattern");

        // Profile document: exact body and key order.
        var profile = ApiSemantics.profileBody();
        check(profile.size() == 2, "profile body has exactly two fields");
        check("user@example.test".equals(profile.get("email")), "profile email is exactly user@example.test");
        check("Example User".equals(profile.get("name")), "profile name is exactly Example User");
        check(List.of("email", "name").equals(List.copyOf(profile.keySet())),
                "profile body key order is email then name");

        if (!failures.isEmpty()) {
            System.err.println(failures.size() + " failure(s)");
            System.exit(1);
        }
        System.out.println("All regression checks passed");
    }

    private RegressionTest() {
    }
}
