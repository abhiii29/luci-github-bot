# Running the bot as a GitHub Action

No server, no ngrok, no laptop: each issue event starts a workflow run that handles it and exits.
The same routing, queue, validation and container worker as the webhook server are used
(`src/action.ts` → `routeEvent` → queue → `handleIssue`).

## Setup (per monitored repo)

1. **Secrets** (repo or org → Settings → Secrets → Actions):
   - `LUCI_BOT_TOKEN` — PAT of the bot account, `repo` scope (no `workflow` scope).
     Don't use the built-in `GITHUB_TOKEN`: PRs it opens don't trigger CI.
   - `ADESSO_API_KEY` — the model API key.
2. Copy [`github-action/luci-bot.yml`](github-action/luci-bot.yml) to `.github/workflows/luci-bot.yml`
   and set `bot-username`.
3. If this bot repo is private, allow access to its workflows:
   bot repo → Settings → Actions → General → Access → "Accessible from repositories owned by …".

Assign an issue to the bot user, as before.

## Inputs (reusable workflow `.github/workflows/luci-bot.yml`)

| Input | Default | |
|---|---|---|
| `bot-username` | — (required) | Login issues are assigned to |
| `bot-ref` | `main` | Pin a tag/SHA for stable behaviour |
| `adesso-base-url` / `adesso-model` | hub defaults | Must be reachable from GitHub-hosted runners |
| `dry-run` | `false` | Report, never push |

## Differences from the server

- **State** (job history, plans) is kept per issue in one hidden comment written by the bot
  (`<!-- luci-bot:state … -->`), so `/luci plan` → `/luci go` and `/luci status` work across runs.
  Don't edit or delete it. (The Actions cache can't be used: `issues`/`issue_comment` runs get
  read-only cache access.)
- **One run per issue at a time** (`concurrency` group). Events arriving meanwhile wait; GitHub keeps
  only the newest waiting run per issue.
- **Cancelling a running job**: cancel the workflow run in the Actions tab. `/luci cancel` still drops
  pending plans. The next run marks the cancelled job `interrupted` instead of re-running it.
- **Retries** happen inside the run (including the 3-minute wait when the model is down), capped by
  the 30-minute job timeout. A run that ends with a failed job is marked red.
- **Local model** (`@local-model`, `bot:local`) needs `OLLAMA_BASE_URL` pointing at a reachable
  host; `localhost` doesn't exist on a hosted runner.
- No dashboard, `/api/*` or resource monitor: the run log and the issue's status comment replace them.

## Run locally

```bash
npm run build
GITHUB_EVENT_NAME=issues GITHUB_EVENT_PATH=event.json GITHUB_REPOSITORY=owner/repo \
  GITHUB_TOKEN=... GITHUB_BOT_USERNAME=... ADASSO_API_KEY=... DRY_RUN=1 npm run start:action
```
