<?php
declare(strict_types=1);

/**
 * Reset command of the source side (migration.json: reset kind COMMANDS, argv ["php","reset.php"]).
 *
 * Drops and recreates the SQLite schema, then seeds the identical synthetic baseline the
 * Java side seeds (fixtureKey sentinel customer + empty audit), so every independent run
 * starts from an equivalent initial domain state on both sides. Exit 0 on success.
 */

require __DIR__ . '/store.php';

$path = storePath();
try {
    storeReset($path);
} catch (Throwable $failure) {
    fwrite(STDERR, 'reset failed: ' . $failure->getMessage() . "\n");
    exit(1);
}

fwrite(STDOUT, "reset ok: {$path}\n");
exit(0);
