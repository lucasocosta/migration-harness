package com.example.apifirst;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * Document persistence of the target side: one embedded H2 file database (data/app.mv.db)
 * holding the domain state as JSON DOCUMENT rows in a single {@code documents} table. The PHP
 * source stores the same domain state relationally (source/store.php: a customer row plus an
 * audit table); the physical schemas are deliberately different while the observable domain
 * state stays byte-for-byte identical, which is exactly what the Tier 2 cross-engine fixture
 * needs.
 *
 * Domain state (both sides):
 *   - one customer document keyed by the fixture key "default": email + name;
 *   - an audit document holding the audit count: exactly one per successful PUT /api/customer.
 *
 * Writes are atomic: a successful save commits the customer document and the audit document in
 * ONE transaction, so both effects land or neither does. Declared fixture control (not a store
 * mock): {@code faultInjected} — header {@code X-Fault-Phase: audit} or JSON field
 * {@code "faultPhase":"audit"} — makes the audit write carry a NULL payload into the NOT NULL
 * column AFTER the customer write began, so the store rejects it and the whole transaction rolls
 * back with no partial state and the API answers 500 injected failure.
 *
 * This class depends on the JDK and the H2 driver only (no Spring, no Jackson), so StateProbe,
 * Reset and PersistenceTest run it with {@code java -cp target/classes} and no extra classpath.
 * Its tiny flat-JSON reader/writer keeps both probes' projections byte-identical: the escaper
 * mirrors PHP's {@code json_encode(..., JSON_UNESCAPED_SLASHES)} exactly.
 */
public final class CustomerStore {

    /** The domain key of the single customer this API manages (the fixtureKey of the projection). */
    static final String FIXTURE_KEY = "default";

    /** Value of the declared fault trigger: header X-Fault-Phase / JSON field faultPhase. */
    static final String FAULT_VALUE = "audit";

    /** Fixture store of the served application, relative to the project directory (cwd of every command). */
    static final String DEFAULT_DB = "data/app";

    /** Store of the native persistence test: its own reset -> action -> assert lifecycle. */
    static final String TEST_DB = "data/persistence-test";

    private static final String CUSTOMER_DOC = "customer." + FIXTURE_KEY;
    private static final String AUDIT_DOC = "audit.summary";
    private static final String CUSTOMER_KIND = "customer";
    private static final String AUDIT_KIND = "audit";

    /** Escape introducer of jsonEscape (a named constant keeps the source free of literal escape tokens). */
    private static final char BACKSLASH = '\\';

    private CustomerStore() {
    }

    // ------------------------------------------------------------------ connections

    /**
     * Embedded H2 file URL. AUTO_SERVER lets the probe and the reset open the store while the
     * served application holds it open; IFEXISTS makes a read-only observer fail instead of
     * silently creating an empty store it would then have to invent a projection for. A relative
     * store path must be explicit (./data/app), because H2 refuses implicit cwd-relative URLs.
     */
    private static String jdbcUrl(String dbPath, boolean existingOnly) {
        String path = dbPath.startsWith("/") || dbPath.startsWith("~") || dbPath.contains(":")
            ? dbPath : "./" + dbPath;
        return "jdbc:h2:file:" + path + ";AUTO_SERVER=TRUE" + (existingOnly ? ";IFEXISTS=TRUE" : "");
    }

    private static Connection open(String dbPath, boolean existingOnly) throws SQLException {
        try {
            Class.forName("org.h2.Driver");
        } catch (ClassNotFoundException failure) {
            throw new SQLException("H2 driver is not on the classpath", failure);
        }
        return DriverManager.getConnection(jdbcUrl(dbPath, existingOnly), "sa", "");
    }

    // ------------------------------------------------------------------- lifecycle

