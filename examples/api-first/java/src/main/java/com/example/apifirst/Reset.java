package com.example.apifirst;

/**
 * Reset command of the target side (migration.json: reset kind COMMANDS, argv
 * ["java","-cp","target/classes","com.example.apifirst.Reset"]).
 *
 * Drops and recreates the H2 document schema, then seeds the identical synthetic baseline the
 * PHP side seeds (fixtureKey sentinel customer + audit count 0), so every independent run
 * starts from an equivalent initial domain state on both sides. Exit 0 on success.
 */
public final class Reset {

    public static void main(String[] args) {
        int exit = 0;
        try {
            CustomerStore.reset(CustomerStore.DEFAULT_DB);
            System.out.println("reset ok: " + CustomerStore.DEFAULT_DB);
        } catch (Exception failure) {
            System.err.println("reset failed: " + failure);
            exit = 1;
        }
        System.out.flush();
        // Explicit exit: an embedded H2 store must never outlive the reset command itself.
        System.exit(exit);
    }

    private Reset() {
    }
}
