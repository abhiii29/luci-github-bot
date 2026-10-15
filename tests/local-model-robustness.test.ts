import { describe, it, expect } from "vitest";
import {
  validateDecomposition,
  stripThinkingTags,
  stripMarkdownFences,
} from "../src/llm.js";
import type { Subtask } from "../src/types.js";

describe("validateDecomposition", () => {
  const baseSubtask: Subtask = {
    id: "s1",
    description: "Test subtask",
    files: ["src/a.ts"],
    dependencies: [],
  };

  it("returns no errors/warnings for valid subtasks", () => {
    const { errors, warnings } = validateDecomposition([baseSubtask], 12, 20);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("rejects too many subtasks", () => {
    const subtasks = Array.from({ length: 13 }, (_, i) => ({
      ...baseSubtask,
      id: `s${i}`,
      files: [`src/${i}.ts`],
    }));
    const { errors } = validateDecomposition(subtasks, 12, 20);
    expect(errors).toContain("Too many subtasks (13, max 12)");
  });

  it("rejects too many files per subtask", () => {
    const files = Array.from({ length: 21 }, (_, i) => `src/file${i}.ts`);
    const { errors } = validateDecomposition([{ ...baseSubtask, files }], 12, 20);
    expect(errors).toContain("Subtask s1 has 21 files (max 20)");
  });

  it("rejects duplicate subtask ids", () => {
    const { errors } = validateDecomposition([
      { ...baseSubtask, id: "dup" },
      { ...baseSubtask, id: "dup", files: ["src/b.ts"] },
    ], 12, 20);
    expect(errors).toContain("Duplicate subtask id: dup");
  });

  it("rejects self-dependency", () => {
    const { errors } = validateDecomposition([
      { ...baseSubtask, id: "self", dependencies: ["self"] },
    ], 12, 20);
    expect(errors).toContain("Subtask self has self-dependency");
  });

  it("rejects unknown dependencies", () => {
    const { errors } = validateDecomposition([
      { ...baseSubtask, id: "st1", dependencies: ["nonexistent"] },
    ], 12, 20);
    expect(errors).toContain("Subtask st1 depends on unknown id: nonexistent");
  });

  it("detects dependency cycles", () => {
    const { errors } = validateDecomposition([
      { ...baseSubtask, id: "a", files: ["a.ts"], dependencies: ["b"] },
      { ...baseSubtask, id: "b", files: ["b.ts"], dependencies: ["a"] },
    ], 12, 20);
    expect(errors).toContain("Subtask dependency cycle detected");
  });

  it("warns on non-normalized file paths", () => {
    const { warnings } = validateDecomposition([
      { ...baseSubtask, id: "st1", files: ["src/file with spaces.ts"] },
    ], 12, 20);
    expect(warnings).toContain("Subtask st1 has non-normalized file path: src/file with spaces.ts");
  });
});

describe("stripThinkingTags", () => {
  it("removes think tags with content", () => {
    const input = 'Let me think<think>\n\nHmm, let me consider\n</think>\nHere is the answer';
    const result = stripThinkingTags(input);
    expect(result).not.toContain("<think>");
    expect(result).not.toContain("</think>");
    expect(result).toContain("Here is the answer");
  });

  it("removes think tags without content", () => {
    const input = "Before<think></think>After";
    const result = stripThinkingTags(input);
    expect(result).toBe("BeforeAfter");
  });

  it("handles multiple think blocks", () => {
    const input = "First<think>one</think>Middle<think>two</think>End";
    const result = stripThinkingTags(input);
    expect(result).toBe("FirstMiddleEnd");
  });

  it("removes XML declaration lines", () => {
    const input = '<?xml version="1.0"?>\n<think>content</think>\nResult';
    const result = stripThinkingTags(input);
    expect(result).not.toContain("<?xml");
    expect(result).toContain("Result");
  });
});

describe("stripMarkdownFences", () => {
  it("strips json markdown fences", () => {
    const input = "```json\n{\n  \"key\": \"value\"\n}\n```";
    const result = stripMarkdownFences(input);
    expect(result).toBe('{\n  "key": "value"\n}');
  });

  it("strips plain markdown fences", () => {
    const input = "```\nconst x = 1;\n```";
    const result = stripMarkdownFences(input);
    expect(result).toBe("const x = 1;");
  });

  it("handles mixed content with fences", () => {
    const input = "Some text\n```json\n{\n  \"a\": 1\n}\n```\nMore text";
    const result = stripMarkdownFences(input);
    expect(result).not.toContain("```");
  });

  it("returns original text when no fences present", () => {
    const input = "No fences here\njust plain text";
    const result = stripMarkdownFences(input);
    expect(result).toBe(input);
  });
});
