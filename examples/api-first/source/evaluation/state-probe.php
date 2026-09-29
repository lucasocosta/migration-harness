<?php
declare(strict_types=1);

/**
 * State probe of the source side (migration.json: kind COMMANDS probe, argv
 * ["php","evaluation/state-probe.php"]).
 *
 * Prints ONE canonical JSON domain projection to stdout and exits 0, for example:
 *
 *   {"_settle":"complete","audit":{"count":1},"customers":[{"email":"...","fixtureKey":"default","name":"..."}]}
 *
 * Keys are sorted at every level, only declared domain fields appear (no SQL, no paths, no
 * credentials), and `_settle` is the declared completion marker the harness's PROBE_BARRIER
 * polls. The command returns observation, never a verdict; exit 0 means it ran, not that
 * any comparison passed. The probe is read-only: it never writes domain data, and a missing
 * or unreadable store is an error (exit 1), never an invented "empty" projection.
 *
 * The Java target prints the identical projection from
 * java -cp target/classes com.example.apifirst.StateProbe (document store in H2), so the two
 * outputs are diffable byte for byte.
 */

require __DIR__ . '/../store.php';

$path = storePath();
if (!is_file($path)) {
    fwrite(STDERR, "state probe: store is missing (run the reset-db command first): {$path}\n");
    exit(1);
}

try {
    $projection = storeProjection($path);
    $json = json_encode($projection, JSON_UNESCAPED_SLASHES);
} catch (Throwable $failure) {
    fwrite(STDERR, 'state probe: ' . $failure->getMessage() . "\n");
    exit(1);
}

if ($json === false) {
    fwrite(STDERR, "state probe: projection is not encodable JSON\n");
    exit(1);
}

fwrite(STDOUT, $json . "\n");
exit(0);
