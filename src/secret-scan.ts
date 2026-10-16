// ---------------------------------------------------------------------------
// Brief 13: Content-level output validation — secret scanning
// ---------------------------------------------------------------------------
// scanForSecrets(content) scans file content for common secret patterns.
// Returns findings with line numbers. Secrets are never echoed.
// ---------------------------------------------------------------------------

export interface SecretFinding {
  line: number;
  type: string;
  pattern: string;
}

export interface ScanOptions {
  allowlist?: RegExp[];
}

const DEFAULT_OPTIONS: ScanOptions = {
  allowlist: [],
};

  // Patterns — order matters: most specific patterns first
  const PATTERNS: Array<{ type: string; pattern: RegExp }> = [
    // GitHub tokens (most specific first)
    { type: "GitHub PAT", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9_]{59,}/ },
    { type: "GitHub App token", pattern: /\bgithub_app_[A-Za-z0-9_]{36,}/ },
    { type: "GitHub OAuth", pattern: /\bgho_[A-Za-z0-9]{36,}/ },
    { type: "GitHub token", pattern: /\bgh[pops]_[A-Za-z0-9_]{36,}/ },
    { type: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}/ },
    { type: "AWS Secret Key", pattern: /(?<=aws_secret_access_key\s*=\s*)[A-Za-z0-9/+=]{40}/ },
    { type: "Private key", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
    // Generic API keys / secrets / passwords
    { type: "API key", pattern: /\bapi[_-]?key\s*[:=]\s*['"][^'"]{8,}/i },
    { type: "Secret", pattern: /\bsecret\s*[:=]\s*['"][^'"]{8,}/i },
    { type: "Password", pattern: /\bpassword\s*[:=]\s*['"][^'"]{4,}/i },
    // Generic bearer tokens
    { type: "Bearer token", pattern: /\bearer\s+[A-Za-z0-9\-._~+\/]{20,}={0,2}/ },
  ];

function shouldAllow(content: string, line: number, options: ScanOptions): boolean {
  for (const regex of options.allowlist ?? []) {
    if (regex.test(content)) return true;
  }
  return false;
}

function isHighEntropy(s: string): boolean {
  if (s.length < 12) return false;
  // Skip env var names (contain _ or .) which naturally have high entropy
  if (s.includes("_") || s.includes(".")) return false;
  // Skip quoted strings (likely template vars or config)
  if (s.startsWith('"') || s.startsWith("'")) return false;
  // Shannon entropy
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy > 3.5;
}

export function scanForSecrets(
  content: string,
  opts?: ScanOptions
): SecretFinding[] {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (shouldAllow(content, i, options)) continue;

    // Skip lines that look like legitimate code patterns (e.g. placeholder docs)
    if (line.match(/\$\{[A-Z_]+\}/) || line.match(/\%s/)) continue;

    for (const { type, pattern } of PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ line: i + 1, type, pattern: pattern.toString() });
        break; // one finding per line
      }
    }
  }

  // Check for high-entropy strings (potential secrets)
  for (let i = 0; i < lines.length; i++) {
    if (shouldAllow(content, i, options)) continue;
    const words = lines[i].split(/\s+/);
    for (const word of words) {
      // Skip if already flagged
      if (findings.some((f) => f.line === i + 1)) break;
      if (isHighEntropy(word) && word.length > 20 && word.length < 200) {
        // Only flag if it looks like a token (alphanumeric + limited special chars)
        if (/^[A-Za-z0-9\-._~+/+=]{20,}$/.test(word)) {
          findings.push({
            line: i + 1,
            type: "High-entropy string (possible secret)",
            pattern: "entropy > 3.5",
          });
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Redaction — never echo secrets
// ---------------------------------------------------------------------------

export function redactFinding(finding: SecretFinding): string {
  return `Line ${finding.line}: [${finding.type}] — secret redacted`;
}

export function redactReport(findings: SecretFinding[]): string {
  return findings.map(redactFinding).join("\n") || "No secrets detected";
}
