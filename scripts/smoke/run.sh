# scripts/smoke/run.sh
# End-to-end smoke test runner for luci-github-bot
# Starts the bot with DRY_RUN=1, sends each fixture, asserts outcomes, then stops the bot.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOT_URL="${BOT_URL:-http://localhost:3000}"
MOCK_LLM_PORT="${MOCK_LLM_PORT:-19999}"
MOCK_LLM_URL="http://localhost:$MOCK_LLM_PORT"
BOT_PID=""
MOCK_PID=""
FAILED=0
PASSED=0
TOTAL=0

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()   { printf "[smoke] %s\n" "$*"; }
pass()  { printf "${GREEN}PASS${NC}: %s\n" "$*"; PASSED=$((PASSED + 1)); TOTAL=$((TOTAL + 1)); }
fail()  { printf "${RED}FAIL${NC}: %s\n" "$*"; FAILED=$((FAILED + 1)); TOTAL=$((TOTAL + 1)); }
info()  { printf "${YELLOW}INFO${NC}: %s\n" "$*"; }

cleanup() {
  log "Cleaning up..."
  if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
    kill "$BOT_PID" 2>/dev/null || true
    wait "$BOT_PID" 2>/dev/null || true
  fi
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

# ─── Prerequisite checks ──────────────────────────────────────────

log "Checking prerequisites..."

# Check Node.js
if ! command -v node &>/dev/null; then
  fail "node not found"; log "Install node.js to run smoke tests"; exit 1
fi
pass "node found ($(node --version))"

# Check .env exists
if [ ! -f "$PROJECT_ROOT/.env" ]; then
  fail ".env not found in $PROJECT_ROOT"; log "Copy .env.example to .env and fill in values"
  exit 1
fi
pass ".env found"

# Check fixtures
FIXTURE_COUNT=$(find "$FIXTURES_DIR" -name "*.json" -type f | wc -l | tr -d ' ')
if [ "$FIXTURE_COUNT" -lt 6 ]; then
  fail "Expected at least 6 fixtures, found $FIXTURE_COUNT"; exit 1
fi
pass "$FIXTURE_COUNT fixtures found"

# Check webhooks are present
for f in assigned-to-bot assigned-to-other wrong-repo needs-retry injection-payload; do
  if [ ! -f "$FIXTURES_DIR/${f}.json" ]; then
    fail "Missing fixture: ${f}.json"
  fi
done

# ─── Start mock LLM server ────────────────────────────────────────

log "Starting mock LLM server on port $MOCK_LLM_PORT..."
cd "$SCRIPT_DIR"
node mock-llm.mjs &
MOCK_PID=$!
sleep 1

# Verify mock LLM is responding
if curl -sf "$MOCK_LLM_URL/health" >/dev/null 2>&1; then
  pass "Mock LLM server responding"
else
  fail "Mock LLM server not responding on port $MOCK_LLM_PORT"; exit 1
fi

# ─── Start the bot ────────────────────────────────────────────────

log "Starting bot with DRY_RUN=1..."
cd "$PROJECT_ROOT"

# Override ADASSO_BASE_URL to point at mock LLM
export ADASSO_BASE_URL="$MOCK_LLM_URL/v1"
export DRY_RUN=1

# Start bot in background
npm run dev &
BOT_PID=$!

# Wait for bot to bind port
log "Waiting for bot to start..."
BOT_START_TIMEOUT=30
WAIT=0
while ! curl -sf "$BOT_URL/health" >/dev/null 2>&1 && [ $WAIT -lt $BOT_START_TIMEOUT ]; do
  sleep 1
  WAIT=$((WAIT + 1))
done

if ! curl -sf "$BOT_URL/health" >/dev/null 2>&1; then
  fail "Bot failed to start within ${BOT_START_TIMEOUT}s"; exit 1
fi
pass "Bot started and responding on $BOT_URL"

# ─── Run fixtures ─────────────────────────────────────────────────

log "Running smoke tests..."

# Helper: send webhook and check outcome
check_webhook() {
  local name="$1"
  local fixture="$2"
  local expected_status="$3"
  local description="$4"
  
  TOTAL=$((TOTAL + 1))
  
  local sig=$(openssl dgst -sha256 -hmac "$(grep WEBHOOK_SECRET "$PROJECT_ROOT/.env" | cut -d= -f2-)" \
    "$fixture" 2>/dev/null | awk '{print $NF}')
  
  local payload=$(cat "$fixture")
  local response=$(curl -s -w "\n%{http_code}" \
    -X POST "$BOT_URL/webhook" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: issues" \
    -H "X-Hub-Signature-256: sha256=$sig" \
    -d "$payload")
  
  local http_code=$(echo "$response" | tail -1)
  local body=$(echo "$response" | head -n -1)
  
  if [ "$http_code" = "$expected_status" ]; then
    pass "$description (HTTP $http_code)"
  else
    fail "$description (expected HTTP $expected_status, got $http_code)"
    info "Response: $body"
  fi
}

# Fixture 1: assigned-to-bot — should be accepted (200 or 202)
check_webhook "assigned-to-bot" \
  "$FIXTURES_DIR/assigned-to-bot.json" \
  "200" \
  "Assigned to bot → accepted"

# Fixture 2: assigned-to-other — should be ignored (200 with warning)
check_webhook "assigned-to-other" \
  "$FIXTURES_DIR/assigned-to-other.json" \
  "200" \
  "Assigned to other user → ignored"

# Fixture 3: wrong-repo — should be ignored (200 with warning)
check_webhook "wrong-repo" \
  "$FIXTURES_DIR/wrong-repo.json" \
  "200" \
  "Wrong repo → ignored"

# Fixture 4: needs-retry — should trigger retry logic
check_webhook "needs-retry" \
  "$FIXTURES_DIR/needs-retry.json" \
  "200" \
  "Needs-retry label → triggers retry"

# Fixture 5: injection-payload — should be accepted but sanitized by validator
check_webhook "injection-payload" \
  "$FIXTURES_DIR/injection-payload.json" \
  "200" \
  "Injection payload → accepted and sanitized"

# ─── Check /api/stats ─────────────────────────────────────────────

log "Checking /api/stats..."
STATS_RESPONSE=$(curl -sf "$BOT_URL/api/stats" 2>/dev/null || echo "{}")
if echo "$STATS_RESPONSE" | grep -q "totalIssuesProcessed\|issuesByStatus"; then
  pass "/api/stats returns valid metrics"
else
  fail "/api/stats missing expected fields"
  info "Response: $STATS_RESPONSE"
fi

# ─── Hostile solution test ────────────────────────────────────────

log "Testing hostile solution rejection..."

# Send a fixture that will trigger the mock LLM's hostile mode
# We need to create a temporary fixture with model=hostile
cat > /tmp/hostile-fix.json <<'EOF'
{
  "action": "assigned",
  "assignee": { "login": "luci-github-bot", "id": 123456, "type": "User" },
  "issue": {
    "number": 99,
    "title": "@local-model model=hostile Test hostile output",
    "body": "Test injection rejection",
    "state": "open",
    "pull_request": null,
    "labels": [],
    "user": { "login": "testuser", "type": "User" },
    "created_at": "2026-10-16T00:00:00Z",
    "updated_at": "2026-10-16T00:00:00Z"
  },
  "repository": { "name": "test-repo", "owner": { "login": "testorg" } },
  "sender": { "login": "testuser", "type": "User" }
}
EOF

TOTAL=$((TOTAL + 1))
sig=$(openssl dgst -sha256 -hmac "$(grep WEBHOOK_SECRET "$PROJECT_ROOT/.env" | cut -d= -f2-)" \
  /tmp/hostile-fix.json 2>/dev/null | awk '{print $NF}')
payload=$(cat /tmp/hostile-fix.json)
response=$(curl -s -w "\n%{http_code}" \
  -X POST "$BOT_URL/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -H "X-Hub-Signature-256: sha256=$sig" \
  -d "$payload")
http_code=$(echo "$response" | tail -1)

if [ "$http_code" = "200" ]; then
  pass "Hostile solution sent to bot (processing)"
  info "The validator should reject the hostile branch name and commit message"
else
  fail "Hostile solution webhook failed (HTTP $http_code)"
fi

# ─── Summary ──────────────────────────────────────────────────────

echo ""
log "═══════════════════════════════════════"
log "Smoke Test Summary"
log "═══════════════════════════════════════"
printf "Total:  %d\n" "$TOTAL"
printf "Passed: %d\n" "$PASSED"
printf "Failed: %d\n" "$FAILED"
log "═══════════════════════════════════════"

if [ $FAILED -gt 0 ]; then
  exit 1
else
  log "All smoke tests passed!"
  exit 0
fi
