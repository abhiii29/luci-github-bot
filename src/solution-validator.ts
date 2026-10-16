export interface SolutionValidationError {
  field: string;
  value: string;
  reason: string;
}

export interface ValidateSolutionOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  deniedPatterns?: string[];
  maxDeletes?: number;
  protectedFiles?: string[];
  issueKeywords?: string;
  warnSecrets?: boolean;
}

export interface ValidationReport {
  valid: boolean;
  errors: SolutionValidationError[];
  warnings: SolutionValidationError[];
}

const DEFAULT_OPTIONS: Required<ValidateSolutionOptions> = {
  maxFiles: 20,
  maxTotalBytes: 1_048_576, // 1 MB
  deniedPatterns: [
    ".github/workflows/**",
    ".env",
    ".env.*",
    "**/id_rsa",
    "**/id_rsa.pub",
  ],
  maxDeletes: 5,
  protectedFiles: ["README", "LICENSE", "package.json"],
  issueKeywords: "",
  warnSecrets: false,
};

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    // **/foo matches foo at any depth
    if (path === suffix || path.endsWith("/" + suffix)) return true;
    // Also match with glob wildcards in the suffix
    if (suffix.includes("*")) {
      const regex = new RegExp("^" + suffix.replace(/\*/g, "[^/]*") + "$");
      const parts = path.split("/");
      return parts.some(part => regex.test(part));
    }
    return false;
  }
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, "[^/]*") + "$");
    return regex.test(path);
  }
  return path === pattern;
}

function isDenied(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchesPattern(path, pattern)) return true;
  }
  return false;
}

