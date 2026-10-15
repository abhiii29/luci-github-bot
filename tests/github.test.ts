import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { GitHubClient, redact, redactError, buildStatusComment, BOT_COMMENT_MARKER, type StatusCode } from "../src/github.js";
import type { Response } from "node-fetch";

// ── Redaction tests ───────────────────────────────────────────────────────

describe("redact", () => {
  it("redacts GitHub personal access tokens", () => {
    const result = redact("key=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh end");
    expect(result).toContain("ghp_***");
    expect(result).not.toContain("ghp_ABCDE");
  });

  it("redacts GitHub fine-grained tokens", () => {
    const result = redact("pat=github_pat_11ABCDABCDABCDABCDABCDAB_0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF01 end");
    expect(result).toContain("github_pat_***");
  });

  it("redacts user:password in URLs", () => {
    const result = redact("https://user:secret@github.com/repo");
    expect(result).toMatch(/https:\/\/\*\*\*:\*\*\*@github\.com/);
  });

  it("redacts token= query param", () => {
    const result = redact("url?token=abc123&other=xyz");
    expect(result).toMatch(/token=\*\*\*/);
  });

  it("redacts Bearer header", () => {
    const result = redact("Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh");
    expect(result).toContain("Bearer ***");
  });

  it("leaves normal text untouched", () => {
    const result = redact("everything is fine, no secrets here");
    expect(result).toBe("everything is fine, no secrets here");
  });
});

describe("redactError", () => {
  it("truncates very long redacted strings", () => {
    const huge = "error: " + "x".repeat(500);
    const result = redactError(huge);
    expect(result.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it("redacts tokens in error messages", () => {
    const result = redactError("failed: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh");
    expect(result).toContain("ghp_***");
  });
});

// ── Status comment builder tests ──────────────────────────────────────────

describe("buildStatusComment", () => {
  it("includes the marker", () => {
    expect(buildStatusComment("queued")).toContain(BOT_COMMENT_MARKER);
  });

  it("queued stage text", () => {
    const text = buildStatusComment("queued");
    expect(text).toContain("Queued");
    expect(text).toContain("waiting for a worker slot");
  });

  it("working stage text", () => {
    const text = buildStatusComment("working");
    expect(text).toContain("Working");
    expect(text).toContain("LLM is generating");
  });

  it("pr-opened includes link", () => {
    const text = buildStatusComment("pr-opened", undefined, "https://github.com/owner/repo/pull/42");
    expect(text).toContain("[View PR](https://github.com/owner/repo/pull/42)");
  });

  it("pr-opened without URL", () => {
    const text = buildStatusComment("pr-opened");
    expect(text).toContain("PR opened");
  });

  it("failed shows category and hint", () => {
    const text = buildStatusComment("failed", "llm_error", undefined, "Check the issue description for required fields.");
    expect(text).toContain("llm_error");
    expect(text).toContain("Check the issue description");
  });

  it("failed without hint", () => {
    const text = buildStatusComment("failed", "worker_crash");
    expect(text).toContain("worker_crash");
    expect(text).not.toContain("💡");
  });

  it("no stack traces in failed comment", () => {
    const text = buildStatusComment("failed", "error", undefined, "stack trace at line 42\n    at foo()");
    expect(text).not.toContain("    at foo()");
  });
});

// ── GitHubClient integration-style tests ──────────────────────────────────

describe("GitHubClient", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(responses: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
    global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const str = url.toString();
      for (const [key, value] of Object.entries(responses)) {
        if (str.includes(key)) {
          return {
            ok: value.status < 400,
            status: value.status,
            statusText: value.status < 400 ? "OK" : "Error",
            headers: new Map(Object.entries(value.headers ?? {})),
            json: async () => value.body,
            text: async () => JSON.stringify(value.body),
          } as unknown as Response;
        }
      }
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Map(),
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    };
  }

  it("getRepo returns default branch", async () => {
    mockFetch({
      "repos/owner/repo": { status: 200, body: { default_branch: "main" } },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    const repo = await client.getRepo("owner/repo");
    expect(repo).toEqual({ owner: "owner", name: "repo", defaultBranch: "main" });
  });

  it("getRepo throws on 500", async () => {
    mockFetch({
      "repos/owner/bad": { status: 500, body: { message: "Internal Server Error" } },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    await expect(client.getRepo("owner/bad")).rejects.toThrow("500");
  });

  it("createComment returns id and url", async () => {
    mockFetch({
      "issues/1/comments": { status: 201, body: { id: 99, html_url: "https://github.com/owner/repo/issues/1#issuecomment-99" } },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    const result = await client.createComment("owner/repo", 1, "hello");
    expect(result.id).toBe(99);
    expect(result.url).toBe("https://github.com/owner/repo/issues/1#issuecomment-99");
  });

  it("findBotComment finds marker", async () => {
    mockFetch({
      "issues/1/comments": { status: 200, body: [{ id: 10, body: "normal comment" }, { id: 20, body: BOT_COMMENT_MARKER + "\nQueued" }] },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    const found = await client.findBotComment("owner/repo", 1);
    expect(found?.id).toBe(20);
  });

  it("findBotComment returns undefined when not found", async () => {
    mockFetch({
      "issues/1/comments": { status: 200, body: [{ id: 10, body: "normal comment" }] },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    const found = await client.findBotComment("owner/repo", 1);
    expect(found).toBeUndefined();
  });

  it("getPullRequestForBranch returns URL when PR exists", async () => {
    mockFetch({
      "pulls": { status: 200, body: [{ html_url: "https://github.com/owner/repo/pull/7" }] },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    const pr = await client.getPullRequestForBranch("owner/repo", "bot/feature-1");
    expect(pr?.url).toBe("https://github.com/owner/repo/pull/7");
  });

  it("getPullRequestForBranch returns undefined when no PR", async () => {
    mockFetch({
      "pulls": { status: 200, body: [] },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    const pr = await client.getPullRequestForBranch("owner/repo", "bot/feature-2");
    expect(pr).toBeUndefined();
  });

  it("updateComment succeeds on 200", async () => {
    mockFetch({
      "issues/comments/42": { status: 200, body: {} },
    });
    const client = new GitHubClient({ token: "ghp_testtoken12345678901234567890ab" });
    await expect(client.updateComment("owner/repo", 42, "updated")).resolves.toBeUndefined();
  });
});
