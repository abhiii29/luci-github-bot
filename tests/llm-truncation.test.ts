import { describe, it, expect, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

async function* chunks(parts: string[], finish: string) {
  for (const p of parts) yield { choices: [{ delta: { content: p }, finish_reason: null }] };
  yield { choices: [{ delta: {}, finish_reason: finish }] };
}

vi.mock("../src/config.js", async (orig) => ({
  ...(await orig<typeof import("../src/config.js")>()),
  getAdessoApiKey: async () => "k",
}));

describe("adesso streaming", () => {
  it("rejects a response cut off at max_tokens", async () => {
    create.mockResolvedValue(chunks(["FILE: src/a.ts\n", "export const"], "length"));
    const { generateSolution } = await import("../src/llm.js");
    const res = await generateSolution("t", "b", "");
    expect(res.success).toBe(false);
    expect(res.error).toContain("truncated");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
  });
});
