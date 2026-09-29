package com.example.apifirst;

/**
 * State probe of the target side (migration.json: kind "probe", argv
 * ["java","-cp","target/classes","com.example.apifirst.StateProbe"]).
 *
 * Prints ONE canonical JSON domain projection to stdout and exits 0, for example:
 *
 *   {"_settle":"complete","audit":{"count":1},"customers":[{"email":"...","fixtureKey":"default","name":"..."}]}
 *
 * Keys are sorted at every level, only declared domain fields appear (no SQL, no paths, no
 * credentials), and {@code _settle} is the declared completion marker the harness's
 * PROBE_BARRIER polls. The command returns observation, never a verdict; exit 0 means it ran,
 * not that any comparison passed. The probe is read-only: it never writes domain data, and a
 * missing or unreadable store is an error (exit 1), never an invented "empty" projection.
 *
 * The PHP source prints the identical projection from evaluation/state-probe.php (relational
 * SQLite store), so the two outputs are diffable byte for byte.
 */
public final class StateProbe {

    public static void main(String[] args) {
        int exit = 0;
        try {
            System.out.println(CustomerStore.probeProjection(CustomerStore.DEFAULT_DB));
        } catch (Exception failure) {
            System.err.println("state probe: " + failure);
            exit = 1;
        }
        System.out.flush();
        // Explicit: an embedded H2 observer must never keep the JVM alive past its own output.
        System.exit(exit);
    }

    private StateProbe() {
    }
}
