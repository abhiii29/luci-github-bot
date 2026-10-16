import { describe, it, expect, vi } from "vitest";
import {
  partIssueBody,
  parsePartMarker,
  partsComment,
  parsePartsComment,
  createSplitIssues,
  nextPartAfterMerge,
  type SplitGitHub,
  type PlanPart,
} from "../src/split.js";

describe("split", () => {
  const parent = { number: 100, title: "Big Feature" };
  const parts: PlanPart[] = [
    { title: "Part 1", scope: "Core", files: ["src/a.ts"] },
    { title: "Part 2", scope: "Utils", files: ["src/b.ts", "src/c.ts"] },
  ];

  describe("partIssueBody & parsePartMarker", () => {
    it("round trips correctly", () => {
      const body = partIssueBody(parent, parts[0], 1, 2, 99);
      const parsed = parsePartMarker(body);
      expect(parsed).toEqual({ parent: 100, index: 1, total: 2 });
      expect(body).toContain("Part 1 of 2 for #100 (Big Feature)");
      expect(body).toContain("Scope: Core");
      expect(body).toContain("Files to focus on: src/a.ts");
      expect(body).toContain("Depends on #99 (merged first).");
      expect(body).toContain("<!-- luci-bot:part parent=100 index=1 total=2 -->");
    });

    it("omits optional lines when not provided", () => {
      const body = partIssueBody(parent, parts[1], 2, 2);
      expect(body).not.toContain("Files to focus on:");
      expect(body).not.toContain("Depends on #");
    });
  });

  describe("partsComment & parsePartsComment", () => {
    it("round trips correctly", () => {
      const comment = partsComment([101, 102, 103]);
      expect(comment).toContain("1. #101");
      expect(comment).toContain("2. #102");
      expect(comment).toContain("3. #103");
      expect(comment).toContain("<!-- luci-bot:parts 101,102,103 -->");

      const parsed = parsePartsComment(comment);
      expect(parsed).toEqual([101, 102, 103]);
    });
  });

  describe("createSplitIssues", () => {
    it("creates issues in order with dependencies and assigns only first", async () => {
      let callCount = 0;
      const gh = {
        createIssue: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({ number: 200 + callCount, url: `https://github.com/owner/repo/issues/${200 + callCount}` });
        }),
        createComment: vi.fn().mockResolvedValue({ id: 1, url: "" }),
        addAssignees: vi.fn().mockResolvedValue(undefined),
        getIssue: vi.fn(),
        findCommentWithMarker: vi.fn(),
      } as unknown as SplitGitHub;

      const numbers = await createSplitIssues(gh, "owner/repo", parent, parts, "luci-bot");

      expect(numbers).toEqual([201, 202]);
      expect(gh.createIssue).toHaveBeenCalledTimes(2);
      
      const firstBody = gh.createIssue.mock.calls[0][2] as string;
      expect(firstBody).not.toContain("Depends on #");
      
      const secondBody = gh.createIssue.mock.calls[1][2] as string;
      expect(secondBody).toContain("Depends on #201 (merged first).");

      expect(gh.createComment).toHaveBeenCalledWith("owner/repo", 100, expect.stringContaining("1. #201"));
      expect(gh.addAssignees).toHaveBeenCalledWith("owner/repo", 201, ["luci-bot"]);
    });
  });

  describe("nextPartAfterMerge", () => {
    const gh = {
      getIssue: vi.fn(),
      findCommentWithMarker: vi.fn(),
    } as unknown as SplitGitHub;

    it("returns next when index < list length", async () => {
      gh.getIssue.mockResolvedValue({
        number: 201,
        author: "luci-bot",
        body: partIssueBody(parent, parts[0], 1, 2, undefined),
      });
      gh.findCommentWithMarker.mockResolvedValue({
        id: 1,
        body: partsComment([201, 202]),
      });

      const result = await nextPartAfterMerge(gh, "owner/repo", 201, "luci-bot");
      expect(result).toEqual({ kind: "next", issue: 202, parent: 100 });
    });

    it("returns done when index === list length", async () => {
      gh.getIssue.mockResolvedValue({
        number: 202,
        author: "luci-bot",
        body: partIssueBody(parent, parts[1], 2, 2, 201),
      });
      gh.findCommentWithMarker.mockResolvedValue({
        id: 1,
        body: partsComment([201, 202]),
      });

      const result = await nextPartAfterMerge(gh, "owner/repo", 202, "luci-bot");
      expect(result).toEqual({ kind: "done", parent: 100 });
    });

    it("returns null if author does not match botUsername", async () => {
      gh.getIssue.mockResolvedValue({
        number: 201,
        author: "other-user",
        body: partIssueBody(parent, parts[0], 1,