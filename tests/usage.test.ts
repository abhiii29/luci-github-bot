import { describe, it, expect } from "vitest";
import { withUsage, recordUsage, currentUsage, formatUsage } from "../src/usage.js";
import { buildStatusComment } from "../src/github.js";

const priced = { inputPerMTok: 3, outputPerMTok: 15 };

describe("usage accumulation", () => {
  it("sums calls, tokens and distinct models within a job", async () => {
    const u = await withUsage(async () => {
      recordUsage("m1", 1000, 200);
      await new Promise((r) => setTimeout(r, 1));
      recordUsage("m1", 500, 100);
      recordUsage("m2", 10, 5);
      return currentUsage();
    });
    expect(u).toEqual({ models: ["m1", "m2"], inputTokens: 1510, outputTokens: 305, calls: 3, reported: true });
  });

  it("keeps concurrent jobs apart", async () => {
    const job = (n: number) =>
      withUsage(async () => {
        recordUsage("m", n, n);
        await new Promise((r) => setTimeout(r, 5));
        recordUsage("m", n, n);
        return currentUsage()!.inputTokens;
      });
    expect(await Promise.all([job(1), job(100)])).toEqual([2, 200]);
  });

  it("is a no-op outside a job", () => {
    recordUsage("m", 1, 1);
    expect(currentUsage()).toBeUndefined();
  });

  it("counts calls without token counts as not reported", async () => {
    const u = await withUsage(async () => (recordUsage("m"), currentUsage()));
    expect(formatUsage(u, priced)).toBe("🧮 Model: m · Tokens: not reported (1 call) · Est. cost: n/a");
  });
});

describe("formatUsage", () => {
  const u = { models: ["qwen"], inputTokens: 12345, outputTokens: 2100, calls: 3, reported: true };

  it("prices tokens per million", () => {
    expect(formatUsage(u, priced)).toBe("🧮 Model: qwen · Tokens: 12,345 in / 2,100 out (3 calls) · Est. cost: $0.07");
  });

  it("shows <$0.01 for tiny costs", () => {
    expect(formatUsage({ ...u, inputTokens: 100, outputTokens: 10 }, priced)).toContain("Est. cost: <$0.01");
  });

  it("explains how to enable cost when pricing is unset", () => {
    expect(formatUsage(u, {})).toContain("Est. cost: n/a (set LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK)");
  });

  it("returns nothing when no model was called", () => {
    expect(formatUsage(undefined, priced)).toBeUndefined();
    expect(formatUsage({ ...u, calls: 0 }, priced)).toBeUndefined();
  });

  it("is appended to the status comment", () => {
    const text = buildStatusComment("pr-opened", undefined, "https://x/pr/1", undefined, ["a note"], "🧮 Model: qwen");
    expect(text.trim().endsWith("🧮 Model: qwen")).toBe(true);
    expect(text.indexOf("a note")).toBeLessThan(text.indexOf("🧮"));
  });
});
