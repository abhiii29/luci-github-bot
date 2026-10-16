#!/usr/bin/env bash
# Smoke tests against real processes. Safe: never loads your .env (see the headers of each script).
#   scripts/smoke/run.sh          bot process: boot, webhook security, queue, dry-run job, shutdown
#   scripts/smoke/run.sh --worker also the container path (git daemon + stub GitHub API)
set -euo pipefail
cd "$(dirname "$0")/../.."

npx tsx scripts/smoke/smoke.ts
if [ "${1:-}" = "--worker" ]; then
  npx tsx scripts/e2e/worker-e2e.ts
fi
