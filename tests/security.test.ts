import { describe, it, expect } from "vitest";
import { redact, addSecret, getConfiguredSecrets } from "../src/redact.js";

describe("redact", () => {
  it("masks GitHub PAT patterns (ghp_, github_pat_, gho_, ghs_, ghr_)", () => {
    const text = "Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12345 and github_pat_abcdefghijklmnop12345678";
    const result = redact(text);
    expect(result).not.toContain("ghp_ABCDEF");
    expect(result).not.toContain("github_pat_abcdefghijklmnop");
    expect(result).toContain("***");
  });

  it("masks bearer tokens", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const result = redact(text);
    expect(result).toContain("***");
  });

  it("masks token in URLs", () => {
    const text = "https://user:ghp_SECRET@github.com/api";
    const result = redact(text);
    expect(result).toContain("user:***@github.com");
  });

  it("masks configured secrets", () => {
    addSecret("my-webhook-secret-123");
    const text = "secret: my-webhook-secret-123 is here";
    const result = redact(text);
    expect(result).not.toContain("my-webhook-secret-123");
    expect(result).toContain("my-***");
    // Clean up
    getConfiguredSecrets().clear();
  });

  it("returns original text when no secrets found", () => {
    const text = "No secrets in this plain text";
    expect(redact(text)).toBe(text);
  });
});
