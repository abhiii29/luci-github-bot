import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  getConfig: () => ({
    ollamaBaseUrl: "http://ollama.test",
    ollamaModel: "m",
    ollamaDecompositionTimeoutMs: 5_000,
    ollamaSubtaskTimeoutMs: 5_000,
  }),
  getAdessoApiKey: async () => "k",
}));

const { generateSolutionWithDecomposition } = await import("../../src/llm.js");

const decomposition = JSON.stringify({
  branch_name: "fix/issue-1-two-steps",
  commit_message: "Two steps on one file",
  subtasks: [
    { id: "A", description: "add function a", files: ["src/app.ts"], dependencies: [] },
    { id: "B", description: "add function b", files: ["src/app.ts"], dependencies: [] },
  ],
  needs_clarification: null,
});

const solutionFor = (content: string) =>
  `BRANCH: fix/issue-1-two-steps\nCOMMIT: step\n\nFILE_START: src/app.ts\nOPERATION: update\n${content}\nFILE_END`;

let executionPrompts: string[] = [];
let contentRequests: string[] = [];

beforeEach(() => {
  executionPrompts = [];
  contentRequests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      contentRequests.push(url);
      return new Response(JSON.stringify({ content: Buffer.from("// original\n").toString("base64"), encoding: "base64" }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    const user = body.messages.find((m: any) => m.role === "user").content as string;
    let content: string;
    if (/subtasks/i.test(body.messages[0].content) && !/SUBTASK/.test(user)) {
      content = decomposition;
    } else {
      executionPrompts.push(user);
      content = executionPrompts.length === 1 ? solutionFor("// original\nexport const a = 1;") : solutionFor("// original\nexport const a = 1;\nexport const b = 2;");
    }
    return new Response(JSON.stringify({ message: { content }, done_reason: "stop" }), { status: 200 });
  });
});

describe("local pipeline: file contents and same-file subtasks", () => {
  it("fetches current file contents using the repo name, not the prompt context", async () => {
    await generateSolutionWithDecomposition("t", "b", "--- FILE: x ---\nlots of prompt text", [], "ghp_token", "acme/widgets");
    expect(contentRequests.length).toBeGreaterThan(0);
    expect(contentRequests.every((u) => u.startsWith("https://api.github.com/repos/acme/widgets/contents/"))).toBe(true);
    expect(executionPrompts[0]).toContain("// original");
  });

  it("runs subtasks that touch the same file in sequence, the second seeing the first's output", async () => {
    const result = await generateSolutionWithDecomposition("t", "b", "ctx", [], "ghp_token", "acme/widgets");
    expect(executionPrompts).toHaveLength(2);
    expect(executionPrompts[1]).toContain("export const a = 1;");
    expect(result.files.find((f) => f.path === "src/app.ts")?.content).toContain("export const b = 2;");
    expect(result.files.find((f) => f.path === "src/app.ts")?.content).toContain("export const a = 1;");
  });
});
