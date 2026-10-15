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

## LLM Modes

| Mode | Trigger | Model | Strategy |
|---|---|---|---|
| Remote | Default | 35B+ (cloud) | Single-shot prompt |
| Local | `@local-model` in issue body | 7B-8B (Ollama) | 2-phase decomposition |

### Local Model Pipeline (2-Phase)

When an issue body contains `@local-model`, the bot switches to the local Ollama instance:

**Phase 1 — Decomposition:** The 7B model breaks the issue into independent subtasks (JSON), each specifying target files and dependencies.

**Phase 2 — Execution:** Subtasks run in parallel (where possible), each getting the full current file content for context.

**Conflict resolution:** Last-writer-wins for same-file edits; partial failures produce error reports rather than total aborts.

This "divide and conquer" makes a 7B model as robust as a larger model on code tasks.

## Trigger

The bot responds to the **`assigned`** action only. When you assign an issue to the bot user, it automatically begins processing.

```
@local-model add rate limiting to the webhook handler
```

The `@local-model` prefix activates the decomposition pipeline instead of the remote model.

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `GITHUB_TOKEN` | PAT with `repo` scope | — |
| `ADASSO_BASE_URL` | LLM API base URL | `https://adesso-ai-hub.3asabc.de/v1` |
| `ADASSO_API_KEY_FILE` | Path to API key file | `~/.config/opencode/adesso.key` |
| `ADASSO_MODEL` | Remote model name | `qwen-3.6-35b-sovereign` |
| `NGROK_AUTHTOKEN` | ngrok auth token | — |
| `LISTEN_PORT` | HTTP listen port | `3000` |
| `WEBHOOK_SECRET` | HMAC secret for signature verification | — |
| `MONITORED_REPOS` | Comma-separated `owner/repo` list | `luci/luci-bot` |
| `CONTAINER_RUNTIME` | `podman` or `docker` | `podman` |
| `OLLAMA_BASE_URL` | Local Ollama endpoint | `http://localhost:11434` |
| `OLLAMA_MODEL` | Local model name | `qwen3:8b` |
| `MAX_CONCURRENT_WORKERS` | Max simultaneous containers | `1` |
| `WORKER_TIMEOUT_MS` | Per-issue container timeout | `600000` (10 min) |
| `MEMORY_PRESSURE_MAX` / `CPU_MAX` | Resource thresholds for dynamic slot scaling | `85` / `90` |

The bot user is auto-detected from the first repo's owner or via `GITHUB_BOT_USERNAME`.

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/webhook` | POST | GitHub webhook receiver (verified via HMAC) |
| `/health` | GET | Health + resource capacity |
| `/api/stats` | GET | Full metrics snapshot |
| `/api/activity` | GET | Recent activity log (query: `?limit=N`) |

### Health Response

```json
{
  "status": "ok",
  "timestamp": "2026-10-15T22:37:18.233Z",
  "capacity": { "available": 1, "max": 1, "full": false },
  "resources": {
    "cpuUsagePercent": 20.58,
    "memoryUsedPercent": 0,
    "capacity": 0.77
  }
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
├── index.ts          # Entry point, ngrok tunnel, server startup
├── webhook.ts        # Express app, webhook receiver, HMAC verification
├── issue-handler.ts  # Issue routing, LLM dispatch, container lifecycle
├── llm.ts            # LLM integration (remote single-shot + local decomposition)
├── docker-worker.ts  # Container runtime (Podman/Docker), dynamic semaphore
├── resource-monitor.ts # macOS CPU/memory polling → capacity signal
├── metrics.ts        # In-memory metrics collector
├── config.ts         # Schema (Zod) + env parsing
└── types.ts          # Shared type definitions

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

### Error Handling

- LLM failures → issue labeled `blocked`, comment with error details
- Worker failures (clone, push, PR creation) → issue labeled `blocked`
- Retries → label the issue `needs-retry` and comment to reprocess

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
```

## License

MIT