    /** Create the schema if it does not exist yet: metadata only, no domain data is written. */
    private static void ensureSchema(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE IF NOT EXISTS documents ("
                + "doc_id VARCHAR(64) PRIMARY KEY,"
                + "doc_kind VARCHAR(32) NOT NULL,"
                + "payload CLOB NOT NULL)");
        }
    }

    /** Seed the synthetic baseline (fixtureKey sentinel customer + audit count 0) when a document is absent. */
    private static void seedIfEmpty(Connection connection) throws SQLException {
        if (readDocument(connection, CUSTOMER_DOC) == null) {
            writeDocument(connection, CUSTOMER_DOC, CUSTOMER_KIND,
                customerDocument(ApiSemantics.PROFILE_EMAIL, ApiSemantics.PROFILE_NAME));
        }
        if (readDocument(connection, AUDIT_DOC) == null) {
            writeDocument(connection, AUDIT_DOC, AUDIT_KIND, auditDocument(0));
        }
    }

    /** Serve-time bootstrap: open the store, create the schema and seed an empty baseline. */
    static void bootstrap() throws SQLException {
        try (Connection connection = open(DEFAULT_DB, false)) {
            ensureSchema(connection);
            seedIfEmpty(connection);
        }
    }

    /**
     * Reset command: drop and recreate the schema, then seed the identical synthetic baseline
     * (fixtureKey sentinel customer, audit count 0) so every independent run starts from an
     * equivalent initial domain state on both sides.
     */
    static void reset(String dbPath) throws SQLException {
        try (Connection connection = open(dbPath, false)) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("DROP TABLE IF EXISTS documents");
            }
            ensureSchema(connection);
            seedIfEmpty(connection);
        }
    }

    // -------------------------------------------------------------------- writes

    /**
     * Persist one customer AND exactly one audit record atomically (single transaction; both
     * effects or none). The customer upsert keeps the stored name, so only the email changes.
     */
    static void save(String email, boolean injectAuditFault) throws SQLException {
        save(email, injectAuditFault, DEFAULT_DB);
    }

    static void save(String email, boolean injectAuditFault, String dbPath) throws SQLException {
        try (Connection connection = open(dbPath, false)) {
            connection.setAutoCommit(false);
            try {
                upsertCustomer(connection, email);
                writeAudit(connection, injectAuditFault);
                connection.commit();
            } catch (SQLException | RuntimeException failure) {
                connection.rollback();
                throw failure;
            }
        }
    }

    private static void upsertCustomer(Connection connection, String email) throws SQLException {
        String stored = readDocument(connection, CUSTOMER_DOC);
        String name = stored == null ? ApiSemantics.PROFILE_NAME : requireString(stored, "name");
        writeDocument(connection, CUSTOMER_DOC, CUSTOMER_KIND, customerDocument(email, name));
    }

    private static void writeAudit(Connection connection, boolean injectAuditFault) throws SQLException {
        String stored = readDocument(connection, AUDIT_DOC);
        long count = (stored == null ? 0 : requireLong(stored, "count")) + 1;
        // The declared fixture control writes NULL into the NOT NULL payload AFTER the customer
        // write began: the store rejects it and the transaction rolls back — no partial state.
        writeDocument(connection, AUDIT_DOC, AUDIT_KIND, injectAuditFault ? null : auditDocument(count));
    }

    /**
     * PUT /api/customer semantics without HTTP, shared by the controller and the native test:
     * validate first (invalid input never touches the store), then the atomic save. A store
     * failure on the save path answers the declared 500.
     */
    static ApiSemantics.Outcome saveRequest(String email, boolean injectAuditFault) {
        return saveRequest(email, injectAuditFault, DEFAULT_DB);
    }

    static ApiSemantics.Outcome saveRequest(String email, boolean injectAuditFault, String dbPath) {
        ApiSemantics.Outcome outcome = ApiSemantics.saveOutcome(email);
        if (outcome.status() != 200) {
            return outcome;
        }
        try {
            save(email, injectAuditFault, dbPath);
        } catch (SQLException failure) {
            return ApiSemantics.injectedFailure();
        }
        return outcome;
    }

    // -------------------------------------------------------------------- reads

    /** Persisted profile document: the customer document, or the fixed profile when no customer exists. */
    static LinkedHashMap<String, String> profileBody() throws SQLException {
        try (Connection connection = open(DEFAULT_DB, false)) {
            return readProfile(connection);
        }
    }

    static LinkedHashMap<String, String> profileBody(String dbPath) throws SQLException {
        try (Connection connection = open(dbPath, false)) {
            return readProfile(connection);
        }
    }

    private static LinkedHashMap<String, String> readProfile(Connection connection) throws SQLException {
        String stored = readDocument(connection, CUSTOMER_DOC);
        LinkedHashMap<String, String> profile = new LinkedHashMap<>();
        if (stored == null) {
            profile.put("email", ApiSemantics.PROFILE_EMAIL);
            profile.put("name", ApiSemantics.PROFILE_NAME);
            return profile;
        }
        profile.put("email", requireString(stored, "email"));
        profile.put("name", requireString(stored, "name"));
        return profile;
    }

    /** Number of audit records: the domain-level side effect of successful saves. */
    static long auditCount(String dbPath) throws SQLException {
        try (Connection connection = open(dbPath, false)) {
            String stored = readDocument(connection, AUDIT_DOC);
            return stored == null ? 0 : requireLong(stored, "count");
        }
    }

    /**
     * Canonical JSON domain projection printed by StateProbe:
     *
     *   {"_settle":"complete","audit":{"count":N},"customers":[{"email":"...","fixtureKey":"...","name":"..."}]}
     *
     * Keys are sorted at every level, only declared domain fields appear (no SQL, no paths, no
     * credentials), and {@code _settle} is the declared completion marker the harness's
     * PROBE_BARRIER polls. Read-only: the observer never creates the store (IFEXISTS) and never
     * writes domain data, and a missing or unreadable store is an error — never an invented
     * "empty" projection. The command returns observation, never a verdict.
     */
    static String probeProjection(String dbPath) throws SQLException {
        try (Connection connection = open(dbPath, true)) {
            return projectionOf(connection);
        }
    }

    private static String projectionOf(Connection connection) throws SQLException {
        List<LinkedHashMap<String, String>> customers = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                 "SELECT payload FROM documents WHERE doc_kind = '" + CUSTOMER_KIND + "'")) {
            while (rows.next()) {
                String stored = rows.getString(1);
                LinkedHashMap<String, String> customer = new LinkedHashMap<>();
                customer.put("email", requireString(stored, "email"));
                customer.put("fixtureKey", requireString(stored, "fixtureKey"));
                customer.put("name", requireString(stored, "name"));
                customers.add(customer);
            }
        }
        customers.sort((left, right) -> left.get("fixtureKey").compareTo(right.get("fixtureKey")));
        String audit = readDocument(connection, AUDIT_DOC);
        long count = audit == null ? 0 : requireLong(audit, "count");

        StringBuilder projection = new StringBuilder(256);
        projection.append("{\"_settle\":\"complete\",\"audit\":{\"count\":").append(count).append("},\"customers\":[");
        for (int index = 0; index < customers.size(); index++) {
            if (index > 0) {
                projection.append(',');
            }
            LinkedHashMap<String, String> customer = customers.get(index);
            projection.append("{\"email\":\"").append(jsonEscape(customer.get("email")))
                .append("\",\"fixtureKey\":\"").append(jsonEscape(customer.get("fixtureKey")))
                .append("\",\"name\":\"").append(jsonEscape(customer.get("name"))).append("\"}");
        }
        return projection.append("]}").toString();
    }

    // ----------------------------------------------------------------- documents

    private static String readDocument(Connection connection, String docId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT payload FROM documents WHERE doc_id = ?")) {
            statement.setString(1, docId);
            try (ResultSet rows = statement.executeQuery()) {
                return rows.next() ? rows.getString(1) : null;
            }
        }
    }

    /** One document write: an upsert keyed by doc_id; a NULL payload is a genuine NOT NULL rejection. */
    private static void writeDocument(Connection connection, String docId, String kind, String payload) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "MERGE INTO documents (doc_id, doc_kind, payload) KEY(doc_id) VALUES (?, ?, ?)")) {
            statement.setString(1, docId);
            statement.setString(2, kind);
            statement.setString(3, payload);
            statement.executeUpdate();
        }
    }

    /** Stored customer document (target's physical representation; its key order is internal). */
    private static String customerDocument(String email, String name) {
        return "{\"fixtureKey\":\"" + jsonEscape(FIXTURE_KEY) + "\",\"email\":\"" + jsonEscape(email)
            + "\",\"name\":\"" + jsonEscape(name) + "\"}";
    }

    /** Stored audit document: the audit count as one number field. */
    private static String auditDocument(long count) {
        return "{\"count\":" + count + "}";
    }

    // --------------------------------------------------------------------- JSON

    /**
     * Declared fault trigger of PUT /api/customer: request header {@code X-Fault-Phase: audit},
     * or the documented equivalent JSON field {@code "faultPhase":"audit"} (the scenario
     * vocabulary has no request-header step, so scenarios declare the field). Mirrors
     * storeFaultInjected() in source/store.php, including its top-level-only, string-only read.
     */
    static boolean faultInjected(String headerValue, String raw) {
        if (FAULT_VALUE.equals(headerValue)) {
            return true;
        }
        return FAULT_VALUE.equals(stringField(raw, "faultPhase"));
    }

    /**
     * String escaping identical to PHP's json_encode(..., JSON_UNESCAPED_SLASHES), so both probes
     * print byte-identical projections: slashes stay raw, quotes and backslashes are escaped,
     * control characters below 0x20 and every non-ASCII character become a lowercase four-digit
     * unicode escape (0x7F stays raw, exactly as PHP leaves it).
     */
    static String jsonEscape(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int index = 0; index < value.length(); index++) {
            char at = value.charAt(index);
            switch (at) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (at < 0x20 || at > 0x7F) {
                        // backslash + 'u' + four lowercase hex digits, exactly like PHP json_encode.
                        out.append(BACKSLASH).append('u').append(String.format("%04x", (int) at));
                    } else {
                        out.append(at);
                    }
            }
        }
        return out.toString();
    }

    /** Top-level string field of a flat JSON object, or null when absent, non-string or malformed. */
    static String stringField(String json, String key) {
        int at = valueStart(json, key);
        if (at < 0 || json.charAt(at) != '"') {
            return null;
        }
        int end = scanString(json, at + 1);
        return end < 0 ? null : unescape(json.substring(at + 1, end));
    }

    /** Index of the first character of the top-level key's value, or -1 when absent or malformed. */
    private static int valueStart(String json, String key) {
        if (json == null) {
            return -1;
        }
        int index = 0;
        int length = json.length();
        while (index < length && Character.isWhitespace(json.charAt(index))) {
            index++;
        }
        if (index >= length || json.charAt(index) != '{') {
            return -1;
        }
        index++;
        while (index < length) {
            while (index < length && (Character.isWhitespace(json.charAt(index)) || json.charAt(index) == ',')) {
                index++;
            }
            if (index >= length || json.charAt(index) == '}') {
                return -1;
            }
            if (json.charAt(index) != '"') {
                return -1;
            }
            int keyEnd = scanString(json, index + 1);
            if (keyEnd < 0) {
                return -1;
            }
            String found = unescape(json.substring(index + 1, keyEnd));
            index = keyEnd + 1;
            while (index < length && Character.isWhitespace(json.charAt(index))) {
                index++;
            }
            if (index >= length || json.charAt(index) != ':') {
                return -1;
            }
            index++;
            while (index < length && Character.isWhitespace(json.charAt(index))) {
                index++;
            }
            if (key.equals(found)) {
                return index;
            }
            index = skipValue(json, index);
            if (index < 0) {
                return -1;
            }
        }
        return -1;
    }

    /** Index of the closing quote of the string that starts at {@code start}, or -1. */
    private static int scanString(String json, int start) {
        for (int index = start; index < json.length(); index++) {
            char at = json.charAt(index);
            if (at == '\\') {
                index++;
            } else if (at == '"') {
                return index;
            }
        }
        return -1;
    }

    /** Index just after the JSON value starting at {@code from}, or -1 when it is not well formed. */
    private static int skipValue(String json, int from) {
        int length = json.length();
        if (from >= length) {
            return -1;
        }
        char start = json.charAt(from);
        if (start == '"') {
            int end = scanString(json, from + 1);
            return end < 0 ? -1 : end + 1;
        }
        if (start == '{' || start == '[') {
            int depth = 0;
            boolean quoted = false;
            for (int index = from; index < length; index++) {
                char at = json.charAt(index);
                if (quoted) {
                    if (at == '\\') {
                        index++;
                    } else if (at == '"') {
                        quoted = false;
                    }
                } else if (at == '"') {
                    quoted = true;
                } else if (at == '{' || at == '[') {
                    depth++;
                } else if (at == '}' || at == ']') {
                    depth--;
                    if (depth == 0) {
                        return index + 1;
                    }
                }
            }
            return -1;
        }
        int index = from;
        while (index < length && !Character.isWhitespace(json.charAt(index)) && ",}]".indexOf(json.charAt(index)) < 0) {
            index++;
        }
        return index > from ? index : -1;
    }

    /** JSON string escapes -> characters; null when the fragment is not a well-formed string. */
    private static String unescape(String fragment) {
        StringBuilder out = new StringBuilder(fragment.length());
        for (int index = 0; index < fragment.length(); index++) {
            char at = fragment.charAt(index);
            if (at != '\\' || index + 1 >= fragment.length()) {
                out.append(at);
                continue;
            }
            char escaped = fragment.charAt(++index);
            switch (escaped) {
                case '"': out.append('"'); break;
                case '\\': out.append('\\'); break;
                case '/': out.append('/'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'u':
                    if (index + 4 >= fragment.length()) {
                        return null;
                    }
                    try {
                        out.append((char) Integer.parseInt(fragment.substring(index + 1, index + 5), 16));
                    } catch (NumberFormatException invalid) {
                        return null;
                    }
                    index += 4;
                    break;
                default:
                    return null;
            }
        }
        return out.toString();
    }

    private static String requireString(String json, String key) throws SQLException {
        String value = stringField(json, key);
        if (value == null) {
            throw new SQLException("unreadable document field: " + key);
        }
        return value;
    }

    private static long requireLong(String json, String key) throws SQLException {
        int at = valueStart(json, key);
        int end = at;
        if (at >= 0) {
            while (end < json.length() && "-0123456789".indexOf(json.charAt(end)) >= 0) {
                end++;
            }
        }
        if (at < 0 || end == at) {
            throw new SQLException("unreadable document field: " + key);
        }
        try {
            return Long.parseLong(json.substring(at, end));
        } catch (NumberFormatException invalid) {
            throw new SQLException("unreadable document field: " + key);
        }
    }
}
