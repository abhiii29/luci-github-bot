#!/usr/bin/env bash
# scripts/smoke/send-webhook.sh
# Usage: send-webhook.sh <event.json>
# Signs a fixture payload with HMAC-SHA256 and POSTs it to the local bot.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <event.json>" >&2
  exit 1
fi

EVENT_FILE="$1"
BOT_URL="${BOT_URL:-http://localhost:3000}"
SECRET="${WEBHOOK_SECRET:-test-secret-minimum16chars}"

if [ ! -f "$EVENT_FILE" ]; then
  echo "Error: $EVENT_FILE not found" >&2
  exit 1
fi

# Never echo the secret
PAYLOAD=$(cat "$EVENT_FILE")
SIGNATURE=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" 2>/dev/null | awk '{print $NF}')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$BOT_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -H "X-Hub-Signature-256: sha256=$SIGNATURE" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

echo "HTTP $HTTP_CODE — $BODY"
exit 0
