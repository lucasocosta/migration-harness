#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p node_modules/@migration-harness
ln -sfn ../../packages/core node_modules/@migration-harness/core
ln -sfn ../../packages/equivalence-validator node_modules/@migration-harness/equivalence-validator

tsc -b packages/core packages/equivalence-validator --pretty false
python scripts/e2e_browser.py

node scripts/validate-e2e.mjs \
  artifacts/e2e-customer-profile/source.sanitized.json \
  artifacts/e2e-customer-profile/target.sanitized.json \
  artifacts/e2e-customer-profile/equivalent.result.json

set +e
node scripts/validate-e2e.mjs \
  artifacts/e2e-customer-profile/source.sanitized.json \
  artifacts/e2e-customer-profile/target-regression.sanitized.json \
  artifacts/e2e-customer-profile/regression.result.json
regression_exit=$?
set -e

if [[ "$regression_exit" -ne 4 ]]; then
  echo "Expected regression comparison to exit 4, got $regression_exit" >&2
  exit 20
fi

grep -q 'NETWORK_METHOD_MISMATCH' artifacts/e2e-customer-profile/regression.result.json

echo "E2E fixture: PASS"
