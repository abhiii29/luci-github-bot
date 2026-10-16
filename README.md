# luci-github-bot

A self-hosted GitHub bot that turns assigned issues into pull requests — automatically.

It receives issue webhooks, uses an LLM to generate code changes, executes them in isolated containers, and opens a PR. Supports both cloud-hosted (35B+) and local (7B) models, with task decomposition for smaller models.

## Quick Start

```bash
cp .env.example .env
# edit .env with your tokens
npm install
npm run dev          # development (tsx, hot-reload)
# or
npm run build && npm start   # production
```

The startup script (`bin/start-bot.sh`) also manages the podman machine lifecycle.

## What It Does

1. **Listens** for `issues.assigned` webhooks on configured repos
2. **Generates** code changes via LLM (cloud or local)
3. **Executes** changes in isolated containers (podman/docker)
4. **Creates** a branch, commits, pushes, and opens a PR

```
[GitHub Webhook] ──assigned──► [luci-github-bot]
                                      │
                          ┌───────────┴───────────┐
                          ▼                       ▼
                     [LLM]                 [Docker/Podman]
                generate solution      spawn worker container
                          │                       │
                          ▼                       ▼
                   [Code Generation]  [clone → modify → commit → push → PR]
                                      │
                                      ▼
                              [PR on GitHub]
```

## Trigger Rules

The bot responds to the **`issues.assigned`** webhook event only. It processes an event when:

