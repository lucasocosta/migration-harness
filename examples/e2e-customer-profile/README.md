# Customer Profile E2E fixture

Historical v0.2 fixture. The `scripts/e2e-fixture.sh` command now runs the real Angular/React pilot in `examples/angular-react-pilot`. The Python recorder and these pages are retained as historical reference, not as the current sanitization or validation implementation.

This fixture validates the Migration Harness differential-execution core without requiring Angular/React package installation.

- `source.html` represents the observable behavior of the Angular source.
- `target.html` represents the behavior-preserving React candidate.
- `target-regression.html` injects an intentional `PUT -> POST` migration regression.

The browser execution is real (Chromium + Playwright). The framework runtime itself is intentionally not part of this offline fixture; framework-specific integration remains an adapter concern.
