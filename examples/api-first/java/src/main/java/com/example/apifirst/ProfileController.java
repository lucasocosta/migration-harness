package com.example.apifirst;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

/**
 * The single controller of the target side; route rules are spelled identically to
 * the PHP router (examples/api-first/source/index.php):
 *
 *   GET  /api/profile -> 200 {"email":"user@example.test","name":"Example User"}
 *   PUT  /api/customer -> valid email:   200 {"status":"saved","email":"<echoed unchanged>"}
 *                          invalid email: 422 {"error":"invalid email"}
 *   any other method on the known paths -> 405 {"error":"method not allowed"}
 *   any other path                       -> 404 {"error":"not found"}
 *
 * The email rule: a string matching /^[^@\s]+@[^@\s]+\.[^@\s]+$/. No other fields are
 * read or written, and there is no persistence side effect between runs.
 */
@RestController
public class ProfileController {

    private static final ObjectMapper JSON = new ObjectMapper();

    @GetMapping("/api/profile")
    public ResponseEntity<Map<String, String>> profile() {
        return ResponseEntity.ok(ApiSemantics.profileBody());
    }

    @PutMapping("/api/customer")
    public ResponseEntity<Map<String, String>> saveCustomer(HttpServletRequest request) throws IOException {
        String raw = new String(request.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        return customerResponse(raw);
    }

    /** Wrong methods on /api/profile: 405, exactly like the PHP router. */
    @RequestMapping(value = "/api/profile", method = {
            RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE,
            RequestMethod.HEAD, RequestMethod.OPTIONS})
    public ResponseEntity<Map<String, String>> profileMethodNotAllowed() {
        return error(HttpStatus.METHOD_NOT_ALLOWED, "method not allowed");
    }

    /** Wrong methods on /api/customer: 405, exactly like the PHP router. */
    @RequestMapping(value = "/api/customer", method = {
            RequestMethod.GET, RequestMethod.POST, RequestMethod.PATCH, RequestMethod.DELETE,
            RequestMethod.HEAD, RequestMethod.OPTIONS})
    public ResponseEntity<Map<String, String>> customerMethodNotAllowed() {
        return error(HttpStatus.METHOD_NOT_ALLOWED, "method not allowed");
    }

    /**
     * One PUT /api/customer body -> response, shared with the regression main.
     * The raw body is parsed here so malformed JSON behaves like the PHP side: it is
     * simply not a JSON object carrying a valid string email, hence 422.
     */
    ResponseEntity<Map<String, String>> customerResponse(String raw) {
        ApiSemantics.Outcome outcome = ApiSemantics.saveOutcome(extractEmail(raw));
        return ResponseEntity.status(outcome.status()).body(outcome.body());
    }

    /** Raw body -> echoed email, or null (malformed JSON, missing field, non-string field). */
    static String extractEmail(String raw) {
        JsonNode node;
        try {
            node = JSON.readTree(raw == null ? "" : raw);
        } catch (JsonProcessingException | IllegalArgumentException e) {
            return null;
        }
        if (node == null || node.isMissingNode() || !node.isObject()) {
            return null;
        }
        JsonNode email = node.get("email");
        if (email == null || !email.isTextual()) {
            return null;
        }
        return email.textValue();
    }

    /** Route-level 404/405 error bodies live in ApiExceptionHandler (advice). */

    private static ResponseEntity<Map<String, String>> error(HttpStatus status, String message) {
        LinkedHashMap<String, String> body = new LinkedHashMap<>();
        body.put("error", message);
        return ResponseEntity.status(status).body(body);
    }
}
