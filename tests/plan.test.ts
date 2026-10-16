// ---------------------------------------------------------------------------
// Brief 15: Tests for plan-only / approval flow
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Keep plan state out of the working tree
const PLAN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "luci-plans-"));
vi.mock("../src/config.js", () => ({ getConfig: () => ({ planDataDir: PLAN_DIR }) }));
import {
  hashIssueBody,
  createPlan,
  approvePlan,
  cancelPlan,
  getPlanState,
  invalidatePlan,
  getApprovedFiles,
  parsePlanOutput,
  isPlanExpired,
  type Plan,
} from "../src/plan.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeLlm = async () => `BRANCH: feat/issue-42
COMMIT: Add rate limiting
APPROACH: Add a sliding window rate limiter to the webhook handler
RISK: In-memory state lost on restart
QUESTION: Should we support distributed rate limiting?
FILES: src/rate-limiter.ts:create:New rate limiter module
FILES: src/webhook.ts:update:Add rate limiting check`;

// ---------------------------------------------------------------------------
// parsePlanOutput
// ---------------------------------------------------------------------------

describe("parsePlanOutput", () => {
  it("parses all plan fields", async () => {
    const plan = parsePlanOutput(await fakeLlm(""), "");
    expect(plan.branchName).toBe("feat/issue-42");
    expect(plan.commitMessage).toBe("Add rate limiting");
    expect(plan.approach).toContain("sliding window");
    expect(plan.risks).toContain("In-memory state lost on restart");
    expect(plan.openQuestions).toContain("Should we support distributed rate limiting?");
    expect(plan.files).toHaveLength(2);
    expect(plan.files[0].path).toBe("src/rate-limiter.ts");
    expect(plan.files[0].operation).toBe("create");
    expect(plan.files[1].path).toBe("src/webhook.ts");
    expect(plan.files[1].operation).toBe("update");
  });

  it("handles minimal output", () => {
    const plan = parsePlanOutput("BRANCH: x\nCOMMIT: y", "");
    expect(plan.branchName).toBe("x");
    expect(plan.commitMessage).toBe("y");
    expect(plan.files).toHaveLength(0);
    expect(plan.risks).toHaveLength(0);
  });

  it("handles missing branch/commit", () => {
    const plan = parsePlanOutput("APPROACH: do it\nRISK: bad", "");
    expect(plan.branchName).toContain("do-it");
    expect(plan.commitMessage).toBe("Implement approved plan");
  });
});

// ---------------------------------------------------------------------------
// Plan lifecycle
// ---------------------------------------------------------------------------

describe("Plan lifecycle", () => {
  let key: string;

  beforeEach(() => {
    // Key format: owner__repoWithDashes__issueNumber
    // repoFullName "test-owner/test-repo" → sanitized "test-owner-test-repo"
    key = "test-owner__test-owner-test-repo__42";
  });

  it("create -> approve -> getApprovedFiles", async () => {
    const { plan: state } = await createPlan(
      "test-owner",
      "Add feature",
      "Body text",
      "test-owner/test-repo",
      42,
      fakeLlm
    );
    expect(state.status).toBe("pending");
    expect(state.plan.files).toHaveLength(2);

    const approved = approvePlan(key, "collaborator");
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("collaborator");

    const files = getApprovedFiles(key);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("src/rate-limiter.ts");
  });

  it("create -> cancel", async () => {
    await createPlan("test-owner", "Add feature", "Body", "test-owner/test-repo", 42, fakeLlm);
    const cancelled = cancelPlan(key);
    expect(cancelled.status).toBe("cancelled");

    expect(() => approvePlan(key, "alice")).toThrow("cancelled");
  });

  it("expired plan cannot be approved", async () => {
    await createPlan("test-owner", "Add feature", "Body", "test-owner/test-repo", 42, fakeLlm);
    const state = getPlanState("test-owner", "test-repo", 42);
    expect(state?.status).toBe("pending");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      expect(getPlanState("test-owner", "test-repo", 42)?.status).toBe("expired");
      expect(() => approvePlan(key, "alice")).toThrow("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("unchanged issue body does not invalidate the plan", async () => {
    await createPlan("test-owner", "Add feature", "Same body", "test-owner/test-repo", 42, fakeLlm);
    const same = invalidatePlan("test-owner", "test-repo", 42, hashIssueBody("Same body"));
    expect(same?.status).toBe("pending");
  });

  it("invalidates plan on issue body change", async () => {
    const { plan: state } = await createPlan(
      "test-owner",
      "Add feature",
      "Original body",
      "test-owner/test-repo",
      42,
      fakeLlm
    );
    expect(state.issueBodyHash).toBeDefined();

    const invalidated = invalidatePlan("test-owner", "test-repo", 42, "different-hash");
    expect(invalidated?.status).toBe("expired");
  });

  it("getPlanState returns null for non-existent plan", () => {
    expect(getPlanState("test-owner", "test-repo", 999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTL / expiration
// ---------------------------------------------------------------------------

describe("Plan TTL", () => {
  it("plan not expired within TTL", () => {
    const state = {
      plan: {
        branchName: "feat/x",
        commitMessage: "x",
        files: [],
        approach: "x",
        risks: [],
        openQuestions: [],
        createdAt: new Date().toISOString(),
      },
      status: "pending" as const,
    };
    expect(isPlanExpired(state, 86400000)).toBe(false);
  });

  it("plan expired after TTL", () => {
    const state = {
      plan: {
        branchName: "feat/x",
        commitMessage: "x",
        files: [],
        approach: "x",
        risks: [],
        openQuestions: [],
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      },
      status: "pending" as const,
    };
    expect(isPlanExpired(state, 7 * 24 * 60 * 60 * 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan file restriction
// ---------------------------------------------------------------------------

describe("getApprovedFiles", () => {
  it("returns empty for unapproved plan", () => {
    const files = getApprovedFiles("nonexistent");
    expect(files).toHaveLength(0);
  });
});

describe("parsePlanOutput: split into parts", () => {
  it("collects PART lines in merge order", () => {
    const plan = parsePlanOutput(
      [
        "APPROACH: Two stages.",
        "FILES: src/a.ts:update:first part",
        "PART: Data model :: Add the store. :: src/a.ts, src/b.ts",
        "PART: UI :: Show it :: Uses a :: separator. :: src/ui.ts",
      ].join("\n"),
      ""
    );
    expect(plan.parts).toHaveLength(2);
    expect(plan.parts![0]).toEqual({ title: "Data model", scope: "Add the store.", files: ["src/a.ts", "src/b.ts"] });
    expect(plan.parts![1].title).toBe("UI");
  });

  it("ignores a single PART and malformed lines", () => {
    expect(parsePlanOutput("PART: Only one :: x :: a.ts", "").parts).toBeUndefined();
    expect(parsePlanOutput("PART: no scope\nPART: also none", "").parts).toBeUndefined();
  });

  it("caps the number of parts", () => {
    const raw = Array.from({ length: 9 }, (_, i) => `PART: P${i} :: s :: f${i}.ts`).join("\n");
    expect(parsePlanOutput(raw, "").parts).toHaveLength(6);
  });
});
