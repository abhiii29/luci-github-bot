import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import express from "express";

const WEBHOOK_SECRET = "test-secret-abc";

vi.mock("../src/config.js", () => ({
  getConfig: () => ({
    githubToken: "ghp_test1234567890",
    adassoBaseUrl: "http://localhost:8080/v1",
    adassoApiKeyFile: "/tmp/key",
    adassoModel: "test-model",
    listenPort: 3000,
    webhookSecret: WEBHOOK_SECRET,
    monitoredRepos: ["test/repo"],
    workerTimeoutMs: 600_000,
    maxConcurrentWorkers: 1,
    containerRuntime: "podman",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "qwen3:8b",
    memoryPressureMax: 85,
    cpuMax: 90,
    resourceCheckIntervalMs: 10_000,
    gitAuthorName: "luci-github-bot",
    gitAuthorEmail: "luci-github-bot@users.noreply.github.com",
    botUsername: "luci-github-bot",
  }),
}));

vi.mock("../src/metrics.js", () => ({
  metrics: {
    recordIssueReceived: vi.fn(),
    recordIssueProcessing: vi.fn(),
    recordLlmGeneration: vi.fn(),
    recordWorkerExecution: vi.fn(),
    recordIssueCompleted: vi.fn(),
    recordIssueFailed: vi.fn(),
    recordQueue: vi.fn(),
    recordBlocked: vi.fn(),
    getSnapshot: () => ({}),
    getRecentActivity: () => [],
  },
}));

vi.mock("../src/docker-worker.js", () => ({
  DockerWorker: class {
    getCapacity() { return { available: 1, max: 1, full: false }; }
    getStats() { return { cpuUsagePercent: 0, memoryUsedPercent: 0, capacity: 1 }; }
  },
}));

function signBody(body: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  return "sha256=" + hmac.update(body).digest("hex");
}

function makeIssuePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  const baseIssue = {
    number: 42,
    title: "Fix login bug",
    body: "Description of the bug",
    state: "open",
    labels: [{ name: "bug" }],
    assignee: { login: "luci-github-bot" },
    html_url: "https://github.com/test/test/issues/42",
    user: { login: "reporter" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  const baseRepo = {
    full_name: "test/repo",
    clone_url: "https://github.com/test/repo.git",
    private: false,
  };

  return {
    action: "assigned",
    issue: { ...baseIssue, ...(overrides?.issue ?? {}) },
    repository: { ...baseRepo, ...(overrides?.repository ?? {}) },
    sender: { login: "assigner" },
    ...(overrides?.action ? { action: overrides.action } : {}),
    ...(overrides?.sender ? { sender: overrides.sender } : {}),
  };
}

describe("Webhook HMAC + routing", () => {
  let app: express.Express;
  let webhookMod: typeof import("../src/webhook.js");
  let request: (app: express.Express) => Promise<any>;

  beforeEach(async () => {
    vi.resetModules();

    const mod = await import("../src/webhook.js");
    mod.__resetWebhookState();
    app = mod.createWebhookApp();
    mod.onIssue(async () => {});
    mod.onRetry(async () => {});

    const { default: supertest } = await import("supertest");
    request = (a: express.Express) => (method: string, path: string, headers: Record<string, string>, body: unknown) =>
      supertest(a)[method](path).set(headers).send(body);
  });

  async function send(payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
    const bodyStr = JSON.stringify(payload);
    return request(app)(
      "post",
      "/webhook",
      {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "abc123-delivery",
        "X-Hub-Signature-256": signBody(bodyStr, WEBHOOK_SECRET),
        ...extraHeaders,
      },
      payload
    );
  }

  async function sendNoSig(payload: Record<string, unknown>) {
    const bodyStr = JSON.stringify(payload);
    return request(app)(
      "post",
      "/webhook",
      {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "abc123-delivery",
      },
      payload
    );
  }

  async function sendBadSig(payload: Record<string, unknown>) {
    const bodyStr = JSON.stringify(payload);
    return request(app)(
      "post",
      "/webhook",
      {
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "abc123-delivery",
        "X-Hub-Signature-256": "sha256=bad-signature",
      },
      payload
    );
  }

  it("rejects requests with missing signature", async () => {
    const res = await sendNoSig(makeIssuePayload());
    expect(res.status).toBe(400);
  });

  it("rejects requests with invalid signature", async () => {
    const res = await sendBadSig(makeIssuePayload());
    expect(res.status).toBe(401);
  });

  it("accepts requests with valid signature for assigned event", async () => {
    const res = await send(makeIssuePayload());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
  });

  it("ignores non-issues event type", async () => {
    const { default: supertest } = await import("supertest");
    const payload = { hook: true };
    const bodyStr = JSON.stringify(payload);
    const res = await supertest(app)
      .post("/webhook")
      .set("X-GitHub-Event", "push")
      .set("X-GitHub-Delivery", "abc123-delivery")
      .set("X-Hub-Signature-256", signBody(bodyStr, WEBHOOK_SECRET))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  it("rejects invalid issue event payload", async () => {
    const { default: supertest } = await import("supertest");
    const payload = { not: "an issue" };
    const bodyStr = JSON.stringify(payload);
    const res = await supertest(app)
      .post("/webhook")
      .set("X-GitHub-Event", "issues")
      .set("X-GitHub-Delivery", "abc123-delivery")
      .set("X-Hub-Signature-256", signBody(bodyStr, WEBHOOK_SECRET))
      .send(payload);
    expect(res.status).toBe(400);
  });

  it("ignores unmonitored repos", async () => {
    const res = await send(makeIssuePayload({ repository: { full_name: "other/repo" } }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  it("ignores assignments to non-bot users", async () => {
    const res = await send(makeIssuePayload({ issue: { assignee: { login: "other-user" } } }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  it("matches the bot login case-insensitively (GitHub logins are case-insensitive)", async () => {
    const res = await send(makeIssuePayload({ issue: { assignee: { login: "Luci-Github-Bot" } } }));
    expect(res.body.status).toBe("accepted");
  });
});