function normalizePath(raw: string): string {
  // Remove leading/trailing whitespace
  let p = raw.trim();
  // Remove leading slash (make relative)
  if (p.startsWith("/")) p = p.slice(1);
  // Remove leading ./
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

function validatePath(path: string): SolutionValidationError | null {
  if (!path) return { field: "path", value: "(empty)", reason: "file path is empty" };

  if (path.startsWith("/")) {
    return { field: "path", value: path, reason: "absolute path not allowed" };
  }

  let p = path.trim();
  while (p.startsWith("./")) p = p.slice(2);

  // Check for NUL bytes
  if (p.includes("\0")) {
    return { field: "path", value: path, reason: "contains NUL byte" };
  }

  // Check for directory traversal
  if (p.includes("..") || p.includes("//")) {
    return { field: "path", value: path, reason: "path traversal detected (.. or //)" };
  }

  // Check for trailing slash
  if (p.endsWith("/")) {
    return { field: "path", value: path, reason: "trailing slash not allowed" };
  }

  // Check for .lock suffix
  if (p.endsWith(".lock")) {
    return { field: "path", value: path, reason: ".lock files not allowed" };
  }

  // Check for .git/ in path
  if (p.includes(".git/") || p.endsWith(".git")) {
    return { field: "path", value: path, reason: ".git paths not allowed" };
  }

  // Check denied patterns
  if (isDenied(p, DEFAULT_OPTIONS.deniedPatterns)) {
    return { field: "path", value: path, reason: "path matches denied pattern" };
  }

  return null;
}

function validateBranchName(name: string): SolutionValidationError | null {
  if (!name) return { field: "branchName", value: "(empty)", reason: "branch name is empty" };
  if (!/^[a-z0-9][a-z0-9._\/-]{0,60}$/.test(name)) {
    return { field: "branchName", value: name, reason: "branch name must start with lowercase alphanumeric, contain only lowercase alphanumeric / . _ - and be ≤61 chars" };
  }
  if (name.includes("..") || name.includes("//")) {
    return { field: "branchName", value: name, reason: "branch name contains .. or //" };
  }
  return null;
}

function validateCommitMessage(msg: string): SolutionValidationError | null {
  if (!msg) return { field: "commitMessage", value: "(empty)", reason: "commit message is empty" };

  // Strip control characters (keep printable ASCII and common whitespace)
  const cleaned = msg.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Must be single line
  const lines = cleaned.split("\n");
  if (lines.length > 1) {
    return { field: "commitMessage", value: msg.slice(0, 80), reason: "commit message must be a single line" };
  }

  // Max 100 chars
  if (cleaned.length > 100) {
    return { field: "commitMessage", value: cleaned.slice(0, 80), reason: `commit message must be ≤100 chars (got ${cleaned.length})` };
  }

  return null;
}

export function validateSolution(
  branchName: string,
  commitMessage: string,
  files: Array<{ path: string; content: string; operation: string }>,
  opts?: ValidateSolutionOptions
): { valid: true } | { valid: false; errors: SolutionValidationError[] } {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const errors: SolutionValidationError[] = [];

  const branchErr = validateBranchName(branchName);
  if (branchErr) errors.push(branchErr);

  const commitErr = validateCommitMessage(commitMessage);
  if (commitErr) errors.push(commitErr);

  if (!files.length) {
    errors.push({ field: "files", value: "(empty)", reason: "no files to apply" });
  }

  if (files.length > options.maxFiles) {
    errors.push({
      field: "files",
      value: `${files.length} files`,
      reason: `exceeds max ${options.maxFiles} files`,
    });
  }

  let totalBytes = 0;
  const seenPaths = new Set<string>();

  for (const file of files) {
    // Check for duplicate paths
    if (seenPaths.has(file.path)) {
      errors.push({
        field: "files",
        value: file.path,
        reason: `duplicate path (${file.path} appears multiple times)`,
      });
    }
    seenPaths.add(file.path);

    // Validate path
    const pathErr = validatePath(file.path);
    if (pathErr) errors.push(pathErr);

    // Track byte size
    totalBytes += new TextEncoder().encode(file.content).byteLength;
  }

  if (totalBytes > options.maxTotalBytes) {
    errors.push({
      field: "files",
      value: `${totalBytes} bytes`,
      reason: `total file content exceeds max ${options.maxTotalBytes} bytes`,
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [], warnings: [] };
}

import { scanForSecrets, SecretFinding } from "./secret-scan.js";

// ---------------------------------------------------------------------------
// Content-level validation (Brief 13)
// ---------------------------------------------------------------------------

function isBinaryContent(content: string): boolean {
  // Check for NUL bytes (binary indicator)
  if (content.includes("\0")) return true;
  // Check for high ratio of non-printable chars
  const nonPrintable = content.replace(/[\x20-\x7E\x0A\x0D\t]/g, "").length;
  const ratio = nonPrintable / Math.max(content.length, 1);
  return ratio > 0.1 && content.length > 50;
}

function isNoOpUpdate(current: string, proposed: string): boolean {
  if (current === undefined || current === null) return false;
  return current.trim() === proposed.trim();
}

function isSuspiciousAddition(
  filePath: string,
  content: string,
  issueKeywords: string
): SolutionValidationError | null {
  const lowerContent = content.toLowerCase();
  const lowerIssue = issueKeywords.toLowerCase();

  // postinstall/preinstall scripts
  if (filePath === "package.json") {
    // Match postinstall/preinstall in scripts (handles nested braces)
    if (/\bpostinstall\b|\bpreinstall\b/.test(content)) {
      const issueMentions = ["postinstall", "preinstall", "scripts"].some(
        (k) => lowerIssue.includes(k)
      );
      if (!issueMentions) {
        return {
          field: "files",
          value: filePath,
          reason: "new postinstall/preinstall script not mentioned in issue",
        };
      }
    }
  }

  // curl|sh or wget|bash patterns (allow spaces around pipe)
  if (/\b(curl|wget)\b.*\|.*\b(sh|bash|zsh)\b/.test(lowerContent)) {
    const issueMentions = ["curl", "wget", "sh", "bash", "zsh", "shell"].some(
      (k) => lowerIssue.includes(k)
    );
    if (!issueMentions) {
      return {
        field: "files",
        value: filePath,
        reason: "shell pipe from curl/wget not mentioned in issue",
      };
    }
  }

  return null;
}

export function validateSolutionContent(
  files: Array<{ path: string; content: string; operation: string }>,
  currentContents?: Record<string, string>,
  opts?: Partial<ValidateSolutionOptions>
): ValidationReport {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const errors: SolutionValidationError[] = [];
  const warnings: SolutionValidationError[] = [];

  // Count deletes
  let deleteCount = 0;
  for (const file of files) {
    if (file.operation === "delete") deleteCount++;
  }

  if (deleteCount > options.maxDeletes) {
    errors.push({
      field: "files",
      value: `${deleteCount} files`,
      reason: `exceeds max ${options.maxDeletes} file deletions`,
    });
  }

  // Protected file checks
  for (const file of files) {
    const baseName = file.path.split("/").pop() ?? file.path;
    const baseNoExt = baseName.replace(/\.[^.]+$/, "");
    if (
      file.operation === "delete" &&
      options.protectedFiles.some((p) => p.toLowerCase() === baseNoExt.toLowerCase())
    ) {
      const issueMentions = options.issueKeywords
        .toLowerCase()
        .includes(baseNoExt.toLowerCase());
      if (!issueMentions) {
        errors.push({
          field: "files",
          value: file.path,
          reason: `deletion of protected file (${baseName}) not mentioned in issue`,
        });
      }
    }

    // Binary content in text paths
    if (
      file.operation !== "delete" &&
      /\.(ts|js|tsx|jsx|json|yml|yaml|md|css|html|sh|txt|toml|cfg|ini|env)$/.test(file.path) &&
      isBinaryContent(file.content)
    ) {
      errors.push({
        field: "files",
        value: file.path,
        reason: "binary content (NUL bytes) in text file path",
      });
    }

    // No-op update detection
    if (
      file.operation === "update" &&
      currentContents &&
      currentContents[file.path] !== undefined
    ) {
      if (isNoOpUpdate(currentContents[file.path], file.content)) {
        warnings.push({
          field: "files",
          value: file.path,
          reason: "update is no-op (content unchanged)",
        });
      }
    }

    // Suspicious additions
    if (file.operation !== "delete") {
      const suspicious = isSuspiciousAddition(file.path, file.content, options.issueKeywords ?? "");
      if (suspicious) {
        if (options.warnSecrets) {
          errors.push(suspicious);
        } else {
          warnings.push(suspicious);
        }
      }
    }

    // Secret scanning (if enabled)
    if (options.warnSecrets) {
      const findings = scanForSecrets(file.content);
      for (const finding of findings) {
        errors.push({
          field: "files",
          value: `${file.path}:${finding.line}`,
          reason: `potential ${finding.type} detected`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
