# luci-github-bot

A self-hosted GitHub bot that turns assigned issues into pull requests.

Assign an issue to the bot user and it queues the work, asks an LLM for a change, validates it, applies
it in an isolated container, and opens a PR. It supports a cloud model (35B+, single-shot) and a local
Ollama model (7B–8B, with task decomposition).

## Quick Start

```bash
cp .env.example .env      # fill in GITHUB_TOKEN, WEBHOOK_SECRET, MONITORED_REPOS, ...
npm install
npm run dev               # development (tsx)
# or
npm run build && npm start
```

`bin/start-bot.sh` also starts the podman machine if needed. On startup the bot builds the worker
image, opens an ngrok tunnel (if `NGROK_AUTHTOKEN` is set), and registers the webhook on each monitored
repo for the `issues` and `issue_comment` events.

## How It Works

```
issue assigned to bot ──► webhook (HMAC, dedupe) ──► durable job queue ──► handler
                                                                             │
       repo context (relevant files) ◄───────────────────────────────────────┤
       LLM: plan or solution (remote single-shot / local decomposition) ◄────┤
       validation: paths, secrets, scope, limits ◄───────────────────────────┤
       container: clone → apply → commit → push → PR (Closes #N) ◄───────────┘
                                                                             │
                     one status comment + one bot:* label on the issue ◄─────┘
```

- **Queue:** jobs are persisted in `.luci-queue.json`, so they survive restarts. There is at most one
  open job per issue, and concurrency is capped by `MAX_CONCURRENT_WORKERS` and host load. A job
  interrupted by a restart is re-queued.
- **Retries:** failures that may be transient (an unusable model answer, a container error) are
  retried once automatically. Refusals, clarification requests and validation failures are not retried.
- **Feedback on the issue:** the bot keeps a single status comment and edits it in place. It also sets
  exactly one status label: `bot:queued`, `bot:in-progress`, `bot:awaiting-review` or `bot:blocked`.
  Your own labels are never touched.

## Triggering the Bot

