<?php
declare(strict_types=1);

/**
 * Router served by the PHP built-in server:
 *   php -S 127.0.0.1:8310 -t . index.php    (cwd = this directory)
 *
 * Route rules, spelled identically in the Java target (ProfileController.java):
 *   GET  /api/profile -> 200 {"email":...,"name":...} from the PERSISTED customer row
 *                        (the seeded baseline answers the fixed profile until a save)
 *   PUT  /api/customer -> valid email:   200 {"status":"saved","email":"<echoed unchanged>"}
 *                             and, atomically, one customer write + one audit record
 *                          invalid email: 422 {"error":"invalid email"}, store untouched
 *                          declared fault: 500 {"error":"injected failure"}, full rollback
 *   any other method on the known paths -> 405 {"error":"method not allowed"}
 *   any other path                       -> 404 {"error":"not found"}
 *   TRACE (any path)                     -> 405 with an empty body: the target's HTTP
 *                                           container refuses TRACE before it ever
 *                                           reaches the controller, and the PHP side
 *                                           mirrors that refusal here.
 * The email rule: a string matching /^[^@\s]+@[^@\s]+\.[^@\s]+$/. Only `email` is read as
 * domain input; `faultPhase` is the declared fixture control of store.php (see below).
 *
 * Startup opens the SQLite store (store.php): schema plus the synthetic baseline when the
 * store is empty, so a fresh process reads and writes the same domain state as the target.
 * Declared fault injection: header `X-Fault-Phase: audit` or JSON field `"faultPhase":"audit"`
 * makes the audit write fail after the customer write began; the transaction rolls back and
 * the answer is 500 {"error":"injected failure"} with no partial state.
 */

require __DIR__ . '/validation.php';
require __DIR__ . '/store.php';

// Serve-time bootstrap: schema + synthetic baseline (fixtureKey sentinel), both sides alike.
storeBootstrap();

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'TRACE') {
    http_response_code(405);
    exit;
}

if ($path === '/api/profile') {
    if ($method !== 'GET') {
        respond(405, ['error' => 'method not allowed']);
    }
    respond(200, storeReadProfile());
}

if ($path === '/api/customer') {
    if ($method !== 'PUT') {
        respond(405, ['error' => 'method not allowed']);
    }
    $raw = file_get_contents('php://input');
    $outcome = storeSaveRequest($raw === false ? '' : $raw, $_SERVER['HTTP_X_FAULT_PHASE'] ?? null);
    respond($outcome['status'], $outcome['body']);
}

respond(404, ['error' => 'not found']);

/** Emit one JSON response and stop. Key order comes from the caller's array order. */
function respond(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}
