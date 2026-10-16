// ---------------------------------------------------------------------------
// Brief 14: Tests for comment command handler
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCommand, type CommandName, type IssueCommentPayload } from "../src/commands.js";
import { metrics } from "../src/metrics.js";
import { resolveLabelSwitches } from "../src/label-switches.js";

// The real check hits the GitHub API; default to "is collaborator" unless a test injects its own.
vi.mock("../src/collaborators.js", () => ({
  isCollaborator: vi.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// parseCommand: basic parsing
// ---------------------------------------------------------------------------

describe("parseCommand: basic parsing", () => {
  it("parses /luci retry", () => {
    const result = parseCommand("/luci retry");
    expect(result).toEqual({ name: "retry", args: "" });
  });

  it("parses /luci cancel with extra args", () => {
    const result = parseCommand("/luci cancel ignore this");
    expect(result).toEqual({ name: "cancel", args: "ignore this" });
  });

  it("is case-insensitive", () => {
    expect(parseCommand("/LUCI RETRY")).toEqual({ name: "retry", args: "" });
    expect(parseCommand("/LuCi StaTuS")).toEqual({ name: "status", args: "" });
  });

  it("ignores /luci in code blocks", () => {
    const body = "```bash\n/luci retry\n```";
    expect(parseCommand(body)).toBeNull();
  });

  it("ignores unknown commands", () => {
    expect(parseCommand("/luci deploy")).toBeNull();
  });

  it("ignores non-command comments", () => {
    expect(parseCommand("Please fix this")).toBeNull();
  });

  it("ignores /luci without action", () => {
    expect(parseCommand("/luci ")).toBeNull();
  });

  it("parses all known commands", () => {
    const known: CommandName[] = ["retry", "cancel", "status", "explain", "plan", "go"];
    for (const cmd of known) {
      expect(parseCommand(`/luci ${cmd}`)).toEqual({ name: cmd, args: "" });
    }
  });

  it("handles /luci with mixed case command", () => {
    expect(parseCommand("/luci RETRY")).toEqual({ name: "retry", args: "" });
    expect(parseCommand("/luci Cancel")).toEqual({ name: "cancel", args: "" });
  });
});

// ---------------------------------------------------------------------------
// parseCommand: edge cases
// ---------------------------------------------------------------------------

describe("parseCommand: edge cases", () => {
  it("ignores /luci inside a fenced block", () => {
    const body = "Some text\n```\n/luci retry\n```\nmore text";
    expect(parseCommand(body)).toBeNull();
  });

  it("parses /luci outside fenced block", () => {
    const body = "/luci status\n```\n/luci retry\n```";
    expect(parseCommand(body)).toEqual({ name: "status", args: "" });
  });

  it("handles empty body", () => {
    expect(parseCommand("")).toBeNull();
  });

  it("handles null body", () => {
    expect(parseCommand(null as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

describe("handleCommentCommand: permissions", () => {
  const basePayload: IssueCommentPayload = {
    owner: "test",
    repo: "repo",
    issueNumber: 42,
    username: "alice",
    body: "/luci retry",
    isBot: false,
    labels: [],
  };

  beforeEach(() => {
    metrics.reset();
  });

  it("rejects non-collaborator", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle(basePayload, undefined, undefined, async () => false);
    expect(result.status).toBe("denied");
    expect(result.reply).toContain("only repo collaborators");
  });

  it("allows collaborators", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle({
      ...basePayload,
      body: "/luci status",
    });
    expect(result.status).toBe("ok");
    expect(result.reply).toContain("Status");
  });

  it("ignores bot comments silently", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle({
      ...basePayload,
      isBot: true,
    });
    expect(result.reply).toBe("");
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Command handlers: retry and cancel
// ---------------------------------------------------------------------------

describe("handleCommentCommand: retry and cancel", () => {
  const payload: IssueCommentPayload = {
    owner: "test",
    repo: "repo",
    issueNumber: 42,
    username: "alice",
    body: "/luci retry",
    isBot: false,
    labels: [],
  };

  it("retry calls onRetry handler", async () => {
    let called = false;
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle(payload, async () => { called = true; });
    expect(called).toBe(true);
    expect(result.reply).toContain("retry triggered");
  });

  it("cancel calls onCancel handler", async () => {
    let called = false;
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle(
      { ...payload, body: "/luci cancel" },
      undefined,
      async () => { called = true; },
    );
    expect(called).toBe(true);
    expect(result.reply).toContain("cancelled");
  });

  it("retry without handler returns error", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle(payload);
    expect(result.reply).toContain("not available");
  });
});

// ---------------------------------------------------------------------------
// Command handlers: status and explain
// ---------------------------------------------------------------------------

describe("handleCommentCommand: status and explain", () => {
  it("status returns metrics summary", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle({
      owner: "test",
      repo: "repo",
      issueNumber: 42,
      username: "alice",
      body: "/luci status",
      isBot: false,
      labels: [],
    });
    expect(result.reply).toContain("Status");
    expect(result.reply).toContain("success");
    expect(result.reply).toContain("failed");
  });

  it("explain returns parsed options", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle({
      owner: "test",
      repo: "repo",
      issueNumber: 42,
      username: "alice",
      body: "/luci explain",
      isBot: false,
      labels: ["bot:local", "bot:plan-only"],
    });
    expect(result.reply).toContain("Model: local");
    expect(result.reply).toContain("Plan only: true");
  });

  it("plan/go returns not-configured message", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle({
      owner: "test",
      repo: "repo",
      issueNumber: 42,
      username: "alice",
      body: "/luci plan",
      isBot: false,
      labels: [],
    });
    expect(result.reply).toContain("plan-only mode not yet configured");
  });

  it("go returns not-configured message", async () => {
    const { handleCommentCommand: handle } = await import("../src/commands.js");
    const result = await handle({
      owner: "test",
      repo: "repo",
      issueNumber: 42,
      username: "alice",
      body: "/luci go",
      isBot: false,
      labels: [],
    });
    expect(result.reply).toContain("plan-only execution not yet configured");
  });
});

// ---------------------------------------------------------------------------
// Label switch resolution
// ---------------------------------------------------------------------------

describe("label switch resolution", () => {
  it("resolves all bot: labels", () => {
    const labels = [
      "bot:local",
      "bot:dry-run",
      "bot:no-pr",
      "bot:plan-only",
      "bot:no-run",
    ];
    const resolved = resolveLabelSwitches(labels);
    expect(resolved.useLocal).toBe(true);
    expect(resolved.dryRun).toBe(true);
    expect(resolved.noPr).toBe(true);
    expect(resolved.planOnly).toBe(true);
    expect(resolved.noRun).toBe(true);
  });

  it("resolves empty labels", () => {
    const resolved = resolveLabelSwitches([]);
    expect(resolved.useLocal).toBe(false);
    expect(resolved.dryRun).toBe(false);
  });

  it("is case-insensitive for labels", () => {
    const resolved = resolveLabelSwitches(["BOT:LOCAL", "bot:Dry-Run"]);
    expect(resolved.useLocal).toBe(true);
    expect(resolved.dryRun).toBe(true);
  });
});
