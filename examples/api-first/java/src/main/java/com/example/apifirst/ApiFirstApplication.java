package com.example.apifirst;

import jakarta.annotation.PostConstruct;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Spring Boot entry point of the P7 pilot target API.
 *
 * Serve-time bootstrap mirrors storeBootstrap() in the PHP router (source/index.php): before
 * the web server accepts a request, the embedded H2 store gets its schema and, when the store
 * is empty, the identical synthetic baseline (fixtureKey sentinel customer + audit count 0).
 * A store that cannot be opened fails startup instead of serving an application with no store.
 */
@SpringBootApplication
public class ApiFirstApplication {

    public static void main(String[] args) {
        SpringApplication.run(ApiFirstApplication.class, args);
    }

    @PostConstruct
    void bootstrapStore() {
        try {
            CustomerStore.bootstrap();
        } catch (Exception failure) {
            throw new IllegalStateException("store bootstrap failed", failure);
        }
    }
}
