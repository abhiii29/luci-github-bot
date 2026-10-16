/**
 * Regressions found while the bot built its own features (Oct 2026). Covered elsewhere:
 * - truncated code answer must not become a PR            → llm-truncation.test.ts
 * - second /luci go must not create a second set of parts → command-handler.test.ts
 * - part sub-issues carry the parent spec                 → split.test.ts
 * - "Failed" shown while the model is only being retried  → timing.test.ts
 */
import fs from "fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));
vi.mock("../src/config.js", async (orig) => ({
  ...(await orig<typeof import("../src/config.js")>()),
  getAdessoApiKey: async () => "k",
}));

const { generatePlanText, generateSolution, TruncatedResponseError } = await import("../src/llm.js");
const { withUsage, currentUsage } = await import("../src/usage.js");

async function* reply(text: string, finish = "stop", usage?: { prompt_tokens: number; completion_tokens: number }) {
  yield { choices: [{ delta: { content: text }, finish_reason: null }] };
  yield { choices: [{ delta: {}, finish_reason: finish }] };
  if (usage) yield { choices: [], usage };
}

describe("model calls", () => {
  beforeEach(() => create.mockReset());

  it("streams every Adesso call (non-streamed generations over ~80s get a gateway 502)", async () => {
    create.mockImplementation(() => reply("APPROACH: x"));
    await generatePlanText("t", "b", "", false);
    await generateSolution("t", "b", "").catch(() => {});
    for (const [args] of create.mock.calls) expect(args).toMatchObject({ stream: true });
  });

  it("gives plans and code enough room for reasoning plus whole files", async () => {
    create.mockImplementation(() => reply("APPROACH: x"));
    await generatePlanText("t", "b", "", false);
    await generateSolution("t", "b", "").catch(() => {});
    const [plan, code] = create.mock.calls.map(([a]) => a.max_tokens);
    expect(plan).toBeGreaterThanOrEqual(8000); // 3000 truncated real plans
    expect(code).toBeGreaterThanOrEqual(32000); // 14000 truncated src/llm.ts rewrites
  });

  it("raises a typed error for a truncated plan (was an 'unexpected', retried failure)", async () => {
    create.mockImplementation(() => reply("APPROACH: half", "length"));
    await expect(generatePlanText("t", "b", "", false)).rejects.toBeInstanceOf(TruncatedResponseError);
  });

  it("records token usage from the final stream chunk", async () => {
    create.mockImplementation(() => reply("APPROACH: x", "stop", { prompt_tokens: 1200, completion_tokens: 300 }));
    const u = await withUsage(async () => (await generatePlanText("t", "b", "", false), currentUsage()));
    expect(create.mock.calls[0][0]).toMatchObject({ stream_options: { include_usage: true } });
    expect(u).toMatchObject({ inputTokens: 1200, outputTokens: 300, calls: 1, reported: true });
  });
});

describe("caller workflows", () => {
  const template = fs.readFileSync("docs/github-action/luci-bot.yml", "utf-8");
  const own = fs.readFileSync(".github/workflows/luci-bot-issues.yml", "utf-8");

  it("listen for merged PRs so split parts advance", () => {
    for (const wf of [template, own]) {
      expect(wf).toMatch(/pull_request:\s*\n\s*types: \[closed\]/);
      expect(wf).toContain("github.event.pull_request.merged");
    }
  });

  it("never share a concurrency group between PR #N and issue #N", () => {
    for (const wf of [template, own]) {
      expect(wf).toContain("format('pr-{0}', github.event.pull_request.number)");
    }
  });

  it("this repo's caller matches the published template", () => {
    const norm = (s: string) => s.replace(/bot-username: .*/, "").replace(/^#.*\n/gm, "").replace(/^name: .*\n/m, "");
    expect(norm(own)).toBe(norm(template));
  });
});
