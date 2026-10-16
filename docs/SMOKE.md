# Smoke and end-to-end tests

## Local, safe (no GitHub account, no real tokens)

```bash
scripts/smoke/run.sh            # bot process
scripts/smoke/run.sh --worker   # bot process + container path
```

**`scripts/smoke/smoke.ts`** boots the real `src/index.ts` in an empty temp directory, so your `.env`
is never loaded. It runs with a fake GitHub token, a mock LLM (`mock-llm.mjs`) and `DRY_RUN=1`. It checks:

- startup, including the worker image build
- `/health`
- `ping`
- that a bad signature is rejected
- that unmonitored repos and other assignees are ignored
- `/api` authentication
- that an assignment is queued, and a redelivery is deduplicated
- that the job finishes as `no_op` (dry run)
- that `/api/jobs` hides payloads
- a clean `SIGTERM`
- that the queue is persisted
- that no secret appears in the logs

GitHub API calls are attempted with the fake token and fail with 401, which the bot must tolerate.

**`scripts/e2e/worker-e2e.ts`** runs `DockerWorker.processIssue` with a real container against a
throwaway bare repo served by `git daemon`, plus a stub of the "create pull request" API. It covers:

- a PR is created against the detected default branch, with `Closes #N`
- hostile commit messages are stored literally and never executed
- a no-op solution reports `no_changes`
- a retry gets a unique branch name
- `noPr` pushes the branch without opening a PR
- path traversal is rejected
- a missing base branch produces an error
- the token never leaks

Both need podman (or `CONTAINER_RUNTIME=docker`). The first run builds the worker image.

`send-webhook.sh` signs and posts a single fixture to a running bot:

```bash
WEBHOOK_SECRET=... scripts/smoke/send-webhook.sh scripts/smoke/fixtures/assigned-to-bot.json issues
```

## Against a real throwaway repo

1. Create a repo and a bot account, or use your own account as the bot with `GITHUB_BOT_USERNAME`:
   ```bash
   gh repo create you/luci-sandbox --private --add-readme
   ```
2. In `.env`, set:
   - `MONITORED_REPOS=you/luci-sandbox`
   - `GITHUB_TOKEN` (scope `repo`, plus `admin:repo_hook` for auto-registration)
   - `WEBHOOK_SECRET`
   - `NGROK_AUTHTOKEN` (or expose the port yourself)
3. Start with `DRY_RUN=1 npm run dev` first. The bot registers the webhook for `issues` and
   `issue_comment`.
4. Create an issue and assign it to the bot user. Expect one status comment, a `bot:*` label and a
   "Dry run" summary comment.
5. Try `/luci explain`, then `/luci plan` and `/luci go`, as comments.
6. Restart without `DRY_RUN`, then comment `/luci retry`. Expect a PR with `Closes #N`.

**Cleanup:**

```bash
gh repo delete you/luci-sandbox --yes
```