- The assignee matches the bot user (auto-detected from the first monitored repo's owner, or via `GITHUB_BOT_USERNAME`)

It ignores events when:

- The event `sender` is the bot user itself (prevents loops)
- The issue is closed
- The issue is actually a PR (`issue.pull_request` is set)
- The issue has the `bot:no-run` label

If you label an issue `needs-retry`, the bot will reprocess it.

### Per-Issue Directives

You can add a `/luci` block anywhere in the issue body (or `@local-model` at the start of the title) to control execution:

```
/luci model=local base=develop plan-only dry-run
```

| Key | Values | Description |
|---|---|---|
| `model` | `local` or `remote` | Which LLM pipeline to use |
| `base` | `<branch>` | Base branch for the PR |
| `files` | `glob,glob` | Hint/limit to specific files |
| `plan-only` | (flag) | Generate plan but don't execute |
| `dry-run` | (flag) | Print changes, don't push or open PR |
| `no-pr` | (flag) | Commit but don't open PR |

Unknown keys generate warnings but are not fatal. Directives can only narrow what the bot does — they cannot lift per-repo deny rules.

Directives are only honoured when the issue author or assigner is a repo collaborator or owner (checked via the GitHub API).

### Per-Repo Configuration

Place a `.luci-bot.yml` file in the repo's root. Loaded once and cached for 5 minutes:

| Key | Type | Description |
|---|---|---|
| `model` | `string` | Override default model |
| `baseBranch` | `string` | Override default base branch |
| `allowedPaths` | `string[]` | Glob patterns of allowed files |
| `deniedPaths` | `string[]` | Glob patterns of denied files |
| `maxFiles` | `number` | Max files per subtask |
| `labels` | `string[]` | Labels to attach |
| `reviewers` | `string[]` | PR reviewers |

An invalid `.luci-bot.yml` is ignored with a warning; defaults apply.

## LLM Modes

| Mode | Trigger | Model | Strategy |
|---|---|---|---|
| Remote | Default | 35B+ (cloud) | Single-shot prompt |
| Local | `@local-model` prefix or `model=local` | 7B-8B (Ollama) | 2-phase decomposition |

### Local Model Pipeline (2-Phase)

When the `@local-model` prefix is used, the bot switches to the local Ollama instance:

**Phase 1 — Decomposition:** The 7B model breaks the issue into independent subtasks (JSON), each specifying target files and dependencies. The output is validated for cycle-free dependencies, duplicate IDs, and size limits.

**Phase 2 — Execution:** Subtasks run in parallel (up to 2 concurrent by default, since Ollama is the bottleneck), each getting current file content for context. Failed subtasks get a retry with a repair prompt.

**Conflict resolution:** Last-writer-wins for same-file edits. Partial failures produce error reports rather than total aborts.

This "divide and conquer" approach improves reliability on smaller models.

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `GITHUB_TOKEN` | PAT with `repo` scope | — |
| `ADASSO_BASE_URL` | LLM API base URL | `https://adesso-ai-hub.3asabc.de/v1` |
| `ADASSO_API_KEY_FILE` | Path to API key file | `~/.config/opencode/adesso.key` |
| `ADASSO_MODEL` | Remote model name | `qwen-3.6-35b-sovereign` |
| `NGROK_AUTHTOKEN` | ngrok auth token (for public URL) | — |
| `LISTEN_PORT` | HTTP listen port | `3000` |
| `WEBHOOK_SECRET` | HMAC secret for signature verification (min 16 chars) | — |
| `MONITORED_REPOS` | Comma-separated `owner/repo` list | `luci/luci-bot` |
| `CONTAINER_RUNTIME` | `podman` or `docker` | `podman` |
| `OLLAMA_BASE_URL` | Local Ollama endpoint | `http://localhost:11434` |
| `OLLAMA_MODEL` | Local model name | `qwen3:8b` |
| `OLLAMA_DECOMPOSITION_TIMEOUT_MS` | Phase 1 timeout | `300000` (5 min) |
| `OLLAMA_SUBTASK_TIMEOUT_MS` | Phase 2 per-subtask timeout | `300000` (5 min) |
| `MAX_CONCURRENT_WORKERS` | Max simultaneous containers | `1` |
| `WORKER_TIMEOUT_MS` | Per-issue container timeout | `600000` (10 min) |
| `MEMORY_PRESSURE_MAX` | Memory threshold for scaling | `85` |
| `CPU_MAX` | CPU threshold for scaling | `90` |
| `RESOURCE_CHECK_INTERVAL_MS` | Resource polling interval | `10000` |
| `GIT_AUTHOR_NAME` | Git author name for PRs | `luci-github-bot` |
| `GIT_AUTHOR_EMAIL` | Git author email for PRs | `luci-github-bot@users.noreply.github.com` |
| `GITHUB_BOT_USERNAME` | Override auto-detected bot username | — |
| `API_TOKEN` | Bearer token for `/api/*` endpoints | — |
| `WEBHOOK_BODY_LIMIT` | Max webhook body size in bytes | `1048576` (1 MB) |
| `RATE_LIMIT_WINDOW_MS` | Per-IP rate limit window | `60000` (60s) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `100` |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown wait time | `30000` (30s) |
| `LOG_LEVEL` | Logger level (debug/info/warn/error) | `info` |
| `DRY_RUN` | Skip push/PR, print solution summary | `false` |

The bot user is auto-detected from the first monitored repo's owner, or overridden via `GITHUB_BOT_USERNAME`.

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | GitHub webhook receiver (HMAC verified) |
| `/health` | GET | Health + resource capacity (public) |
| `/api/*` | various | API endpoints (requires `API_TOKEN` bearer auth) |
| `/api/stats` | GET | Full metrics snapshot |
| `/api/activity` | GET | Recent activity log (`?limit=N`) |

### Health Response

```json
{
  "status": "ok",
  "timestamp": "2026-10-15T22:37:18.233Z",
  "capacity": { "available": 1, "max": 1, "full": false }
}
```

### Stats Response

```json
{
  "totalIssuesProcessed": 5,
  "issuesByStatus": { "success": 4, "failed": 1, "queued": 0, "blocked": 0 },
  "llmGenerations": {
    "total": 5, "success": 5, "failed": 0,
    "localModelUsed": 2, "remoteModelUsed": 3
  },
  "workerExecutions": { "total": 5, "success": 4, "failed": 1 },
  "recentActivity": [...],
  "uptimeSeconds": 3600,
  "startTime": "2026-10-15T21:37:18.233Z"
}
```

## Architecture

```
src/
├── index.ts          # Entry point, ngrok tunnel, server startup, shutdown
├── webhook.ts        # Express app, webhook receiver, HMAC, rate limit, auth
├── issue-handler.ts  # Issue routing, LLM dispatch, container lifecycle
├── llm.ts            # LLM integration (remote single-shot + local decomposition)
├── docker-worker.ts  # Container runtime (Podman/Docker), dynamic semaphore
├── resource-monitor.ts # macOS CPU/memory polling → capacity signal
├── metrics.ts        # In-memory metrics collector
├── config.ts         # Schema (Zod) + env parsing
├── types.ts          # Shared type definitions
├── directives.ts     # /luci directive parser, JobOptions, JobOptions validation
├── repo-config.ts    # .luci-bot.yml loader from GitHub API
├── redact.ts         # Secret masking for logs
└── logger.ts         # JSON-lines structured logger

images/
└── worker.sh         # Container entrypoint: clone → apply → commit → push → PR

bin/
└── start-bot.sh      # Podman lifecycle manager + bot launcher
```

### Worker Container

Each issue spawns an ephemeral container running `worker.sh`:

1. Authenticates with GitHub (via token in URL for clone/push)
2. Clones the target repo
3. Applies code changes (writes files, handles create/update/delete)
4. Commits and pushes to a new branch
5. Opens a PR via the GitHub API

The container is killed and removed after completion.

### Dynamic Concurrency

A macOS resource monitor polls `top` and `vm_stat` every 10 seconds. CPU/memory pressure scales available worker slots 0–10. When full, incoming issues are queued (labeled `queued`) and processed as slots free up.

### Security

- Webhook payloads are verified via HMAC-SHA256
- All secrets in logs are automatically redacted (GitHub tokens, bearer tokens, URL creds)
- `/api/*` endpoints require a Bearer token (`API_TOKEN` env var); without it, routes bind to localhost only
- Webhook body size is limited (default 1 MB)
- Per-IP rate limiting is applied to all endpoints

### Error Handling

- LLM failures → issue labeled `blocked`, comment with error details
- Worker failures (clone, push, PR creation) → issue labeled `blocked`
- Retries → label the issue `needs-retry` and comment to reprocess
- Invalid decomposition (cycles, duplicates, unknown deps) → fails fast with a descriptive error

## Development

```bash
# Build TypeScript
npm run build

# Development with hot-reload
npm run dev

# Build worker image
npm run podman:build    # or npm run docker:build

# Full pipeline
npm run build:all

# Run tests
npm test

# Run smoke tests (with mock LLM, no podman/Ollama required)
cd scripts/smoke
./run.sh
```

## Smoke Tests

A repeatable end-to-end smoke test suite is provided in `scripts/smoke/`. It:

- Starts a mock LLM server (`mock-llm.mjs`) that returns fixed responses
- Starts the bot with `DRY_RUN=1` (no push/PR)
- Sends 7 webhook fixtures covering: assigned-to-bot, assigned-to-other, wrong-repo, bad-signature, needs-retry, injection payload, and duplicate delivery
- Asserts HTTP outcomes against `/api/stats`
- Prints a pass/fail table

See `docs/SMOKE.md` for full instructions.
```

## License

MIT
