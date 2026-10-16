import { describe, it, expect } from "vitest";
import { formatPlanComment } from "../src/issue-handler.js";
import type { PlanState } from "../src/plan.js";

describe("formatPlanComment", () => {
  const basePlan = {
    branchName: "feat/test",
    commitMessage: "test commit",
    files: [{ path: "src/a.ts", reason: "modify", operation: "update" }],
    approach: "do something",
    risks: [],
    openQuestions: [],
    createdAt: new Date().toISOString(),
  };

  it("shows split section and new go sentence when parts exist", () => {
    const state: PlanState = {
      plan: { ...basePlan, parts: [{ title: "Part A", scope: "scope A", files: ["src/a.ts"] }, { title: "Part B", scope: "scope B", files: ["src/b.ts"] }] },
      status: "pending",
    };
    const comment = formatPlanComment(state);
    expect(comment).toContain("Too big for one PR — proposed split into 2 parts:");
    expect(comment).toContain("`Part A` — scope A (files: src/a.ts)");
    expect(comment).toContain("`Part B` — scope B (files: src/b.ts)");
    expect(comment).toContain("Reply `/luci go` to create one sub-issue per part");
    expect(comment).not.toContain("implement exactly these files");
  });

  it("does not show split section when parts are absent", () => {
    const state: PlanState = { plan: basePlan, status: "pending" };
    const comment = formatPlanComment(state);
    expect(comment).not.toContain("Too big for one PR");
    expect(comment).toContain("implement exactly these files");
  });
});