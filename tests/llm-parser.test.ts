import { describe, it, expect } from "vitest";
import {
  isLocalModelTrigger,
  extractLocalPrompt,
  parseLLMResponse,
  parseDecompositionResponse,
} from "../src/llm.js";

// ---------------------------------------------------------------------------
// isLocalModelTrigger
// ---------------------------------------------------------------------------

describe("isLocalModelTrigger", () => {
  it("returns true when @local-model is in the title", () => {
    expect(isLocalModelTrigger("@local-model add rate limiting", "body")).toBe(true);
  });

  it("returns true when @local-model is in the body", () => {
    expect(isLocalModelTrigger("Title only", "@local-model fix bug")).toBe(true);
  });

  it("returns false when @local-model is absent from both", () => {
    expect(isLocalModelTrigger("Title only", "body text")).toBe(false);
  });

  it("returns false with empty strings", () => {
    expect(isLocalModelTrigger("", "")).toBe(false);
  });

  it("returns false when @local-model is not followed by space", () => {
    expect(isLocalModelTrigger("@local-modelx something", "")).toBe(false);
  });

  it("returns true when @local-model appears anywhere in the body (multiline)", () => {
    expect(
      isLocalModelTrigger(
        "Title",
        "Some text\n@local-model\nMore text"
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractLocalPrompt
// ---------------------------------------------------------------------------

describe("extractLocalPrompt", () => {
  it("extracts text after @local-model from combined title+body", () => {
    const result = extractLocalPrompt("@local-model add feature", "");
    expect(result).toBe("add feature");
  });

  it("extracts from body when title has no trigger", () => {
    const result = extractLocalPrompt("Title", "hello\n@local-model fix x");
    expect(result).toBe("fix x");
  });

  it("returns body without trigger", () => {
    const result = extractLocalPrompt("Title", "plain description");
    expect(result).toBe("plain description");
  });

  it("returns empty string when both are empty (empty string is not undefined)", () => {
    const result = extractLocalPrompt("", "");
    expect(result).toBe("");
  });

  it("returns body when undefined", () => {
    const result = extractLocalPrompt("Title", undefined);
    expect(result).toBe("(no description)");
  });
});

// ---------------------------------------------------------------------------
// parseLLMResponse
// ---------------------------------------------------------------------------

describe("parseLLMResponse", () => {
  it("parses a valid multi-file response", () => {
    const content = [
      "BRANCH: fix/issue-42",
      "COMMIT: Add rate limiting",
      "",
      "FILE_START: src/rate-limiter.ts",
      "OPERATION: create",
      "export function rateLimit() {}",
      "FILE_END",
      "",
      "FILE_START: src/app.ts",
      "OPERATION: update",
      "import { rateLimit } from './rate-limiter.js';",
      "FILE_END",
    ].join("\n");

    const result = parseLLMResponse(content);
    expect(result.success).toBe(true);
    expect(result.branchName).toBe("fix/issue-42");
    expect(result.commitMessage).toBe("Add rate limiting");
    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe("src/rate-limiter.ts");
    expect(result.files[0].operation).toBe("create");
    expect(result.files[1].path).toBe("src/app.ts");
    expect(result.files[1].operation).toBe("update");
  });

  it("parses with CRLF line endings", () => {
    const content = "BRANCH: fix/1\r\nCOMMIT: test\r\n\r\nFILE_START: a.ts\r\nOPERATION: create\r\ncontent\r\nFILE_END\r\n";
    const result = parseLLMResponse(content);
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toBe("content");
  });

  it("defaults operation to create when not specified", () => {
    const content = [
      "BRANCH: b",
      "COMMIT: c",
      "",
      "FILE_START: x.ts",
      "hello",
      "FILE_END",
    ].join("\n");
    const result = parseLLMResponse(content);
    expect(result.files[0].operation).toBe("create");
  });

  it("returns NEEDS_CLARIFICATION when present", () => {
    const content = [
      "NEEDS_CLARIFICATION: What is the expected behavior?",
      "",
      "BRANCH: x",
      "COMMIT: y",
      "FILE_START: a.ts",
      "FILE_END",
    ].join("\n");
    const result = parseLLMResponse(content);
    expect(result.success).toBe(false);
    expect(result.error).toBe("What is the expected behavior?");
    expect(result.files).toHaveLength(0);
  });

  it("handles duplicate paths (last wins, first removed)", () => {
    const content = [
      "BRANCH: b",
      "COMMIT: c",
      "",
      "FILE_START: a.ts",
      "v1",
      "FILE_END",
      "",
      "FILE_START: a.ts",
      "OPERATION: update",
      "v2",
      "FILE_END",
    ].join("\n");
    const result = parseLLMResponse(content);
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toBe("v2");
    expect(result.files[0].operation).toBe("update");
  });

  it("falls back when FILE regex finds nothing but BRANCH/COMMIT exist", () => {
    const content = "BRANCH: fix/42\nCOMMIT: minimal change\n";
    const result = parseLLMResponse(content);
    expect(result.branchName).toBe("fix/42");
    expect(result.commitMessage).toBe("minimal change");
    // No files and no branch+commit both present... branchName and commitMessage present but files empty
    // parseLLMResponse: "if files.length === 0, fallback; if fallback.files.length === 0 && (!branchName || !commitMessage)"
    // Here branchName="fix/42" and commitMessage="minimal change", so it returns success=false but with branch/commit
    expect(result.success).toBe(false);
  });

  it("generates default commit when branch exists but commit is missing", () => {
    const content = [
      "BRANCH: fix/issue-123",
      "",
      "FILE_START: x.ts",
      "content",
      "FILE_END",
    ].join("\n");
    const result = parseLLMResponse(content);
    expect(result.branchName).toBe("fix/issue-123");
    expect(result.commitMessage).toBe("Apply fix issue-123 changes");
    expect(result.success).toBe(true);
  });

  it("returns error when files parsed but BRANCH/COMMIT missing", () => {
    const content = [
      "FILE_START: x.ts",
      "content",
      "FILE_END",
    ].join("\n");
    const result = parseLLMResponse(content);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Parsed 1 file(s)");
  });

  it("returns error when completely unparseable", () => {
    const result = parseLLMResponse("garbage output from LLM");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not parse BRANCH/COMMIT");
  });

  it("handles nested file paths correctly", () => {
    const content = [
      "BRANCH: b",
      "COMMIT: c",
      "",
      "FILE_START: src/utils/deep/nested.ts",
      "OPERATION: create",
      "export default {};",
      "FILE_END",
    ].join("\n");
    const result = parseLLMResponse(content);
    expect(result.files[0].path).toBe("src/utils/deep/nested.ts");
  });
});

// ---------------------------------------------------------------------------
// parseDecompositionResponse
// ---------------------------------------------------------------------------

describe("parseDecompositionResponse", () => {
  it("parses clean JSON", () => {
    const json = JSON.stringify({
      branch_name: "fix/42",
      commit_message: "Fix thing",
      subtasks: [
        { id: "A", description: "Do A", files: ["a.ts"], dependencies: [] },
        { id: "B", description: "Do B", files: ["b.ts"], dependencies: ["A"] },
      ],
      needs_clarification: null,
    });
    const result = parseDecompositionResponse(json);
    expect(result.branchName).toBe("fix/42");
    expect(result.commitMessage).toBe("Fix thing");
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[1].dependencies).toEqual(["A"]);
  });

  it("parses fenced JSON", () => {
    const content = "```json\n{\"branch_name\":\"b\",\"commit_message\":\"c\",\"subtasks\":[{\"id\":\"1\",\"description\":\"d\",\"files\":[],\"dependencies\":[]}],\"needs_clarification\":null}\n```";
    const result = parseDecompositionResponse(content);
    expect(result.branchName).toBe("b");
    expect(result.subtasks).toHaveLength(1);
  });

  it("returns needsClarification on bad JSON", () => {
    const result = parseDecompositionResponse("not json {{{");
    expect(result.subtasks).toHaveLength(0);
    expect(result.needsClarification).toBe("Failed to parse LLM JSON output for decomposition.");
  });

  it("returns needsClarification when subtasks is missing", () => {
    const result = parseDecompositionResponse(
      JSON.stringify({ branch_name: "b", commit_message: "c" })
    );
    expect(result.needsClarification).toBe("Missing subtasks array in decomposition output.");
  });

  it("returns needsClarification when subtasks is not an array", () => {
    const result = parseDecompositionResponse(
      JSON.stringify({ branch_name: "b", commit_message: "c", subtasks: "not-array" })
    );
    expect(result.needsClarification).toBe("Missing subtasks array in decomposition output.");
  });

  it("handles NEEDS_CLARIFICATION field in output", () => {
    const result = parseDecompositionResponse(
      JSON.stringify({
        branch_name: "b",
        commit_message: "c",
        subtasks: [],
        needs_clarification: "Need more info",
      })
    );
    expect(result.needsClarification).toBe("Need more info");
    expect(result.subtasks).toHaveLength(0);
  });

  it("skips non-object items in subtasks array", () => {
    const result = parseDecompositionResponse(
      JSON.stringify({
        branch_name: "b",
        commit_message: "c",
        subtasks: [null, "string", { id: "1", description: "d", files: [], dependencies: [] }],
        needs_clarification: null,
      })
    );
    expect(result.subtasks).toHaveLength(1);
  });

  it("assigns default id when missing", () => {
    const result = parseDecompositionResponse(
      JSON.stringify({
        branch_name: "b",
        commit_message: "c",
        subtasks: [{ description: "d", files: [], dependencies: [] }],
        needs_clarification: null,
      })
    );
    expect(result.subtasks[0].id).toBe("sub-0");
  });

  it("filters empty file strings", () => {
    const result = parseDecompositionResponse(
      JSON.stringify({
        branch_name: "b",
        commit_message: "c",
        subtasks: [{ id: "1", description: "d", files: ["", "valid.ts", ""], dependencies: [] }],
        needs_clarification: null,
      })
    );
    expect(result.subtasks[0].files).toEqual(["valid.ts"]);
  });
});
