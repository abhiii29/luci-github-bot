# Smoke Test Guide

## Quick Start

```bash
# From the project root
cd scripts/smoke
chmod +x run.sh send-webhook.sh
./run.sh
```

The smoke test starts a mock LLM server and the bot with `DRY_RUN=1`, sends
six webhook fixtures, asserts HTTP outcomes, and prints a pass/fail table.

## What It Tests

| Fixture | Scenario | Expected |
|---|---|---|
| `assigned-to-bot` | Bot is assignee, `@local-model` in title | Accepted (200) |
| `assigned-to-other` | Assigned to different user | Ignored (200) |
| `wrong-repo` | Not in `MONITORED_REPOS` | Ignored (200) |
| `needs-retry` | Has `needs-retry` label | Triggers retry logic |
| `injection-payload` | Command injection in title/body | Accepted, sanitized |
| `duplicate-delivery` | Duplicate delivery ID | Should not double-process |

## Prerequisites

- Node.js installed
- `.env` file present (copied from `.env.example` and filled in)
- No podman/Ollama required (mock LLM handles LLM traffic)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BOT_URL` | `http://localhost:3000` | Bot API URL |
| `MOCK_LLM_PORT` | `19999` | Mock LLM server port |
| `WEBHOOK_SECRET` | (from `.env`) | HMAC secret for signing payloads |

## Manual Testing Against a Real Repo

### Setup

1. Create a throwaway repo:
   ```bash
   gh repo create test-luci-bot --public
   ```

2. Ensure your PAT has `repo` scope and set `GITHUB_TOKEN` in `.env`.

3. Add the repo to `MONITORED_REPOS` in `.env`:
   ```
   MONITORED_REPOS=testuser/test-luci-bot
   ```

4. Build and start the bot:
   ```bash
   npm run build:all
   npm start
   ```

5. In a separate terminal, register a GitHub webhook:
   ```bash
   # The bot auto-registers on startup when ngrok is configured
   # Or manually via:
   gh api repos/testuser/test-luci-bot/hooks -f active=true -f config[url]="https://your-ngrok-url/webhook" -f config[content_type]="json" -f config[secret]="your-webhook-secret"
   ```

### Running a Test

1. Assign an issue to the bot user:
   ```bash
   gh issue create --repo testuser/test-luci-bot \
     --title "@local-model Add a health check endpoint" \
     --body "Please add a health check endpoint that returns JSON with status and timestamp."
   ```

2. The bot should:
   - Receive the webhook
   - Call the LLM (remote or local depending on `@local-model`)
   - Generate a solution
   - Execute it in a container
   - Open a PR with the changes

### Expected Outcome

- A new branch `luci/test-luci-bot/<issue-number>-<short-hash>` is created
- A PR is opened against the target branch
- The bot comments on the issue with a summary

### Cleanup

```bash
# Delete the test repo
gh repo delete testuser/test-luci-bot --yes

# Remove the webhook
gh api repos/testuser/test-luci-bot/hooks -X DELETE -f hook_id=<hook-id>
```

## Adding New Fixtures

1. Create a new JSON file in `scripts/smoke/fixtures/`
2. Follow the schema of existing fixtures (see `assigned-to-bot.json`)
3. Add a test case in `scripts/smoke/run.sh`

## Troubleshooting

See `docs/TROUBLESHOOTING.md` for common issues.

If the mock LLM server fails to start, check:
- Port 19999 is not in use
- Node.js is available and supports ES modules

If the bot fails to start:
- Check that `.env` has valid values
- Ensure the API key file exists and is readable
- Check `npm run dev` output for errors
