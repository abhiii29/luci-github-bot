/**
 * Full request path: signed webhook -> job options -> durable queue -> handler -> (fake) LLM ->
 * validation -> (fake) container -> GitHub labels/comments. Only the network, the LLM and the
 * container are faked; queue, store, dispatch, commands, plan flow and webhook are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

const SECRET = "integration-secret-0123456789";
const REPO = "acme/widgets";
const BOT = "luci-bot";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luci-flow-"));

const cfg = {
  githubToken: "ghp_integrationFakeToken000000000000000000",
  adassoBaseUrl: "http://localhost:1/v1",
  adassoApiKeyFile: "/dev/null",
  adassoModel: "remote-model",
  listenPort: 0,
  webhookSecret: SECRET,
  monitoredRepos: [REPO],
  workerTimeoutMs: 60_000,
  maxConcurrentWorkers: 1,
  containerRuntime: "podman",
  ollamaBaseUrl: "http://localhost:1",
  ollamaModel: "local-model",
  memoryPressureMax: 85,
  cpuMax: 90,
  resourceCheckIntervalMs: 10_000,
  gitAuthorName: "bot",
  gitAuthorEmail: "bot@example.com",
  botUsername: BOT,
  webhookBodyLimit: "1mb",
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 10_000,
  shutdownTimeoutMs: 5_000,
  dryRun: false,
  planDataDir: path.join(tmp, "plans"),
  ollamaDecompositionTimeoutMs: 1_000,
  ollamaSubtaskTimeoutMs: 1_000,
};
vi.mock("../../src/config.js", () => ({ getConfig: () => cfg, getAdessoApiKey: async () => "k" }));

// ── Fake LLM ──
type Sol = { success: boolean; files: any[]; branchName: string; commitMessage: string; error?: string; refused?: string; clarification?: string };
const llm = {
  solution: (): Sol => ({
    success: true,
    branchName: "bot/fix-thing",
    commitMessage: "Fix the thing",
    files: [{ path: "src/thing.ts", operation: "update", content: "export const thing = 2;\n" }],
  }),
  plan: () => "BRANCH: bot/plan\nCOMMIT: Do it\nAPPROACH: Change thing.\nFILES: src/thing.ts:update:the fix\nRISK: none",
  calls: 0,
};
vi.mock("../../src/llm.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm.js")>()),
  generateSolution: vi.fn(async () => (llm.calls++, llm.solution())),
  generateSolutionWithDecomposition: vi.fn(async () => (llm.calls++, llm.solution())),
  generatePlanText: vi.fn(async () => llm.plan()),
}));
vi.mock("../../src/repo-context.js", () => ({
  buildRepoContext: vi.fn(async () => repoCtx),
}));
const repoCtx = {
  promptSection: "--- FILE: src/thing.ts ---\nexport const thing = 1;\n",
  fileCount: 1,
  truncatedPaths: [] as string[],
  fullContents: { "src/thing.ts": "export const thing = 1;\n" } as Record<string, string>,
};
const repoConfig: { config: Record<string, unknown>; warnings: string[] } = { config: {}, warnings: [] };
vi.mock("../../src/repo-config.js", () => ({ loadRepoConfig: vi.fn(async () => repoConfig) }));

// ── Fake container ──
const runs: Array<{ issue: number; files: string[]; opts: any }> = [];
let running = 0;
let maxRunning = 0;
vi.mock("../../src/docker-worker.js", () => ({
  DockerWorker: class {
    getCapacity() {
      return { available: 1, max: 1, full: false };
    }
    getStats() {
      return { cpuUsagePercent: 0, memoryUsedPercent: 0, capacity: 1 };
    }
    async processIssue(event: any, solution: any, _p: unknown, opts: any) {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      runs.push({ issue: event.issue.number, files: solution.files.map((f: any) => f.path), opts });
      if (opts?.noPr) return { success: true, status: "branch_pushed", branchName: solution.branchName, issueNumber: event.issue.number };
      return {
        success: true,
        status: "pr_created",
        branchName: solution.branchName,
        prUrl: `https://github.com/${REPO}/pull/${100 + event.issue.number}`,
        issueNumber: event.issue.number,
      };
    }
  },
}));

// ── Fake GitHub REST API ──
const gh = {
  comments: new Map<number, Array<{ id: number; body: string }>>(),
  labels: new Map<number, Set<string>>(),
  collaborators: new Set<string>(["maintainer", "reporter"]),
  openPrs: [] as Array<{ number: number; html_url: string; body: string }>,
  nextId: 1,
};
// Real GitHub has latency; random delays make ordering races (two bot:* labels, duplicate
// status comments) show up here instead of only on a live repo.
async function ghFetch(input: any, init: any = {}): Promise<Response> {
  await new Promise((r) => setTimeout(r, Math.random() * 8));
  return ghRoute(input, init);
}

function ghRoute(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = (init.method ?? "GET").toUpperCase();
  const p = url.pathname.replace(`/repos/${REPO}`, "");
  const json = (status: number, body: unknown) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/collaborators\/(.+)$/))) return json(gh.collaborators.has(decodeURIComponent(m[1])) ? 204 : 404, {});
  if ((m = p.match(/^\/issues\/(\d+)\/comments$/))) {
    const n = Number(m[1]);
    const list = gh.comments.get(n) ?? [];
    gh.comments.set(n, list);
    if (method === "GET") return json(200, list);
    const c = { id: gh.nextId++, body: JSON.parse(init.body).body };
    list.push(c);
    return json(201, { id: c.id, html_url: "x" });
  }
  if ((m = p.match(/^\/issues\/comments\/(\d+)$/))) {
    for (const list of gh.comments.values()) {
      const c = list.find((x) => x.id === Number(m![1]));
      if (c) c.body = JSON.parse(init.body).body;
    }
    return json(200, {});
  }
  if ((m = p.match(/^\/issues\/(\d+)\/labels$/))) {
    const set = gh.labels.get(Number(m[1])) ?? new Set();
    gh.labels.set(Number(m[1]), set);
    for (const l of JSON.parse(init.body).labels) set.add(l);
    return json(200, []);
  }
  if ((m = p.match(/^\/issues\/(\d+)\/labels\/(.+)$/))) {
    const set = gh.labels.get(Number(m[1]));
    const name = decodeURIComponent(m[2]);
    if (!set?.has(name)) return json(404, {});
    set.delete(name);
    return json(200, []);
  }
  if (p.startsWith("/labels/")) return json(200, {});
  if (p === "/pulls") return json(200, gh.openPrs);
  return json(404, {});
}

// ── Helpers ──
let app: any;
let queue: any;
let store: any;
let delivery = 0;

function issue(n: number, extra: Record<string, unknown> = {}) {
  return {
    number: n,
    title: `Issue ${n}`,
    body: "Please fix the thing.",
    state: "open",
    labels: [] as { name: string }[],
    assignee: { login: BOT },
    html_url: "",
    user: { login: "reporter" },
    created_at: "",
    updated_at: "",
    ...extra,
  };
}
const repository = { full_name: REPO, clone_url: "", private: false };

function send(event: string, payload: unknown, deliveryId = `d-${++delivery}`) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  return request(app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("X-GitHub-Event", event)
    .set("X-GitHub-Delivery", deliveryId)
    .set("X-Hub-Signature-256", sig)
    .send(body);
}
const assign = (n: number, extra: Record<string, unknown> = {}, deliveryId?: string) =>
  send("issues", { action: "assigned", issue: issue(n, extra), assignee: { login: BOT }, repository, sender: { login: "maintainer" } }, deliveryId);
const comment = (n: number, body: string, user = "maintainer", issueExtra: Record<string, unknown> = {}) =>
  send("issue_comment", {
    action: "created",
    issue: issue(n, issueExtra),
    comment: { id: 1, body, user: { login: user, type: user.endsWith("[bot]") ? "Bot" : "User" } },
    repository,
    sender: { login: user },
  });

async function settle(ms = 3_000) {
  const end = Date.now() + ms;
  await new Promise((r) => setTimeout(r, 30));
  while (Date.now() < end) {
    if (queue.isIdle()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("queue did not settle");
}
const jobs = (n: number) => store.getSnapshot().jobs.filter((j: any) => j.issueNumber === n);
const allComments = (n: number) => (gh.comments.get(n) ?? []).map((c) => c.body).join("\n---\n");
const labelsOf = (n: number) => [...(gh.labels.get(n) ?? [])];

beforeEach(async () => {
  vi.resetModules();
  runs.length = 0;
  running = maxRunning = 0;
  llm.calls = 0;
  llm.solution = () => ({
    success: true,
    branchName: "bot/fix-thing",
    commitMessage: "Fix the thing",
    files: [{ path: "src/thing.ts", operation: "update", content: "export const thing = 2;\n" }],
  });
  repoConfig.config = {};
  repoCtx.truncatedPaths = [];
  repoCtx.fullContents = { "src/thing.ts": "export const thing = 1;\n" };
  gh.comments.clear();
  gh.labels.clear();
  gh.openPrs = [];
  fs.rmSync(cfg.planDataDir, { recursive: true, force: true });
  vi.spyOn(globalThis, "fetch").mockImplementation(ghFetch as any);
  vi.spyOn(console, "log").mockImplementation(() => {});

  const { JsonQueueStore } = await import("../../src/store.js");
  const { JobQueue } = await import("../../src/queue.js");
  const dispatch = await import("../../src/dispatch.js");
  const handler = await import("../../src/issue-handler.js");
  const webhook = await import("../../src/webhook.js");
  const commands = await import("../../src/command-handler.js");
  const { DockerWorker } = await import("../../src/docker-worker.js");

  store = new JsonQueueStore(path.join(tmp, `q-${Date.now()}-${Math.random()}.json`));
  queue = new JobQueue(store, 1);
  queue.setProcessor(async (job: any) => {
    const event = dispatch.eventFromJob(job);
    return handler.handleIssue(event!, { isCancelled: () => dispatch.isJobCancelled(job.id) });
  });
  dispatch.initDispatch(store, queue);
  const worker = new (DockerWorker as any)();
  handler.setIssueWorker(worker);
  (await import("../../src/webhook.js")).setDockerWorker(worker);
  webhook.__resetWebhookState();
  webhook.setQueueStore(store);
  webhook.onQueued(handler.markIssueQueued);
  webhook.onComment(commands.handleIssueComment);
  app = webhook.createWebhookApp(cfg as any);
  await queue.start();
});

afterEach(async () => {
  await queue.stop(100);
  (await import("../../src/dispatch.js")).resetDispatch();
  vi.restoreAllMocks();
});

describe("assignment -> queue -> PR", () => {
  it("runs three issues one at a time with capacity 1, without manual action", async () => {
    for (const n of [1, 2, 3]) expect((await assign(n)).body.status).toBe("queued");
    await settle();
    expect(runs.map((r) => r.issue)).toEqual([1, 2, 3]);
    expect(maxRunning).toBe(1);
    for (const n of [1, 2, 3]) {
      expect(jobs(n)[0].status).toBe("succeeded");
      expect(jobs(n)[0].prUrl).toBe(`https://github.com/${REPO}/pull/${100 + n}`);
      expect(labelsOf(n)).toEqual(["bot:awaiting-review"]);
      // exactly one status comment, edited in place, ending with the PR link
      const bodies = gh.comments.get(n)!.map((c) => c.body);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain(`pull/${100 + n}`);
    }
  });

  it("processes a redelivered webhook once", async () => {
    await assign(4, {}, "same-delivery");
    const again = await assign(4, {}, "same-delivery");
    expect(again.body.reason).toBe("duplicate");
    await settle();
    expect(runs).toHaveLength(1);
  });

  it("does not queue a second job while one is open", async () => {
    await assign(5);
    const second = await assign(5);
    expect(["already_queued", undefined]).toContain(second.body.reason);
    await settle();
    expect(runs.filter((r) => r.issue === 5)).toHaveLength(1);
  });

  it("leaves human labels alone", async () => {
    gh.labels.set(6, new Set(["bug", "priority:high"]));
    await assign(6);
    await settle();
    expect(labelsOf(6).sort()).toEqual(["bot:awaiting-review", "bug", "priority:high"]);
  });
});

describe("options reach the worker", () => {
  it("honours /luci directives from a collaborator", async () => {
    await assign(10, { body: "Fix it.\n\n/luci base=develop no-pr" });
    await settle();
    expect(runs[0].opts.baseBranch).toBe("develop");
    expect(runs[0].opts.noPr).toBe(true);
    expect(allComments(10)).toContain("Branch pushed");
  });

  it("ignores directives from a non-collaborator", async () => {
    await assign(11, { body: "/luci base=evil no-pr", user: { login: "stranger" } });
    await settle();
    expect(runs[0].opts.baseBranch).toBeUndefined();
    expect(runs[0].opts.noPr).toBe(false);
  });

  it("passes .luci-bot.yml denied paths and limits to the validator", async () => {
    repoConfig.config = { deniedPaths: ["secret/**"], maxFiles: 3 };
    await assign(12);
    await settle();
    expect(runs[0].opts.validation.deniedPatterns).toEqual(["secret/**"]);
    expect(runs[0].opts.validation.maxFiles).toBe(3);
  });

  it("rejects changes outside .luci-bot.yml allowedPaths without running a container", async () => {
    repoConfig.config = { allowedPaths: ["docs/**"] };
    await assign(13);
    await settle();
    expect(runs).toHaveLength(0);
    expect(jobs(13)[0].status).toBe("failed");
    expect(allComments(13)).toContain("out_of_scope");
  });

  it("dry-run label generates but never runs a container", async () => {
    await assign(14, { labels: [{ name: "bot:dry-run" }] });
    await settle();
    expect(runs).toHaveLength(0);
    expect(allComments(14)).toContain("Dry run");
    expect(jobs(14)[0].status).toBe("no_op");
  });
});

describe("model outcomes", () => {
  it("a refusal is reported and not retried", async () => {
    llm.solution = () => ({ success: false, files: [], branchName: "", commitMessage: "", error: "Model refused: x", refused: "touches CI" });
    await assign(20);
    await settle();
    expect(llm.calls).toBe(1);
    expect(jobs(20)[0].status).toBe("failed");
    expect(allComments(20)).toContain("refused");
    expect(labelsOf(20)).toEqual(["bot:blocked"]);
  });

  it("a solution containing a secret is blocked before the container", async () => {
    llm.solution = () => ({
      success: true,
      branchName: "bot/leak",
      commitMessage: "Add config",
      files: [{ path: "src/config.ts", operation: "create", content: `export const token = "ghp_${"A".repeat(36)}";\n` }],
    });
    await assign(21);
    await settle();
    expect(runs).toHaveLength(0);
    expect(allComments(21)).toContain("validation");
    expect(allComments(21)).not.toContain("A".repeat(36));
  });

  it("an unusable answer is retried automatically", async () => {
    llm.solution = () => ({ success: false, files: [], branchName: "", commitMessage: "", error: "parse error" });
    await assign(22);
    await settle(8_000);
    expect(llm.calls).toBe(2); // maxAttempts = 2
    expect(jobs(22)[0].status).toBe("failed");
  });
});

describe("idempotency", () => {
  it("does not open a second PR when the bot already has one open for the issue", async () => {
    gh.openPrs = [{ number: 6, html_url: `https://github.com/${REPO}/pull/6`, body: "Automated pull request generated by luci-github-bot.\n\nCloses #70\n" }];
    await assign(70);
    await settle();
    expect(runs).toHaveLength(0);
    expect(llm.calls).toBe(0);
    expect(jobs(70)[0].prUrl).toBe(`https://github.com/${REPO}/pull/6`);
    expect(allComments(70)).toContain("already open");
  });

  it("ignores PRs for other issues and PRs not made by the bot", async () => {
    gh.openPrs = [
      { number: 8, html_url: "x", body: "Automated pull request generated by luci-github-bot.\n\nCloses #710\n" },
      { number: 9, html_url: "y", body: "Closes #71" },
    ];
    await assign(71);
    await settle();
    expect(runs).toHaveLength(1);
  });
});

describe("destructive changes and outages", () => {
  it("never pushes a whole-file rewrite of a file the model only saw truncated (PR #5)", async () => {
    const original = Array.from({ length: 200 }, (_, i) => `export const l${i} = ${i};`).join("\n");
    repoCtx.fullContents = { "src/thing.ts": original };
    repoCtx.truncatedPaths = ["src/thing.ts"];
    llm.solution = () => ({
      success: true,
      branchName: "bot/version",
      commitMessage: "Add version",
      files: [{ path: "src/thing.ts", operation: "update", content: original.split("\n").slice(0, 40).join("\n") }],
    });
    await assign(60);
    await settle(8_000);
    expect(runs).toHaveLength(0);
    expect(allComments(60)).toContain("unsafe_change");
    expect(llm.calls).toBe(2); // retried once: the model may get it right with a patch
  });

  it("applies a patch to a truncated file and pushes the whole file", async () => {
    const original = Array.from({ length: 200 }, (_, i) => `export const l${i} = ${i};`).join("\n") + "\n";
    repoCtx.fullContents = { "src/thing.ts": original };
    repoCtx.truncatedPaths = ["src/thing.ts"];
    llm.solution = () => ({
      success: true,
      branchName: "bot/version",
      commitMessage: "Add version",
      files: [{ path: "src/thing.ts", operation: "patch", content: "<<<<<<< SEARCH\nexport const l0 = 0;\n=======\nexport const l0 = 0;\nexport const version = 1;\n>>>>>>> REPLACE" }],
    });
    await assign(61);
    await settle();
    expect(runs).toHaveLength(1);
    expect(jobs(61)[0].status).toBe("succeeded");
  });

  it("a model outage is reported as such and retried later, not after 1 s", async () => {
    llm.solution = () => {
      throw Object.assign(new Error("502 litellm.BadGatewayError: The model backend is unavailable"), { status: 502 });
    };
    await assign(62);
    for (let i = 0; i < 100 && !allComments(62).includes("model_unavailable"); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(allComments(62)).toContain("model_unavailable");
    expect(llm.calls).toBe(1); // still waiting for the delayed retry
  });
});

describe("/luci commands", () => {
  it("non-collaborators are refused and nothing is queued", async () => {
    await comment(30, "/luci retry", "stranger");
    await settle();
    expect(runs).toHaveLength(0);
    expect(allComments(30)).toContain("only repo collaborators");
  });

  it("/luci retry queues a job", async () => {
    await comment(31, "/luci retry");
    await settle();
    expect(runs.map((r) => r.issue)).toEqual([31]);
  });

  it("commands inside code blocks are ignored", async () => {
    await comment(32, "```\n/luci retry\n```");
    await settle();
    expect(runs).toHaveLength(0);
  });

  it("the bot's own status/reply comments never trigger commands", async () => {
    await comment(33, "<!-- luci-bot:status -->\n/luci retry", BOT);
    await comment(33, "/luci retry", "some-app[bot]");
    await settle();
    expect(runs).toHaveLength(0);
    expect(gh.comments.get(33) ?? []).toHaveLength(0);
  });

  it("works when the bot runs as the maintainer's own account", async () => {
    gh.collaborators.add(BOT);
    expect((await send("issues", { action: "assigned", issue: issue(35), assignee: { login: BOT }, repository, sender: { login: BOT } })).body.status).toBe("queued");
    await settle();
    await comment(36, "/luci retry", BOT);
    await settle();
    expect(runs.map((r) => r.issue)).toEqual([35, 36]);
  });

  it("/luci explain answers without calling the model", async () => {
    await comment(34, "/luci explain", "maintainer", { labels: [{ name: "bot:local" }] });
    await settle();
    expect(llm.calls).toBe(0);
    expect(allComments(34)).toContain("Model: local");
  });

  it("plan -> go implements exactly the approved files", async () => {
    await comment(40, "/luci plan");
    await settle();
    expect(runs).toHaveLength(0);
    expect(allComments(40)).toContain("Proposed plan");
    expect(allComments(40)).toContain("src/thing.ts");

    await comment(40, "/luci go");
    await settle();
    expect(runs.map((r) => r.files)).toEqual([["src/thing.ts"]]);
    expect(allComments(40)).toContain("pull/140");

    // a second /luci go cannot re-run an executed plan
    await comment(40, "/luci go");
    await settle();
    expect(runs).toHaveLength(1);
  });

  it("go fails if the model strays outside the approved plan", async () => {
    await comment(41, "/luci plan");
    await settle();
    llm.solution = () => ({
      success: true,
      branchName: "bot/x",
      commitMessage: "x",
      files: [
        { path: "src/thing.ts", operation: "update", content: "x\n" },
        { path: "src/other.ts", operation: "create", content: "y\n" },
      ],
    });
    await comment(41, "/luci go");
    await settle();
    expect(runs).toHaveLength(0);
    expect(allComments(41)).toContain("out_of_scope");
  });

  it("go is rejected after the issue body changed", async () => {
    await comment(42, "/luci plan");
    await settle();
    await comment(42, "/luci go", "maintainer", { body: "A completely different request" });
    await settle();
    expect(runs).toHaveLength(0);
    expect(allComments(42)).toContain("issue changed");
  });

  it("/luci cancel drops a pending plan", async () => {
    await comment(43, "/luci plan");
    await settle();
    await comment(43, "/luci cancel");
    await settle();
    expect(allComments(43)).toContain("pending plan was dropped");
    await comment(43, "/luci go");
    await settle();
    expect(runs).toHaveLength(0);
  });
});

describe("dashboard", () => {
  it("serves the page with a strict CSP and no data in it", async () => {
    const res = await request(app).get("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(res.text).toContain("<title>luci-github-bot</title>");
    expect(res.text).not.toContain(REPO);
  });

  it("overview, jobs and plans are behind /api auth from outside", async () => {
    for (const p of ["/api/overview", "/api/jobs", "/api/plans"]) {
      expect((await request(app).get(p).set("X-Forwarded-For", "203.0.113.9")).status).toBe(403);
    }
  });

  it("jobs show the issue title but never the payload", async () => {
    await assign(50, { title: "<img src=x onerror=alert(1)>", body: "secret-ish body text" });
    await settle();
    const res = await request(app).get("/api/jobs");
    const job = res.body.jobs.find((j: any) => j.issueNumber === 50);
    expect(job.title).toBe("<img src=x onerror=alert(1)>"); // rendered with textContent by the page
    expect(JSON.stringify(res.body)).not.toContain("secret-ish body text");
  });

  it("overview reports job counts and capacity; plans lists stored plans", async () => {
    await comment(51, "/luci plan");
    await settle();
    const o = (await request(app).get("/api/overview")).body;
    expect(o.jobCounts.no_op).toBeGreaterThanOrEqual(1);
    expect(o.capacity).toEqual({ available: 1, max: 1, full: false });
    expect(o.repos).toEqual([REPO]);
    const plans = (await request(app).get("/api/plans")).body.plans;
    expect(plans.find((p: any) => p.issueNumber === 51)).toMatchObject({ repo: REPO, status: "pending" });
  });
});
