# Troubleshooting

## Webhook Not Delivered

### Symptom: No webhook events reaching the bot

**Check 1 — ngrok tunnel**
```bash
# In a separate terminal, check the ngrok status
curl http://127.0.0.1:4040/api/tunnels
```
If no tunnel shows `status: online`, ngrok failed to start. Check `NGROK_AUTHTOKEN` in `.env`.

**Check 2 — Webhook secret mismatch**
The webhook receiver logs a warning if `X-Hub-Signature-256` is missing or doesn't match:
```json
{"level":"warn","msg":"[webhook] Missing X-Hub-Signature-256 header"}
{"level":"error","msg":"[webhook] Signature verification failed"}
```
Ensure the secret configured in GitHub's webhook settings exactly matches `WEBHOOK_SECRET` in `.env` (minimum 16 characters).

**Check 3 — Bot registered a webhook**
The bot auto-registers `/webhook` as a GitHub webhook URL on startup. Verify the URL in the GitHub repo settings (Settings → Webhooks). The URL should be `https://<ngrok-url>/webhook`.

**Check 4 — 401 on `/api/*` routes**
If calling internal endpoints externally, include `Authorization: Bearer <API_TOKEN>`. Without a token, `/api/*` routes are bound to localhost only.

---

## Podman Machine Not Running

### Symptom: Container spawn fails with connection error

**Check**
```bash
podman info 2>&1
```

**Fix**
```bash
# Start the machine (first run downloads a ~200 MB VM)
podman machine start

# Wait for the socket to be ready
while ! podman info &>/dev/null; do sleep 1; done

# Rebuild the worker image
npm run podman:build
```

---

## Bot Stuck at Capacity / Issues Queued

### Symptom: Issues stay `bot:queued` for a long time

Queued jobs start automatically when a slot frees up; nothing needs to be re-triggered. List them with
`curl -H "Authorization: Bearer $API_TOKEN" "localhost:3000/api/jobs?status=queued"`.

**Check capacity**
```bash
curl http://localhost:3000/health
```
If `"full": true`, all worker slots are in use. The resource monitor (polling `top` and `vm_stat` every 10 seconds) will free slots as CPU/memory drop below thresholds (`MEMORY_PRESSURE_MAX`/`CPU_MAX`).

**Check running containers**
```bash
podman ps -a --filter "ancestor=luci-github-bot-worker"
```
If many are `running` for a long time, a worker may be hung. Increase `WORKER_TIMEOUT_MS` or investigate the specific issue.

**Fix: Adjust thresholds**
Raise `MEMORY_PRESSURE_MAX` / `CPU_MAX` (worker slots shrink above these) or `MAX_CONCURRENT_WORKERS`.

---

## LLM Parse Failures

### Symptom: Job fails with "Failed to parse LLM JSON output"

**Possible causes:**

1. **Model is too small** for the task — try `@local-model` with decomposition on a larger model (e.g., `qwen3:14b`) or use the remote model.

2. **Output contains thinking tags** (`<think>...</think>`) — the bot now strips these automatically. If parsing still fails, check the logs for the raw output.

3. **Truncated response** — check for `done_reason: "length"` in logs. Increase `OLLAMA_DECOMPOSITION_TIMEOUT_MS` or `OLLAMA_SUBTASK_TIMEOUT_MS`.

4. **Subtask validation errors** — the pipeline now validates for cycle-free dependencies, duplicate IDs, and size limits. Error messages will say exactly what is wrong (e.g., "Subtask dependency cycle detected").

---

## PR Not Created

### Symptom: Bot processes the issue but no PR appears

**Check 1 — PAT permissions**
Ensure `GITHUB_TOKEN` has `repo` scope. Without it, the `POST /repos/{owner}/{repo}/pulls` call will return 403.

**Check 2 — Branch already exists**
If the bot previously created the same branch name, push will fail. Delete the stale branch on GitHub or wait for it to be cleaned up.

**Check 3 — Dry run mode**
If `DRY_RUN=1` is set, the bot prints the diff and would-be PR title/body but does NOT push or open a PR. Remove the env var and restart.

---

## Ollama Unreachable / Timeouts

### Symptom: Local model jobs fail with connection errors or hang

**Check Ollama is running**
```bash
curl http://localhost:11434/api/tags
```

**Check the model is pulled**
```bash
ollama list | grep -i qwen3
```
If not present: `ollama pull qwen3:8b`

**Increase timeout**
Set `OLLAMA_DECOMPOSITION_TIMEOUT_MS=600000` and `OLLAMA_SUBTASK_TIMEOUT_MS=600000` for large repos.

**Check for Ollama OOM**
If Ollama is OOM-killed, restart it: `systemctl restart ollama` (or however you manage the service).

---

## Startup Validation Errors

### Symptom: Bot exits immediately with a table of problems

The bot prints a validation table at startup. Common entries:

| Message | Fix |
|---|---|
| `GITHUB_TOKEN is missing` | Set `GITHUB_TOKEN` in `.env` |
| `WEBHOOK_SECRET must be at least 16 chars` | Set a longer secret |
| `Cannot read API key file: ...` | Check `ADASSO_API_KEY_FILE` path exists |
| `Invalid repo format: ...` | Use `owner/repo` format for `MONITORED_REPOS` |
| `podman not found` | Install: `brew install podman` |
| `/api/* routes bound to localhost only` (warning) | Set `API_TOKEN` if you need remote access |
