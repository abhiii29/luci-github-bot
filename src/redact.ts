/** Mask GitHub tokens and other secret patterns in strings. */
const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /gho_[A-Za-z0-9]{36,}/g,
  /ghs_[A-Za-z0-9]{36,}/g,
  /ghr_[A-Za-z0-9]{36,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /https:\/\/[^:]+:([A-Za-z0-9\-._~+/]+=*)@/g,
];

/** Known secret env var names for config-based redaction. */
const SECRET_NAMES = new Set([
  "GITHUB_TOKEN",
  "WEBHOOK_SECRET",
  "ADASSO_API_KEY",
  "ADASSO_API_KEY_FILE",
  "ADASSO_BASE_URL",
  "ADASSO_MODEL",
  "NGROK_AUTHTOKEN",
  "API_TOKEN",
]);

const configuredSecrets: Set<string> = new Set();

export function addSecret(value: string): void {
  if (value) configuredSecrets.add(value);
}

export function getConfiguredSecrets(): Set<string> {
  return configuredSecrets;
}

/** Redact secrets from text. Returns the redacted string. */
export function redact(text: string): string {
  let result = text;

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.includes("://")) {
        const urlMatch = match.match(/(https:\/\/[^:]+:)([A-Za-z0-9\-._~+/]+=*)(@)/);
        if (urlMatch) return urlMatch[1] + "***" + urlMatch[3];
      }
      return match.slice(0, 8) + "***";
    });
  }

  // Check configured secrets
  for (const secret of configuredSecrets) {
    if (secret.length > 3) {
      const masked = secret.slice(0, 3) + "***";
      result = result.split(secret).join(masked);
    }
  }

  return result;
}
