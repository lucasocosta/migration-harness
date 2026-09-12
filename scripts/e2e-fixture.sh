#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v pnpm >/dev/null 2>&1; then
  pnpm build
else
  npx --yes pnpm@10.15.0 build
fi
node scripts/pilot.mjs
