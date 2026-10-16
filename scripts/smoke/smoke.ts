/**
 * Smoke test: boot the REAL bot process (src/index.ts) and drive it over HTTP.
 *
 *   npx tsx scripts/smoke/smoke.ts
 *
 * Safety: the bot runs in an empty temp directory, so your .env (real GitHub token, ngrok token)
 * is never loaded. It gets a fake token, a mock LLM and DRY_RUN=1: no comments, labels, pushes or
 * webhook registrations can happen. (GitHub API calls are attempted with the fake token and fail
 * with 401, which the bot must tolerate.)
 *
 * Needs podman (or CONTAINER_RUNTIME=docker) because startup builds the worker image.
 */
import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 19300 + Math.floor(Math.random() * 500);
const LLM_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(24).toString("hex");
const API_TOKEN = crypto.randomBytes(16).toString("hex");
const REPO = "smoke-owner/smoke-repo";
const BOT = "smoke-bot";

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      /* not ready */
    }
    await sleep(500);
  }
  return undefined;
}

async function send(event: string, payload: unknown, opts: { secret?: string; delivery?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", opts.secret ?? SECRET).update(body).digest("hex");
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": opts.delivery ?? crypto.randomUUID(),
      "X-Hub-Signature-256": sig,
    },
    body,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Smoke issue ${n}`,
  body: "Add a health endpoint.",
  state: "open",
  labels: [],
  assignee: { login: BOT },
  html_url: "",
  user: { login: "someone" },
  created_at: "",
  updated_at: "",
  ...extra,
});
const repository = { full_name: REPO, clone_url: "", private: false };
const assigned = (n: number, extra: Record<string, unknown> = {}) => ({
  action: "assigned",
  issue: issue(n, extra),
  assignee: { login: BOT },
  repository,
  sender: { login: "maintainer" },
});

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "luci-smoke-"));
  const keyFile = path.join(work, "llm.key");
  fs.writeFileSync(keyFile, "mock-key\n");

  const procs: ChildProcess[] = [];
  const llm = spawn(process.execPath, [path.join(ROOT, "scripts/smoke/mock-llm.mjs")], {
    env: { ...process.env, MOCK_LLM_PORT: String(LLM_PORT) },
    stdio: "ignore",
  });
  procs.push(llm);

  const logFile = path.join(work, "bot.log");
  const log = fs.openSync(logFile, "w");
  const bot = spawn(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "src/index.ts")], {
    cwd: work, // no .env here: real secrets are never loaded
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GITHUB_TOKEN: "ghp_" + "smokeFakeToken".padEnd(36, "0"),
      WEBHOOK_SECRET: SECRET,
      API_TOKEN,
      MONITORED_REPOS: REPO,
      GITHUB_BOT_USERNAME: BOT,
      LISTEN_PORT: String(PORT),
      ADASSO_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
      ADASSO_API_KEY_FILE: keyFile,
      ADASSO_MODEL: "mock/llm",
      CONTAINER_RUNTIME: process.env.CONTAINER_RUNTIME ?? "podman",
      DRY_RUN: "1",
      SHUTDOWN_TIMEOUT_MS: "15000",
    },
    stdio: ["ignore", log, log],
  });
  procs.push(bot);
  let exitCode: number | null = null;
  bot.on("exit", (code) => (exitCode = code));

  try {
    // 1. boots (startup validation, image build, queue start)
    const health = await waitFor(async () => {
      const r = await fetch(`${BASE}/health`);
      return r.ok ? ((await r.json()) as any) : undefined;
    }, 240_000);
    check("bot boots and /health answers", health?.status === "ok" || health?.status === "degraded", JSON.stringify(health));
    if (!health) throw new Error("bot did not start; see " + logFile);

    // 2. webhook security
    check("ping is answered", (await send("ping", { zen: "x", repository, issue: issue(1) })).body.status === "pong");
    check("bad signature -> 401", (await send("issues", assigned(1), { secret: "wrong-secret-wrong-secret" })).status === 401);
    const unmonitored = await send("issues", { ...assigned(1), repository: { ...repository, full_name: "other/repo" } });
    check("unmonitored repo ignored", unmonitored.body.status === "ignored");
    check("assignment to someone else ignored", (await send("issues", { ...assigned(2), assignee: { login: "human" } })).body.status === "ignored");

    // 3. /api auth
    const noAuth = await fetch(`${BASE}/api/jobs`, { headers: { "X-Forwarded-For": "1.2.3.4" } });
    check("/api rejects requests without the token", noAuth.status === 401);
    const auth = { Authorization: `Bearer ${API_TOKEN}` };
    check("/api accepts the token", (await fetch(`${BASE}/api/stats`, { headers: auth })).ok);

    // 4. a real job through the queue (DRY_RUN: generate + validate, no container push)
    const delivery = crypto.randomUUID();
    const queued = await send("issues", assigned(7), { delivery });
    check("assignment is queued", queued.body.status === "queued", JSON.stringify(queued.body));
    check("redelivery is deduplicated", (await send("issues", assigned(7), { delivery })).body.reason === "duplicate");

    const job = await waitFor(async () => {
      const r = (await (await fetch(`${BASE}/api/jobs`, { headers: auth })).json()) as any;
      const j = r.jobs.find((x: any) => x.issueNumber === 7);
      return j && !["queued", "running"].includes(j.status) ? j : undefined;
    }, 60_000);
    check("job finishes as no_op (dry run) via the mock LLM", job?.status === "no_op", JSON.stringify(job));
    check("job listing hides payloads", job !== undefined && !("payload" in job));

    // 5. graceful shutdown persists the queue
    bot.kill("SIGTERM");
    await waitFor(async () => (exitCode !== null ? true : undefined), 20_000);
    check("SIGTERM exits cleanly", exitCode === 0, `exit ${exitCode}`);
    const store = JSON.parse(fs.readFileSync(path.join(work, ".luci-queue.json"), "utf-8"));
    check("queue state persisted to disk", store.jobs.some((j: any) => j.issueNumber === 7));

    const logs = fs.readFileSync(logFile, "utf-8");
    check("fake token never appears in logs", !logs.includes("smokeFakeToken"));
    check("webhook secret never appears in logs", !logs.includes(SECRET));
  } finally {
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
    if (failed.length) console.log(`Bot log: ${logFile}`);
    else fs.rmSync(work, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
