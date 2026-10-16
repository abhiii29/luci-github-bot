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

// Mock repo-config and directives — we test the trigger logic, not full integration
vi.mock("../src/repo-config.js", () => ({
  loadRepoConfig: vi.fn().mockResolvedValue({ config: {}, warnings: [] }),
}));

vi.mock("../src/directives.js", () => ({
  parseDirectives: vi.fn().mockReturnValue({
    directives: {},
    warnings: [],
    errors: [],
    jobOptions: {
      model: "remote" as const,
      baseBranch: "",
      fileHints: [],
      planOnly: false,
      dryRun: false,
      noPr: false,
      warnings: [],
    },
  }),
}));

// Mock fetch for collaborator check — returns 200 (collaborator)
const mockFetch = vi.fn();
vi.spyOn(globalThis, "fetch").mockImplementation((...args: Parameters<typeof fetch>) => mockFetch(...args));

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
    ...(overrides?.changes ? { changes: overrides.changes } : {}),
  };
}

describe("Trigger rules", () => {
  let app: express.Express;
  let webhookMod: typeof import("../src/webhook.js");
  let handlerCalled = false;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockResolvedValue({ ok: true });
    handlerCalled = false;

    const mod = await import("../src/webhook.js");
    mod.__resetWebhookState();
    app = mod.createWebhookApp();
    mod.onIssue(async () => {
      handlerCalled = true;
    });
    mod.onRetry(async () => {});
  });

  async function send(payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
    const { default: supertest } = await import("supertest");
    const bodyStr = JSON.stringify(payload);
    return supertest(app)
      .post("/webhook")
      .set({
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "abc123-delivery",
        "X-Hub-Signature-256": signBody(bodyStr, WEBHOOK_SECRET),
        ...extraHeaders,
      })
      .send(payload);
  }

  it("processes assignment to bot user", async () => {
    const res = await send(makeIssuePayload());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(handlerCalled).toBe(true);
  });

  it("accepts self-assignment (the bot may run as the maintainer's own account)", async () => {
    const res = await send(makeIssuePayload({ sender: { login: "luci-github-bot" } }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
  });

  it("ignores closed issues", async () => {
    const res = await send(
      makeIssuePayload({ issue: { state: "closed" } })
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(handlerCalled).toBe(false);
  });

  it("ignores pull request events (issue.pull_request truthy)", async () => {
    const res = await send(
      makeIssuePayload({ issue: { pull_request: { url: "https://api/..." } } })
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(handlerCalled).toBe(false);
  });

  it("ignores issues with bot:no-run label", async () => {
    const res = await send(
      makeIssuePayload({ issue: { labels: [{ name: "bot:no-run" }] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(handlerCalled).toBe(false);
  });

  it("processes issue without bot:no-run label", async () => {
    const res = await send(
      makeIssuePayload({ issue: { labels: [{ name: "enhancement" }] } })
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(handlerCalled).toBe(true);
  });

  it("ignores an assigned event for another user even if the bot is the first assignee", async () => {
    const payload = makeIssuePayload({ issue: { assignee: { login: "luci-github-bot" } } });
    (payload as any).assignee = { login: "second-person" }; // the user that was just assigned
    const res = await send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(handlerCalled).toBe(false);
  });

  it("processes a reassignment from a person to the bot", async () => {
    const payload = makeIssuePayload({ issue: { assignee: { login: "someone-else" } } });
    (payload as any).assignee = { login: "luci-github-bot" };
    const res = await send(payload);
    expect(res.body.status).toBe("accepted");
  });

  it("still supports needs-retry for edited action", async () => {
    const retryPayload = {
      action: "edited",
      issue: {
        number: 42,
        title: "Fix login bug",
        body: "Description",
        state: "open",
        labels: [{ name: "needs-retry" }, { name: "bug" }],
        assignee: { login: "luci-github-bot" },
        html_url: "https://github.com/test/test/issues/42",
        user: { login: "reporter" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      repository: {
        full_name: "test/repo",
        clone_url: "https://github.com/test/repo.git",
        private: false,
      },
      sender: { login: "reporter" },
    };
    const res = await send(retryPayload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("retry");
  });

  it("ignores needs-retry but not assigned-to-bot", async () => {
    // A closed issue with needs-retry should still be ignored (closed check takes precedence)
    const res = await send(
      makeIssuePayload({
        action: "edited",
        issue: {
          state: "closed",
          labels: [{ name: "needs-retry" }],
        },
      })
    );
    // Edited action does not go through the assigned handler, so it returns ignored
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  it("attaches jobOptions to the event", async () => {
    const mod = await import("../src/directives.js");
    (mod.parseDirectives as ReturnType<typeof vi.fn>).mockReturnValue({
      directives: {},
      warnings: [],
      errors: [],
      jobOptions: {
        model: "remote" as const,
        baseBranch: "main",
        fileHints: ["src/*.ts"],
        planOnly: false,
        dryRun: false,
        noPr: false,
        warnings: [],
      },
    });

    const res = await send(makeIssuePayload());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
  });
});
