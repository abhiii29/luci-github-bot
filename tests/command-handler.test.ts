import { describe, it, expect, vi } from "vitest";
import { buildCommandHooks } from "../src/command-handler.js";
import { getPlanState, approvePlan, planKeyFor } from "../src/plan.js";
import { createSplitIssues } from "../src/split.js";
import { getConfig } from "../src/config.js";
import { GitHubClient } from "../src/github.js";
import type { GitHubCommentEvent } from "../src/webhook.js";

vi.mock("../src/plan.js", () => ({
  getPlanState: vi.fn(),
  approvePlan: vi.fn(),
  planKeyFor: vi.fn(),
  hashIssueBody: () => "abc123",
}));

vi.mock("../src/split.js", () => ({
  createSplitIssues: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  getConfig: vi.fn(),
}));

vi.mock("../src/github.js", () => ({
  GitHubClient: vi.fn(),
}));

vi.mock("../src/commands.js", () => ({
  handleCommentCommand: vi.fn(),
}));

describe("buildCommandHooks go", () => {
  const mockEvent: GitHubCommentEvent = {
    action: "created",
    issue: { number: 1, title: "Test Issue", body: "Test body", labels: [], pull_request: undefined } as any,
    comment: { id: 1, body: "/luci go", user: { login: "user", type: "User" } },
    repository: { full_name: "owner/repo" } as any,
    sender: { login: "user" },
  };

  it("calls createSplitIssues and returns sub-issue message when plan has 2+ parts", async () => {
    const parts = [{ title: "Part 1", scope: "s1", files: ["a.ts"] }, { title: "Part 2", scope: "s2", files: ["b.ts"] }];
    const planState = { plan: { parts, files: [] }, status: "pending" } as any;
    vi.mocked(getPlanState).mockReturnValue(planState);
    vi.mocked(planKeyFor).mockReturnValue("key");
    vi.mocked(getConfig).mockReturnValue({ githubToken: "tok", botUsername: "bot" } as any);
    vi.mocked(GitHubClient).mockImplementation(() => ({}) as any);
    vi.mocked(createSplitIssues).mockResolvedValue([101, 102]);

    const hooks = buildCommandHooks(mockEvent);
    const result = await hooks.go("user");

    expect(createSplitIssues).toHaveBeenCalled();
    expect(approvePlan).not.toHaveBeenCalled();
    expect(result).toContain("split into 2 sub-issues: #101, #102");
    expect(result).toContain("Part 1 (#101) has been assigned and starts now.");
  });
});