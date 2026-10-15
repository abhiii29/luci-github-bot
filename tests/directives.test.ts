import { describe, it, expect } from "vitest";
import {
  parseDirectiveBlock,
  parseDirectiveLine,
  parseDirectives,
  hasLocalModelDirective,
  parseLocalModelDirective,
  normalizeToJobOptions,
  LOCAL_MODEL_TRIGGER,
} from "../src/directives.js";

describe("parseDirectiveLine", () => {
  it("parses key=value directives", () => {
    const result = parseDirectiveLine("/luci model=remote base=develop");
    expect(result.directives).toEqual({ model: "remote", base: "develop" });
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("parses flags", () => {
    const result = parseDirectiveLine("/luci plan-only dry-run no-pr");
    expect(result.directives).toEqual({
      "plan-only": true,
      "dry-run": true,
      "no-pr": true,
    });
  });

  it("parses quoted values with spaces", () => {
    const result = parseDirectiveLine('/luci base="my feature branch"');
    expect(result.directives).toEqual({ base: "my feature branch" });
  });

  it("parses single-quoted values", () => {
    const result = parseDirectiveLine("/luci base='my-branch'");
    expect(result.directives).toEqual({ base: "my-branch" });
  });

  it("rejects malformed /luci directives", () => {
    const result = parseDirectiveLine("/luci");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.directives).toEqual({});
  });
});

describe("parseDirectiveBlock", () => {
  it("parses a single /luci block from body text", () => {
    const text = "Some issue description\n\n/luci model=local plan-only\n\nMore text.";
    const result = parseDirectiveBlock(text);
    expect(result.directives).toEqual({ model: "local", "plan-only": true });
  });

  it("merges multiple /luci blocks (later wins for same key)", () => {
    const text = `/luci model=remote
/luci model=local dry-run`;
    const result = parseDirectiveBlock(text);
    expect(result.directives.model).toBe("local");
    expect(result.directives["dry-run"]).toBe(true);
  });

  it("returns empty for null/undefined input", () => {
    expect(parseDirectiveBlock(null as any)).toEqual({
      directives: {},
      warnings: [],
      errors: [],
    });
    expect(parseDirectiveBlock(undefined as any)).toEqual({
      directives: {},
      warnings: [],
      errors: [],
    });
    expect(parseDirectiveBlock("")).toEqual({
      directives: {},
      warnings: [],
      errors: [],
    });
  });

  it("collects unknown keys as warnings and removes them", () => {
    const result = parseDirectiveBlock("/luci model=local evil=hack");
    expect(result.directives.model).toBe("local");
    expect(result.directives.evil).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("evil"))).toBe(true);
  });

  it("handles injection-looking text safely", () => {
    const text = '/luci model=remote base="; rm -rf /" files=*.ts';
    const result = parseDirectiveBlock(text);
    expect(result.directives.model).toBe("remote");
    expect(result.directives.base).toBe("; rm -rf /");
    expect(result.directives.files).toBe("*.ts");
  });

  it("handles duplicate keys — last value wins", () => {
    const text = "/luci model=remote\n/luci model=local";
    const result = parseDirectiveBlock(text);
    expect(result.directives.model).toBe("local");
  });

  it("handles huge input without crashing", () => {
    const hugeText = "/luci model=remote\n".repeat(10000);
    const result = parseDirectiveBlock(hugeText);
    expect(result.directives.model).toBe("remote");
  });
});

describe("parseDirectives (top-level)", () => {
  it("combines @local-model from title with /luci from body", () => {
    const result = parseDirectives(
      "@local-model add logging",
      "/luci base=main",
      true
    );
    expect(result.jobOptions.model).toBe("local");
    expect(result.jobOptions.baseBranch).toBe("main");
  });

  it("body directives override title @local-model", () => {
    const result = parseDirectives(
      "@local-model add logging",
      "/luci model=local plan-only",
      true
    );
    expect(result.jobOptions.model).toBe("local");
    expect(result.jobOptions.planOnly).toBe(true);
  });

  it("ignores directives when author is not a collaborator", () => {
    const result = parseDirectives(
      "@local-model add logging",
      "/luci model=local base=main",
      false
    );
    expect(result.jobOptions.model).toBe("remote");
    expect(result.jobOptions.baseBranch).toBe("");
    expect(
      result.jobOptions.warnings.some((w) =>
        w.includes("not a repo collaborator")
      )
    ).toBe(true);
  });

  it("respects collaborator directives", () => {
    const result = parseDirectives(
      "@local-model add logging",
      "/luci model=local base=develop plan-only",
      true
    );
    expect(result.jobOptions.model).toBe("local");
    expect(result.jobOptions.baseBranch).toBe("develop");
    expect(result.jobOptions.planOnly).toBe(true);
  });
});

describe("normalizeToJobOptions", () => {
  it("defaults to remote model when no directive set", () => {
    const options = normalizeToJobOptions(
      { directives: {}, warnings: [], errors: [] },
      [],
      true
    );
    expect(options.model).toBe("remote");
    expect(options.warnings).toEqual([]);
  });

  it("parses file hints from comma-separated list", () => {
    const result = parseDirectiveBlock("/luci files=a.ts,b.ts,c.ts");
    const options = normalizeToJobOptions(result, [], true);
    expect(options.fileHints).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("collects unknown key warnings", () => {
    const result = parseDirectiveBlock("/luci model=local spam=eggs");
    const options = normalizeToJobOptions(result, [], true);
    expect(options.warnings.some((w) => w.includes("spam"))).toBe(true);
  });

  it("empty file hints when files= not provided", () => {
    const result = parseDirectiveBlock("/luci model=local");
    const options = normalizeToJobOptions(result, [], true);
    expect(options.fileHints).toEqual([]);
  });
});

describe("@local-model detection", () => {
  it("detects @local-model in title first line", () => {
    expect(hasLocalModelDirective("@local-model fix bug")).toBe(true);
  });

  it("does not detect @local-model in body lines after first", () => {
    expect(
      hasLocalModelDirective("First line only\n@local-model here")
    ).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(hasLocalModelDirective("")).toBe(false);
    expect(hasLocalModelDirective(null as any)).toBe(false);
  });

  it("parseLocalModelDirective extracts model=local", () => {
    const result = parseLocalModelDirective("@local-model fix this");
    expect(result.directives).toEqual({ model: "local" });
  });

  it("parseLocalModelDirective returns empty when not present", () => {
    const result = parseLocalModelDirective("no directive here");
    expect(result.directives).toEqual({});
  });
});

describe("LOCAL_MODEL_TRIGGER regex", () => {
  it("matches @local-model prefix with content", () => {
    expect(LOCAL_MODEL_TRIGGER.test("@local-model add rate limiting")).toBe(true);
  });

  it("does not match @local-model without space", () => {
    expect(LOCAL_MODEL_TRIGGER.test("@local-modeladd text")).toBe(false);
  });
});
