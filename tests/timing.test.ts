import { describe, it, expect, vi } from "vitest";
import {
  addSample,
  estimateMs,
  formatEstimate,
  encodeStats,
  decodeStats,
  loadStats,
  saveStats,
  STATS_TITLE,
  type TimingStats,
} from "../src/timing.js";
import { buildStatusComment } from "../src/github.js";

describe("addSample", () => {
  it("averages samples per model and action", () => {
    let s: TimingStats = {};
    s = addSample(s, "m", "plan", 10_000, 100);
    s = addSample(s, "m", "plan", 20_000, 300);
    s = addSample(s, "m", "code", 99_000);
    expect(s["m|plan"]).toEqual({ count: 2, avgMs: 15_000, avgOutputTokens: 200 });
    expect(s["m|code"].count).toBe(1);
  });

  it("weights only the last 50 samples", () => {
    let s: TimingStats = {};
    for (let i = 0; i < 200; i++) s = addSample(s, "m", "code", 1_000);
    for (let i = 0; i < 200; i++) s = addSample(s, "m", "code", 100_000);
    expect(s["m|code"].avgMs).toBeGreaterThan(98_000); // an all-time mean would be ~50s
  });
});

describe("estimateMs", () => {
  it("uses history after 3 samples", () => {
    let s: TimingStats = {};
    for (let i = 0; i < 3; i++) s = addSample(s, "m", "plan", 60_000);
    expect(estimateMs(s, "m", "plan")).toEqual({ lowMs: 42_000, highMs: 90_000, source: "history" });
  });

  it("falls back to defaults with too little history or another model", () => {
    const s = addSample({}, "m", "plan", 60_000);
    expect(estimateMs(s, "m", "plan").source).toBe("default");
    expect(estimateMs(s, "other", "code")).toEqual({ lowMs: 60_000, highMs: 300_000, source: "default" });
  });

  it("adds 1s per 1k input tokens over 8k for code", () => {
    expect(estimateMs({}, "m", "code", 18_000)).toMatchObject({ lowMs: 70_000, highMs: 310_000 });
    expect(estimateMs({}, "m", "plan", 18_000)).toMatchObject({ lowMs: 30_000 });
  });
});

describe("formatEstimate", () => {
  it("shows seconds under 90s and minutes above", () => {
    expect(formatEstimate({ lowMs: 30_000, highMs: 120_000, source: "default" })).toBe("usually 30s–2.0 min");
    expect(formatEstimate({ lowMs: 31_500, highMs: 67_500, source: "history" })).toBe("usually ~45s");
  });
});

describe("stats storage", () => {
  const stats = addSample({}, "qwen", "code", 120_000, 5000);

  it("round-trips through the hidden marker and shows a table", () => {
    const body = encodeStats(stats);
    expect(body).toContain("| qwen | code | 1 | 2.0 min | 5000 |");
    expect(decodeStats(body)).toEqual(stats);
    expect(decodeStats("no marker")).toEqual({});
  });

  it("creates and closes the stats issue the first time, then updates it", async () => {
    let stored: { number: number; body: string } | undefined;
    const gh = {
      findIssueByTitle: vi.fn(async () => stored),
      createIssue: vi.fn(async (_r: string, _t: string, body: string) => ((stored = { number: 7, body }), { number: 7, url: "" })),
      updateIssue: vi.fn(async (_r: string, _n: number, p: { body?: string }) => {
        if (p.body && stored) stored.body = p.body;
      }),
    };
    await saveStats(gh as never, "o/r", "bot", stats);
    expect(gh.createIssue).toHaveBeenCalledWith("o/r", STATS_TITLE, expect.any(String));
    expect(gh.updateIssue).toHaveBeenCalledWith("o/r", 7, { state: "closed" });

    const more = addSample(stats, "qwen", "code", 60_000);
    await saveStats(gh as never, "o/r", "bot", more);
    expect(gh.createIssue).toHaveBeenCalledTimes(1);
    expect(await loadStats(gh as never, "o/r", "bot")).toEqual(more);
  });

  it("never throws when GitHub fails", async () => {
    const gh = { findIssueByTitle: vi.fn().mockRejectedValue(new Error("500")) };
    await expect(loadStats(gh as never, "o/r", "bot")).resolves.toEqual({});
    await expect(saveStats(gh as never, "o/r", "bot", stats)).resolves.toBeUndefined();
  });
});

describe("status stages", () => {
  it("renders working with a hint and retrying without 'Failed'", () => {
    expect(buildStatusComment("working", undefined, undefined, "planning with qwen (usually ~45s)")).toContain(
      "🔨 **Working** — planning with qwen (usually ~45s)."
    );
    const retrying = buildStatusComment("retrying", undefined, undefined, "14:05");
    expect(retrying).toContain("⏳ **Model unreachable** — retrying at 14:05 UTC.");
    expect(retrying).not.toContain("Failed");
    expect(buildStatusComment("working")).toContain("generating a solution.");
  });
});
