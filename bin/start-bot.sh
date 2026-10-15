#!/usr/bin/env bash
set -euo pipefail

# ─── luci-github-bot auto-start ───────────────────────────────────
# Manages podman lifecycle: starts machine if needed, runs bot,
# stops machine on exit. Use `podman machine stop` to skip future
# starts until the next invocation.
# ──────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_START_TIMEOUT=30      # seconds to wait for bot to bind port
BOT_PORT="${BOT_PORT:-3000}"

# ─── helpers ───────────────────────────────────────────────────────

log()   { printf '[bot] %s\n' "$*"; }
warn()  { printf '[bot] WARN: %s\n' "$*" >&2; }
info()  { printf '\e[34m[bot]\e[0m %s\n' "$*"; }
ok()    { printf '\e[32m[bot]\e[0m %s\n' "$*"; }
fail()  { printf '\e[31m[bot] ERR: %s\n' "$*" >&2; exit 1; }

# ─── preflight ─────────────────────────────────────────────────────

# Check .env
if [ ! -f "$ROOT_DIR/.env" ]; then
  warn ".env not found. Copy .env.example and fill in values."
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  fail "Edit .env then re-run this script."
fi

# Check podman binary
if ! command -v podman &>/dev/null; then
  fail "podman not found. Install: brew install podman"
fi

# ─── podman lifecycle ─────────────────────────────────────────────

PODMAN_RUNNING=false
PODMAN_STARTED_US=$(false)
trap 'podman_cleanup' EXIT INT TERM

podman_cleanup() {
  if [ "$PODMAN_STARTED_US" = true ]; then
    info "Stopping podman machine…"
    podman machine stop 2>/dev/null || true
    ok "Podman machine stopped."
  fi
}

# Quick check: is the socket reachable?
if podman info &>/dev/null; then
  PODMAN_RUNNING=true
  info "Podman machine is already running."
else
  # Try to connect (lazy start)
  podman version &>/dev/null && PODMAN_RUNNING=true
fi

if [ "$PODMAN_RUNNING" = false ]; then
  info "Starting podman machine (first run downloads a ~200 MB VM)…"
  podman machine start
  # Wait for socket
  WAIT=0
  while ! podman info &>/dev/null && [ $WAIT -lt $BOT_START_TIMEOUT ]; do
    sleep 1
    WAIT=$((WAIT + 1))
  done
  if ! podman info &>/dev/null; then
    fail "Podman machine failed to start within ${BOT_START_TIMEOUT}s"
  fi
  info "Podman ready."
  PODMAN_STARTED_US=true
fi

# ─── ensure worker image ──────────────────────────────────────────

if ! podman image inspect luci-github-bot-worker &>/dev/null; then
  info "Building worker image (one-time, takes ~1-2 min)…"
  (cd "$ROOT_DIR" && podman build -t luci-github-bot-worker -f Dockerfile.worker .)
  ok "Worker image built."
fi

# ─── start the bot ────────────────────────────────────────────────

info "Starting bot on port ${BOT_PORT}…"
cd "$ROOT_DIR"

# Run npm run dev (tsx, watches for changes)
npm run dev

# When bot exits, the trap fires and stops podman
ok "Bot stopped. Podman machine will stop automatically."
