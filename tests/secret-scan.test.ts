import { describe, it, expect } from "vitest";
import { scanForSecrets, redactFinding, redactReport } from "../src/secret-scan.js";

describe("secret-scan: GitHub tokens", () => {
  it("detects ghp_ token", () => {
    const content = `const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "GitHub token")).toBe(true);
  });

  it("detects github_pat_ token", () => {
    const content = `token: "github_pat_11ABCDEFghijklmnopqrstuv_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmN"`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "GitHub PAT")).toBe(true);
  });

  it("detects gho_ token", () => {
    const content = `gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij01`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "GitHub OAuth")).toBe(true);
  });
});

describe("secret-scan: AWS credentials", () => {
  it("detects AWS access key", () => {
    const content = `aws_access_key_id = AKIAIOSFODNN7EXAMPLE`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "AWS Access Key")).toBe(true);
  });
});

describe("secret-scan: private keys", () => {
  it("detects PEM private key header", () => {
    const content = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "Private key")).toBe(true);
  });

  it("detects plain private key header", () => {
    const content = `-----BEGIN PRIVATE KEY-----`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "Private key")).toBe(true);
  });
});

describe("secret-scan: generic patterns", () => {
  it("detects api_key assignment", () => {
    const content = `api_key = "my_super_secret_key_12345"`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "API key")).toBe(true);
  });

  it("detects secret assignment", () => {
    const content = `secret = "this_is_a_real_secret"`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "Secret")).toBe(true);
  });

  it("detects password assignment", () => {
    const content = `password = "hunter2_short"`;
    const findings = scanForSecrets(content);
    expect(findings.some((f) => f.type === "Password")).toBe(true);
  });
});

describe("secret-scan: false positives", () => {
  it("does not flag placeholder env vars", () => {
    const content = `const token = process.env.GITHUB_TOKEN;`;
    const findings = scanForSecrets(content);
    expect(findings).toHaveLength(0);
  });

  it("does not flag template variables", () => {
    const content = '"token": "${API_KEY}"';
    const findings = scanForSecrets(content);
    expect(findings).toHaveLength(0);
  });

  it("does not flag %s placeholders", () => {
    const content = `const x = "Hello %s World";`;
    const findings = scanForSecrets(content);
    expect(findings).toHaveLength(0);
  });
});

describe("secret-scan: line numbers", () => {
  it("reports correct line numbers", () => {
    const content = `line1\nline2\napi_key = "secret_val_here"\nline4`;
    const findings = scanForSecrets(content);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].line).toBe(3);
  });
});

describe("secret-scan: allowlist", () => {
  it("allows matching lines", () => {
    const content = `api_key = "test_fixture_key_12345"`;
    const findings = scanForSecrets(content, {
      allowlist: [/test_fixture/],
    });
    expect(findings).toHaveLength(0);
  });
});

describe("secret-scan: redaction", () => {
  it("redacts finding content", () => {
    const finding = { line: 5, type: "GitHub token", pattern: "ghp_" };
    const redacted = redactFinding(finding);
    expect(redacted).toContain("Line 5");
    expect(redacted).toContain("[GitHub token]");
    expect(redacted).toContain("redacted");
    expect(redacted).not.toContain("ghp_");
  });

  it("reports no secrets when empty", () => {
    expect(redactReport([])).toBe("No secrets detected");
  });

  it("lists multiple findings", () => {
    const findings = [
      { line: 1, type: "AWS Access Key", pattern: "AKIA" },
      { line: 3, type: "Private key", pattern: "PRIVATE KEY" },
    ];
    const redacted = redactReport(findings);
    expect(redacted).toContain("Line 1");
    expect(redacted).toContain("Line 3");
  });
});

describe("secret-scan: false-positive check on repo source", () => {
  it("does not flag TypeScript source files", () => {
    // Real TypeScript source from the repo
    const tsSource = `import { getConfig } from "./config.js";
import { CodeGenerationResult } from "./llm.js";

export class DockerWorker {
  async processIssue(event: GitHubIssueEvent, solution: CodeGenerationResult) {
    const config = getConfig();
    const token = config.githubToken;
    return { success: true };
  }
}`;
    const findings = scanForSecrets(tsSource);
    // Should have 0 findings on clean TypeScript source
    expect(findings).toHaveLength(0);
  });

  it("does not flag config with env vars", () => {
    const configSource = `export function getConfig(): Config {
  const env = loadEnv();
  return {
    githubToken: env.GITHUB_TOKEN ?? "",
    adassoBaseUrl: env.ADASSO_BASE_URL,
    adassoApiKeyFile: env.ADASSO_API_KEY_FILE ?? "~/.config/opencode/adesso.key",
  };
}`;
    const findings = scanForSecrets(configSource);
    expect(findings).toHaveLength(0);
  });
});
