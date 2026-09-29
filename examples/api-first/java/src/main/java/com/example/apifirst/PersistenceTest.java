package com.example.apifirst;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * Target persistence test: a plain Java main with explicit checks, no JUnit and no test
 * dependency. Run after the build with:
 *
 *   java -cp target/classes com.example.apifirst.PersistenceTest
 *
 * Its OWN reset -> action -> assert cycle runs against a real embedded H2 store
 * (data/persistence-test), so it never depends on scenario state and, as a native check, it
 * runs before the suite capture. It mirrors
 * examples/api-first/source/tests/validation-test.php case for case, covering save-then-read,
 * invalid-no-effect, injected-failure rollback and audit exactly-once. Expectations are derived
 * from ApiSemantics.profileBody() rather than literals, so a controlled regression of the
 * profile constants still diverges in the HTTP scenarios instead of failing this native test.
 */
public final class PersistenceTest {

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
        String store = CustomerStore.TEST_DB;
        LinkedHashMap<String, String> baselineProfile = ApiSemantics.profileBody();
        try {
            // ---- Reset: identical synthetic baseline (fixtureKey sentinel, audit count 0). ----
            CustomerStore.reset(store);
            check(CustomerStore.auditCount(store) == 0, "reset seeds an empty audit collection");
            check(baselineProfile.equals(CustomerStore.profileBody(store)),
                "reset seeds exactly one sentinel customer with the baseline profile");
            String baseline = CustomerStore.probeProjection(store);
            check(baseline.contains("\"_settle\":\"complete\""), "projection reports the declared completion marker");
            check(baseline.contains("\"audit\":{\"count\":0}"), "projection reports the empty audit collection");
            check(baseline.contains("\"fixtureKey\":\"" + CustomerStore.FIXTURE_KEY + "\""),
                "projection reports the fixture key of the sentinel customer");
            check(baseline.contains("\"email\":\"" + CustomerStore.jsonEscape(baselineProfile.get("email")) + "\""),
                "projection reports the baseline email");

            // (1) Save-then-read: the write survives a fresh read through a new connection.
            ApiSemantics.Outcome saved = CustomerStore.saveRequest("persisted@example.test", false, store);
            check(saved.status() == 200 && "saved".equals(saved.body().get("status"))
                && "persisted@example.test".equals(saved.body().get("email")),
                "valid save answers 200 and persists");
            LinkedHashMap<String, String> readBack = CustomerStore.profileBody(store);
            check("persisted@example.test".equals(readBack.get("email"))
                && baselineProfile.get("name").equals(readBack.get("name")),
                "a fresh read returns the persisted email and the unchanged name");
            check(CustomerStore.auditCount(store) == 1, "one successful save leaves exactly one audit record");

            // (2) Invalid input leaves the state untouched.
            String before = CustomerStore.probeProjection(store);
            ApiSemantics.Outcome invalid = CustomerStore.saveRequest("not-an-email", false, store);
            check(invalid.status() == 422 && "invalid email".equals(invalid.body().get("error")),
                "invalid save answers 422");
            check(before.equals(CustomerStore.probeProjection(store)), "invalid input changes no persisted state");

            // (3) Injected audit failure rolls back completely: customer AND audit.
            before = CustomerStore.probeProjection(store);
            ApiSemantics.Outcome faulted = CustomerStore.saveRequest("faulted@example.test", true, store);
            check(faulted.status() == 500 && "injected failure".equals(faulted.body().get("error")),
                "injected fault answers 500 injected failure");
            check(before.equals(CustomerStore.probeProjection(store)), "injected fault leaves no partial state");
            check("persisted@example.test".equals(CustomerStore.profileBody(store).get("email")),
                "the rolled-back save never overwrote the customer");
            check(CustomerStore.auditCount(store) == 1, "the rolled-back save added no audit record");

            // The declared fault trigger, spelled exactly as the PHP side spells it.
            check(CustomerStore.faultInjected("audit", "{\"email\":\"a@b.test\"}"),
                "header value audit triggers the fault");
            check(CustomerStore.faultInjected(null, "{\"email\":\"a@b.test\",\"faultPhase\":\"audit\"}"),
                "body field faultPhase=audit triggers the fault");
            check(!CustomerStore.faultInjected(null, "{\"other\":\"x\"}"), "an absent trigger never fires");
            check(!CustomerStore.faultInjected("other", "{\"email\":\"a@b.test\",\"faultPhase\":\"other\"}"),
                "a different fault value never fires");
            check(!CustomerStore.faultInjected(null, "not json"), "a malformed body never fires the fault");
            check(!CustomerStore.faultInjected(null, "{\"x\":{\"faultPhase\":\"audit\"}}"),
                "a nested faultPhase is not a top-level trigger");

            // (4) Audit exactly once per successful save.
            CustomerStore.reset(store);
            CustomerStore.saveRequest("first@example.test", false, store);
            check(CustomerStore.auditCount(store) == 1, "the first save adds exactly one audit record");
            CustomerStore.saveRequest("second@example.test", false, store);
            check(CustomerStore.auditCount(store) == 2, "the second save adds exactly one more audit record");
            check("second@example.test".equals(CustomerStore.profileBody(store).get("email")),
                "the latest save is the one that persists");

            // (5) Reset restores the identical baseline: probe before/after a mutation cycle agrees.
            CustomerStore.reset(store);
            check(baseline.equals(CustomerStore.probeProjection(store)),
                "reset restores the identical synthetic baseline");

            // (6) The projection escaper mirrors PHP's json_encode(..., JSON_UNESCAPED_SLASHES)
            // byte for byte, so both probes stay diffable for every declared field value.
            check("a/b".equals(CustomerStore.jsonEscape("a/b")), "slashes stay raw, like PHP json_encode");
            String quotes = CustomerStore.jsonEscape("q\"w\\e");
            check("q\\\"w\\\\e".equals(quotes), "quotes and backslashes escape, like PHP json_encode");
            check("\\u".concat("00e9").equals(CustomerStore.jsonEscape("\u00e9")),
                "non-ASCII characters become a lowercase four-digit escape, like PHP json_encode");
            String rawDel = "A" + (char) 0x7F + "B";
            check(rawDel.equals(CustomerStore.jsonEscape(rawDel)),
                "0x7F stays raw exactly where PHP leaves it raw");
            check("\\u".concat("0001").equals(CustomerStore.jsonEscape("\u0001")),
                "control characters below 0x20 escape, like PHP json_encode");
        } catch (Exception failure) {
            failures.add("unexpected store failure: " + failure);
            System.err.println("FAIL: unexpected store failure: " + failure);
        }

        if (!failures.isEmpty()) {
            System.err.println(failures.size() + " failure(s)");
            System.out.flush();
            System.err.flush();
            System.exit(1);
        }
        System.out.println("All persistence checks passed");
        System.out.flush();
        // Explicit exit: an embedded H2 store must never keep this JVM alive.
        System.exit(0);
    }

    private PersistenceTest() {
    }
}