| Action | Effect |
|---|---|
| Assign the issue to the bot user | Queue a job |
| Add the `needs-retry` label | Queue a new attempt |
| Comment `/luci <command>` | See [Commands](#commands) |

The bot ignores closed issues, pull requests, issues labelled `bot:no-run`, its own comments, and
assignments of other users. It can run as your own GitHub account: assigning an issue to yourself
then triggers it. The bot user is `GITHUB_BOT_USERNAME`, or the owner of the
first monitored repo if that is unset. Logins are matched case-insensitively.

### Commands

Commands are comments that start with `/luci`. Only repo collaborators can use them, and commands
inside code blocks are ignored.

| Command | Effect |
|---|---|
| `/luci retry` | Queue a new attempt |
| `/luci plan` | Ask for a plan only (files, approach, risks, questions); no code is written |
| `/luci go` | Implement the pending plan, restricted to exactly the files it lists |
| `/luci cancel` | Drop a queued job or pending plan; a running job stops before pushing |
| `/luci status` | Show the latest job and plan state |
| `/luci explain` | Show the settings the bot would use, without calling a model |

A plan becomes invalid if the issue body is edited, and expires after 7 days. A plan can be
executed only once.

### Per-Issue Settings

**Labels** (they can only switch behaviour on):

| Label | Effect |
|---|---|
| `bot:local` | Use the local Ollama model |
| `bot:plan-only` | Post a plan and wait for `/luci go` |
| `bot:dry-run` | Generate and validate, but push nothing |
| `bot:no-pr` | Push the branch but don't open a PR |
| `bot:no-run` | Never process this issue |

**Directives**: a `/luci` line in the issue body, or `@local-model` at the start of the title:

```
/luci model=local base=develop files=src/api/** plan-only dry-run no-pr
```

| Key | Meaning |
|---|---|
| `model=local\|remote` | Which pipeline to use |
| `base=<branch>` | Base branch for the PR (default: the repo's default branch) |
| `files=<glob,...>` | Files to focus on (a hint for context selection) |
| `plan-only`, `dry-run`, `no-pr` | Same as the labels |

Directives are honoured only when the issue author is a collaborator. Otherwise they are ignored and
a warning appears in the status comment.

**Per-repo `.luci-bot.yml`** (cached for 5 minutes):

```yaml
model: remote            # default pipeline
baseBranch: main         # default PR base
allowedPaths: [src/**, docs/**]   # every changed file must match
deniedPaths: [infra/**]           # added to the built-in deny list
maxFiles: 10             # can lower, never raise, the limit of 20
```

Precedence is `.luci-bot.yml` limits > labels > directives > defaults. Nothing written in an issue
can widen the repo's path rules or limits.

## Safety

- **Untrusted input:** issue text and repository files are placed inside randomly delimited data
  blocks, and the system prompt tells the model never to follow instructions found there. The model
  can answer `REFUSE:` or `NEEDS_CLARIFICATION:`, and the bot reports either on the issue without
  retrying.
- **Validation before anything runs:**
  - Branch name and commit message are checked.
  - Paths may not contain traversal, absolute paths or `.git/`.
  - Denied paths cannot be changed: `.github/workflows/**`, `.env*`, SSH keys, plus repo
    `deniedPaths`.
  - At most 20 files and 1 MB per change.
  - Secrets (tokens, keys, private keys) are scanned for and blocked.
  - Suspicious additions such as `curl | sh` or new `postinstall` scripts are blocked unless the
    issue asks for them.
  - Deleting more than 5 files, or deleting protected files, is blocked.
  - Files outside `allowedPaths` or the approved plan are rejected.
- **The worker container:**
  - Runs as uid 1000 on a read-only root filesystem.
  - Has `--cap-drop=ALL` and `no-new-privileges`, with tmpfs scratch space.
  - Supports optional memory, CPU and pids limits.
  - Gets the token through its environment, never in argv, URLs or on disk.
  - Treats every value from the model as data: nothing is interpolated into shell commands.
  - Never force-pushes. A retry gets a new branch name.
- **The webhook:**
  - Verifies the HMAC-SHA256 signature.
  - Processes each delivery ID once.
  - Limits body size and rate-limits per IP.
- **`/api/*`:** requires `Authorization: Bearer $API_TOKEN`. Without `API_TOKEN` it only answers
  direct requests from this machine, never requests through ngrok or another proxy.
- **Redaction:** secrets are removed from logs and from every comment the bot posts.

## LLM Modes

| Mode | When | Strategy |
|---|---|---|
| Remote (default) | — | One request with the issue plus the most relevant repo files |
| Local | `bot:local`, `model=local`, `@local-model`, or `.luci-bot.yml` | Decompose into up to 6 subtasks (max 3 files each), then execute them |

In local mode, subtasks without dependencies on each other run two at a time. Subtasks that edit the
same file run one after the other, and the later one sees the earlier one's output. Decompositions
are rejected if they contain cycles, unknown dependencies or duplicate IDs, or exceed the size limits.
Unparseable output gets one repair attempt.

## Configuration

| Env Variable | Description | Default |
|---|---|---|
| `GITHUB_TOKEN` | PAT with `repo` scope (and `admin:repo_hook` for auto-registration) | — |
| `WEBHOOK_SECRET` | HMAC secret, min. 16 characters | — |
| `MONITORED_REPOS` | Comma-separated `owner/repo` list | `luci/luci-bot` |
| `GITHUB_BOT_USERNAME` | Bot login | owner of the first repo |
| `ADASSO_BASE_URL` | OpenAI-compatible LLM endpoint | `https://adesso-ai-hub.3asabc.de/v1` |
| `ADASSO_API_KEY_FILE` | File containing the LLM API key | `~/.config/opencode/adesso.key` |
| `ADASSO_MODEL` | Remote model | `qwen-3.6-35b-sovereign` |
| `OLLAMA_BASE_URL` | Local Ollama endpoint | `http://localhost:11434` |
| `OLLAMA_MODEL` | Local model | `qwen3:8b` |
| `OLLAMA_DECOMPOSITION_TIMEOUT_MS` | Decomposition timeout | `300000` |
| `OLLAMA_SUBTASK_TIMEOUT_MS` | Per-subtask timeout | `300000` |
| `NGROK_AUTHTOKEN` | Start an ngrok tunnel and register webhooks | — |
| `LISTEN_PORT` | HTTP port | `3000` |
| `API_TOKEN` | Bearer token for `/api/*` | — (local only) |
| `CONTAINER_RUNTIME` | `podman` or `docker` | `podman` |
| `MAX_CONCURRENT_WORKERS` | Max simultaneous jobs/containers (1–10) | `1` |
| `WORKER_TIMEOUT_MS` | Container timeout per job | `600000` |
| `CONTAINER_MEMORY` / `CONTAINER_CPUS` / `CONTAINER_PIDS_LIMIT` | Container limits, e.g. `1g` / `1.5` / `256` | — |
| `MEMORY_PRESSURE_MAX` / `CPU_MAX` | Host load (%) above which worker slots shrink | `85` / `90` |
| `RESOURCE_CHECK_INTERVAL_MS` | Host load polling interval | `10000` |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | Commit author | `luci-github-bot` / `…@users.noreply.github.com` |
| `DRY_RUN` | `1`: never push, just report (global) | `false` |
| `PLAN_DATA_DIR` | Where pending plans are stored | `.luci-bot-plans` |
| `WEBHOOK_BODY_LIMIT` | Max webhook body (bytes) | `1048576` |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` | Per-IP rate limit | `60000` / `100` |
| `SHUTDOWN_TIMEOUT_MS` | Max wait for running jobs on shutdown | `30000` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `GIT_BASE_URL` / `GITHUB_API_URL` | Git/API base used by the worker container (GitHub Enterprise, tests) | github.com |

## Endpoints

| Endpoint | Description |
|---|---|
| `POST /webhook` | GitHub webhook receiver (`issues`, `issue_comment`, `ping`) |
| `GET /health` | Status and worker capacity (public) |
| `GET /api/stats` | Metrics snapshot |
| `GET /api/activity?limit=N` | Recent activity |
| `GET /api/jobs?status=queued\|running\|succeeded\|failed\|cancelled\|no_op` | Jobs, without their payloads, plus `queueDepth` |

## Architecture

```
src/
├── index.ts            # startup validation, worker + queue wiring, ngrok, webhook registration, shutdown
├── webhook.ts          # Express app: HMAC, dedupe, routing, /health, /api/*
├── dispatch.ts         # the one way to enqueue/cancel work for an issue
├── queue.ts / store.ts # durable job queue (JSON file), retries, restart recovery
├── issue-handler.ts    # one job: context → plan or solution → validation → container → GitHub status
├── command-handler.ts  # /luci commands → dispatch / plan flow
├── commands.ts         # command parsing + collaborator gate
├── plan.ts             # plan-only flow: storage, approval, expiry, invalidation
├── job-options.ts / job-context.ts  # directives + labels + .luci-bot.yml → effective options
├── directives.ts / label-switches.ts / repo-config.ts / collaborators.ts
├── llm.ts / prompts.ts # model calls, hardened prompts, output parsing
├── repo-context.ts     # pick and fetch the most relevant files within a budget
├── solution-validator.ts / secret-scan.ts  # what may leave the bot
├── docker-worker.ts    # container runtime, capacity-aware semaphore
├── github.ts           # GitHub REST client, status comment/labels
├── resource-monitor.ts # macOS CPU/memory → capacity
└── metrics.ts / logger.ts / redact.ts / config.ts / types.ts
images/worker.sh        # container entrypoint (prints one RESULT: {...} line)
```

## Development and Tests

```bash
npm run build                 # type-check + compile
npm test                      # unit + integration tests (no network, no containers)
npm run test:regression       # regression subset
scripts/smoke/run.sh          # boot the real bot (fake token, mock LLM, DRY_RUN) and drive it over HTTP
scripts/smoke/run.sh --worker # also run the container path against git daemon + a stub GitHub API
npm run podman:build          # build the worker image by hand (startup does this too)
```

The smoke and worker tests never read your `.env`. They need podman, or set `CONTAINER_RUNTIME=docker`.
See `docs/SMOKE.md` for running against a real throwaway repo, and `docs/TROUBLESHOOTING.md` when
something goes wrong.

## License

MIT
