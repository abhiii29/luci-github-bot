# luci-github-bot — Agent Notes

## Commands

```bash
npm run build          # Build TypeScript
npm run dev            # Development (tsx, hot-reload)
npm test               # Run vitest
npm test:watch         # Watch mode
npx tsc --noEmit       # Type check
npm run podman:build   # Build worker container image
npm run docker:build   # Alternative with Docker
npm run build:all      # Build everything
```

## Architecture (one-liners)

- `index.ts` — Express server, ngrok tunnel, startup validation, graceful shutdown
- `webhook.ts` — `/webhook` POST (HMAC verify, rate limit, body size limit, per-IP throttling)
- `issue-handler.ts` — Trigger filtering, LLM dispatch, container lifecycle, PR creation
- `llm.ts` — Remote single-shot (Adesso) + local 2-phase decomposition (Ollama), retry on 500/timeout
- `docker-worker.ts` — Ephemeral container spawn (podman/docker), dynamic concurrency semaphore
- `resource-monitor.ts` — macOS CPU/memory polling → worker slot scaling
- `metrics.ts` — In-memory stats: issues processed, LLM generations, worker executions
- `config.ts` — Zod schema, env parsing, startup validation
- `directives.ts` — `/luci` block parser, `@local-model` alias, JobOptions construction
- `repo-config.ts` — `.luci-bot.yml` loader from GitHub contents API (5-min cache)
- `redact.ts` — Secret masking: GitHub PATs, bearer tokens, URL creds, configured secrets
- `logger.ts` — JSON-lines structured logger with auto-redaction and `LOG_LEVEL`

## Conventions

- TypeScript ESM, no `.js` extensions in imports
- All error messages are redacted via `redact()` before logging
- Never log secrets (tokens, keys, passwords, bearer tokens)
- Zod for config validation; fail fast on missing/invalid env vars
- All LLM output goes through the parser/validator before reaching the worker
- Tests: vitest, one test file per source module, mock Ollama via fetch interceptor

## Rules

- Never log or print secret values
- All LLM output is validated (cycle detection, ID uniqueness, path normalization) before execution
- Subtask concurrency defaults to 2 (Ollama bottleneck)
- Webhook body size capped at 1 MB; missing event header → reject immediately
- `/api/*` requires Bearer token; without it, routes are localhost-only
- `PR partial_ok` policy: when enabled, return successful subtasks with warnings; otherwise fail the job but report which subtasks failed
