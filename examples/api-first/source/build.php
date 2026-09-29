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
$runtimeFiles = ['index.php', 'validation.php', 'store.php'];

/** Every PHP file of the source project, except disposable build/runtime output. */
function phpFilesOf(string $directory, string $root): array
{
    $found = [];
    $entries = scandir($directory);
    if ($entries === false) {
        return $found;
    }
    sort($entries);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..' || $entry === 'data') {
            continue;
        }
        $path = $directory . '/' . $entry;
        if (is_dir($path)) {
            if ($entry === 'dist') {
                continue;
            }
            $found = array_merge($found, phpFilesOf($path, $root));
            continue;
        }
        if (str_ends_with($entry, '.php')) {
            $found[] = substr($path, strlen($root) + 1);
        }
    }
    return $found;
}

$phpFiles = phpFilesOf($root, $root);

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
    $target = str_contains($file, '/') ? $dist . '/' . $file : $dist . '/' . basename($file);
    $directory = dirname($target);
    if (!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) {
        fwrite(STDERR, "build failed: cannot create " . dirname($file) . "/ inside dist/\n");
        exit(1);
    }
    if (!copy($root . '/' . $file, $target)) {
        fwrite(STDERR, "build failed: cannot copy {$file} into dist/\n");
        exit(1);
    }
}

fwrite(STDOUT, 'build ok: dist/' . implode(', dist/', $runtimeFiles) . "\n");
exit(0);
