# luci-github-bot — agent notes

Self-hosted bot: issue assigned to the bot user → durable queue → LLM → validation → container → PR.
README.md is the source of truth for behaviour; keep it in sync when behaviour changes.

## Commands

```bash
npm run build                  # tsc (type-check + compile)
npm test                       # vitest: unit + tests/integration (no network/containers)
scripts/smoke/run.sh           # real bot process, fake token, mock LLM, DRY_RUN (never reads .env)
scripts/smoke/run.sh --worker  # + real container against git daemon and a stub GitHub API
```

`vitest` does not type-check: always run `npm run build` (or `npx tsc --noEmit`) too.

## Where things live

- Entrypoints: `index.ts` (webhook server) and `action.ts` (GitHub Action, one event per run); both wire handlers via `bootstrap.ts`
- Request path: `webhook.ts` (`routeEvent`) → `dispatch.ts` (enqueue) → `queue.ts`/`store.ts` → `issue-handler.ts`
- `/luci` commands: `command-handler.ts` (hooks) + `commands.ts` (parsing, collaborator gate)
- Effective per-job options: `job-context.ts` (network) + `job-options.ts` (pure merge + globs)
- What may leave the bot: `solution-validator.ts` + `secret-scan.ts`; worker.sh re-checks paths
- Container: `docker-worker.ts` + `images/worker.sh` (prints one `RESULT: {...}` line)

## Rules

- ESM: relative imports end in `.js`.
- Never log or post secrets; route error text through `redact()` (`github.ts` for comments).
- All model output is untrusted: it goes through `validateSolution` + `validateSolutionContent`
  and the scope check before any container runs. Never interpolate model text into shell code.
- New work for an issue always goes through `enqueueIssue()` (one open job per issue).
- Handler outcomes: `retryable: false` for refusals, clarification requests and validation errors.
- Status on GitHub = one marker comment (edited in place) + one `bot:*` label; never touch other labels.
- Every behaviour change needs a test; flows that cross modules go in `tests/integration/flow.test.ts`.
