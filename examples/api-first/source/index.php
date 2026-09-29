<?php
declare(strict_types=1);

/**
 * Router served by the PHP built-in server:
 *   php -S 127.0.0.1:8310 -t . index.php    (cwd = this directory)
 *
 * Route rules, spelled identically in the Java target (ProfileController.java):
 *   GET  /api/profile -> 200 {"email":"user@example.test","name":"Example User"}
 *   PUT  /api/customer -> valid email:   200 {"status":"saved","email":"<echoed unchanged>"}
 *                          invalid email: 422 {"error":"invalid email"}
 *   any other method on the known paths -> 405 {"error":"method not allowed"}
 *   any other path                       -> 404 {"error":"not found"}
 *   TRACE (any path)                     -> 405 with an empty body: the target's HTTP
 *                                           container refuses TRACE before it ever
 *                                           reaches the controller, and the PHP side
 *                                           mirrors that refusal here.
 * The email rule: a string matching /^[^@\s]+@[^@\s]+\.[^@\s]+$/. No other fields
 * are read or written, and there is no persistence side effect between runs.
 */

require __DIR__ . '/validation.php';

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
    respond(200, profileBody());
}

if ($path === '/api/customer') {
    if ($method !== 'PUT') {
        respond(405, ['error' => 'method not allowed']);
    }
    $raw = file_get_contents('php://input');
    $outcome = saveOutcome(validCustomerEmail($raw === false ? '' : $raw));
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
