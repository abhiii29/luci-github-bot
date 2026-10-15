import { describe, it, expect } from "vitest";
import { validateSolution, SolutionValidationError } from "../src/solution-validator.js";

function result(res: ReturnType<typeof validateSolution>) {
  return res;
}

// --- Branch name validation ---

describe("validateSolution - branch name", () => {
  it("rejects empty branch name", () => {
    const res = result(validateSolution("", "msg", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.some(e => e.field === "branchName")).toBe(true);
  });

  it("rejects branch with uppercase", () => {
    const res = result(validateSolution("Fix/bug", "msg", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects branch starting with dash or dot", () => {
    expect(result(validateSolution("-bad/name", "msg", [{ path: "a.ts", content: "x", operation: "create" }])).valid).toBe(false);
    expect(result(validateSolution(".bad/name", "msg", [{ path: "a.ts", content: "x", operation: "create" }])).valid).toBe(false);
  });

  it("rejects branch with dots in sequence", () => {
    expect(result(validateSolution("bot/foo..bar", "msg", [{ path: "a.ts", content: "x", operation: "create" }])).valid).toBe(false);
    expect(result(validateSolution("bot/foo//bar", "msg", [{ path: "a.ts", content: "x", operation: "create" }])).valid).toBe(false);
  });

  it("accepts valid branch names", () => {
    const validNames = ["bot/fix-1", "bot/feature_x", "bot/v1.2", "bot/a-b_c.d"];
    for (const name of validNames) {
      const res = result(validateSolution(name, "msg", [{ path: "a.ts", content: "x", operation: "create" }]));
      expect(res.valid, `branch "${name}" should be valid`).toBe(true);
    }
  });

  it("rejects branch over 61 chars", () => {
    const longName = "bot/" + "a".repeat(60);
    expect(result(validateSolution(longName, "msg", [{ path: "a.ts", content: "x", operation: "create" }])).valid).toBe(false);
  });
});

// --- Commit message validation ---

describe("validateSolution - commit message", () => {
  it("rejects empty commit message", () => {
    const res = result(validateSolution("bot/x", "", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects multiline commit message", () => {
    const res = result(validateSolution("bot/x", "fix\nsecond line", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors[0].reason).toContain("single line");
  });

  it("rejects commit message over 100 chars", () => {
    const longMsg = "fix: " + "x".repeat(96); // "fix: " (5) + 96 = 101 chars
    const res = result(validateSolution("bot/x", longMsg, [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("strips control characters from commit message", () => {
    const res = result(validateSolution("bot/x", "fix\x01\x02", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(true);
  });

  it("accepts valid single-line commit message under 100 chars", () => {
    const res = result(validateSolution("bot/x", "fix: apply changes", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(true);
  });
});

// --- Path validation ---

describe("validateSolution - paths", () => {
  it("rejects paths with ..", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "foo/../../etc/passwd", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors[0].reason).toContain("traversal");
  });

  it("rejects absolute paths", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "/etc/passwd", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects paths with .git/", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "src/.git/config", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects paths with trailing slash", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "dir/", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects .lock files", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "package.lock", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects denied workflow patterns", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: ".github/workflows/ci.yml", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects denied .env files", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: ".env.production", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects denied id_rsa files", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "keys/id_rsa", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("normalizes leading slashes and ./", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "./src/app.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(true);
  });

  it("rejects paths with NUL bytes", () => {
    const res = result(validateSolution("bot/x", "msg", [{ path: "file\x00.txt", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });
});

// --- File limits ---

describe("validateSolution - file limits", () => {
  it("rejects empty files array", () => {
    const res = result(validateSolution("bot/x", "msg", []));
    expect(res.valid).toBe(false);
  });

  it("rejects more than max files (default 20)", () => {
    const files = Array.from({ length: 21 }, (_, i) => ({
      path: `file${i}.ts`, content: "x", operation: "create" as const,
    }));
    const res = result(validateSolution("bot/x", "msg", files));
    expect(res.valid).toBe(false);
  });

  it("accepts exactly max files (20)", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `file${i}.ts`, content: "x", operation: "create" as const,
    }));
    const res = result(validateSolution("bot/x", "msg", files));
    expect(res.valid).toBe(true);
  });

  it("rejects when total content exceeds 1MB", () => {
    const bigContent = "x".repeat(1_048_577);
    const res = result(validateSolution("bot/x", "msg", [{ path: "big.ts", content: bigContent, operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects duplicate paths", () => {
    const res = result(validateSolution("bot/x", "msg", [
      { path: "a.ts", content: "v1", operation: "create" },
      { path: "a.ts", content: "v2", operation: "update" },
    ]));
    expect(res.valid).toBe(false);
  });
});

// --- Injection tests (validator catches structure attacks; worker.sh handles shell escaping) ---

describe("validateSolution - injection prevention (structure)", () => {
  const injectionBranches = [
    "`id`",
    "$(id)",
    '"; rm -rf /',
    "${PS1}",
    "$(cat /etc/passwd)",
  ];

  it.each(injectionBranches)("rejects shell-injection branch name: %s", (branch) => {
    const res = result(validateSolution(branch, "msg", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("accepts backticks in commit message (worker.sh must escape for shell)", () => {
    const res = result(validateSolution("bot/safe", "`rm -rf /`", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(true);
  });

  it("accepts backticks in file path (worker.sh must escape for shell)", () => {
    const res = result(validateSolution("bot/safe", "msg", [{ path: "file`id`.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(true);
  });

  it("rejects path traversal in branch name", () => {
    const res = result(validateSolution("bot/foo/../../../etc/passwd", "msg", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });

  it("rejects null bytes in branch name", () => {
    const res = result(validateSolution("bot\x00/foo", "msg", [{ path: "a.ts", content: "x", operation: "create" }]));
    expect(res.valid).toBe(false);
  });
});
