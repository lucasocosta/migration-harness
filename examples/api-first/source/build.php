<?php
declare(strict_types=1);

/**
 * Build command of the source side (migration.json: argv ["php","build.php"]).
 *
 * Tiny by design: lint every PHP file with `php -l`, then stage the runtime files
 * into dist/ (migration.json: build.outputDir "dist", cleanOutput true).
 * dist/ is disposable managed output; the serve command runs from this directory
 * with index.php as the router, so nothing at runtime depends on dist/.
 */

$root = __DIR__;
$phpFiles = ['index.php', 'validation.php', 'build.php', 'tests/validation-test.php'];
$runtimeFiles = ['index.php', 'validation.php'];

$failed = false;
foreach ($phpFiles as $file) {
    $path = $root . '/' . $file;
    if (!is_file($path)) {
        fwrite(STDERR, "missing file: {$file}\n");
        $failed = true;
        continue;
    }
    $output = [];
    $code = 0;
    exec(escapeshellarg(PHP_BINARY) . ' -l ' . escapeshellarg($path), $output, $code);
    if ($code !== 0) {
        fwrite(STDERR, implode("\n", $output) . "\n");
        $failed = true;
        continue;
    }
    fwrite(STDOUT, $output[count($output) - 1] . "\n");
}

if ($failed) {
    fwrite(STDERR, "build failed: php -l reported errors\n");
    exit(1);
}

$dist = $root . '/dist';
if (!is_dir($dist) && !mkdir($dist, 0777, true) && !is_dir($dist)) {
    fwrite(STDERR, "build failed: cannot create dist/\n");
    exit(1);
}
foreach ($runtimeFiles as $file) {
    if (!copy($root . '/' . $file, $dist . '/' . $file)) {
        fwrite(STDERR, "build failed: cannot copy {$file} into dist/\n");
        exit(1);
    }
}

fwrite(STDOUT, 'build ok: dist/' . implode(', dist/', $runtimeFiles) . "\n");
exit(0);
