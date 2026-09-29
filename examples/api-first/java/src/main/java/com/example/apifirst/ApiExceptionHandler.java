package com.example.apifirst;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Route-level error rules of the target side, spelled identically to the PHP router
 * (examples/api-first/source/index.php). This is advice, not a second controller:
 * the two endpoints stay in the single ProfileController.
 *
 *   unknown path        -> 404 {"error":"not found"}
 *   wrong method        -> 405 {"error":"method not allowed"}
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    /** Unknown path (nothing matched, not even a static resource): 404, exactly like index.php. */
    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class})
    public ResponseEntity<Map<String, String>> notFound() {
        return error(HttpStatus.NOT_FOUND, "not found");
    }

    /** Any method mismatch that reaches the dispatcher: 405, exactly like index.php. */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Map<String, String>> methodNotAllowed() {
        return error(HttpStatus.METHOD_NOT_ALLOWED, "method not allowed");
    }

    private static ResponseEntity<Map<String, String>> error(HttpStatus status, String message) {
        LinkedHashMap<String, String> body = new LinkedHashMap<>();
        body.put("error", message);
        return ResponseEntity.status(status).body(body);
    }
}
