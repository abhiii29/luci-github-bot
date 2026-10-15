export interface SolutionValidationError {
  field: string;
  value: string;
  reason: string;
}

export interface ValidateSolutionOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  deniedPatterns?: string[];
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

  return { valid: true };
}
