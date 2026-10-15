import { DirectiveResult, JobOptions } from "./types.js";

/** Allowlisted directive keys (values) — anything else is a warning. */
const ALLOWED_KEYS = new Set([
  "model",
  "base",
  "files",
  "plan-only",
  "dry-run",
  "no-pr",
]);

// Kept for backward compat with existing @local-model detection (also checks body).
export const LOCAL_MODEL_TRIGGER = /^@local-model\s+(.+)/;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function tokenizeDirectives(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  return tokens;
}

/** Parse a single `/luci` directive line. */
export function parseDirectiveLine(line: string): DirectiveResult {
  const trimmed = line.trim();
  const match = trimmed.match(/^\/luci\s+(.+)$/);
  if (!match) {
    return { directives: {}, warnings: [], errors: [`Malformed /luci directive: expected "/luci key=value ..." but got "${trimmed}"`] };
  }

  return parseDirectiveParams(match[1]);
}

/** Parse the params portion of a `/luci` directive. */
function parseDirectiveParams(params: string): DirectiveResult {
  const directives: Record<string, string | boolean> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  const tokens = tokenizeDirectives(params);

  for (const token of tokens) {
    if (!token) continue;

    const eqIndex = token.indexOf("=");
    if (eqIndex === -1) {
      // Treat as flag
      const key = token;
      if (key === "@local-model") {
        directives["model"] = "local";
      } else if (ALLOWED_KEYS.has(key)) {
        directives[key] = true;
      } else {
        warnings.push(`Unknown directive flag: ${key}`);
      }
    } else {
      const key = token.slice(0, eqIndex).trim();
      let value = token.slice(eqIndex + 1).trim();

      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (ALLOWED_KEYS.has(key)) {
        directives[key] = value;
      } else {
        warnings.push(`Unknown directive key: ${key}`);
      }
    }
  }

  return { directives, warnings, errors };
}

/** Parse `/luci` directive blocks from text. */
export function parseDirectiveBlock(text: string): DirectiveResult {
  if (!text) {
    return { directives: {}, warnings: [], errors: [] };
  }

  const all: DirectiveResult = { directives: {}, warnings: [], errors: [] };

  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    const match = trimmed.match(/^\/luci\s+(.+)$/);
    if (!match) continue;

    const lineResult = parseDirectiveParams(match[1]);
    Object.assign(all.directives, lineResult.directives);
    all.warnings.push(...lineResult.warnings);
    all.errors.push(...lineResult.errors);
  }

  return all;
}

/** Check if @local-model prefix appears in the text (title-only for Brief 6). */
export function hasLocalModelDirective(text: string): boolean {
  if (!text) return false;
  const firstLine = text.split("\n")[0];
  return LOCAL_MODEL_TRIGGER.test(firstLine);
}

/** Parse @local-model directive from text (returns model=local if present). */
export function parseLocalModelDirective(text: string): DirectiveResult {
  if (!text) return { directives: {}, warnings: [], errors: [] };

  const firstLine = text.split("\n")[0];
  const match = firstLine.match(LOCAL_MODEL_TRIGGER);
  if (!match) {
    return { directives: {}, warnings: [], errors: [] };
  }

  return {
    directives: { model: "local" },
    warnings: [],
    errors: [],
  };
}

/** Validate and normalise directive keys. Unknown keys become warnings. */
function validateDirectives(result: DirectiveResult): void {
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(result.directives)) {
    if (value === true) {
      // It's a flag; check if it's allowed
      if (!ALLOWED_KEYS.has(key) && key !== "@local-model") {
        warnings.push(`Unknown directive flag: ${key}`);
        delete result.directives[key];
      }
    } else {
      // key=value pair
      if (!ALLOWED_KEYS.has(key)) {
        warnings.push(`Unknown directive key: ${key}`);
        delete result.directives[key];
      }
    }
  }

  result.warnings.push(...warnings);
}

/**
 * Normalize parsed directive results into a JobOptions object.
 * Unknown keys are collected as warnings; duplicate keys resolve to last value.
 */
export function normalizeToJobOptions(
  parsed: DirectiveResult,
  localModelHints: DirectiveResult[],
  authorIsCollaborator: boolean
): JobOptions {
  const directives: Record<string, string | boolean> = { ...parsed.directives };
  const warnings: string[] = [...parsed.warnings];

  // Apply @local-model hint (from title)
  for (const hint of localModelHints) {
    Object.assign(directives, hint.directives);
    warnings.push(...hint.warnings);
  }

  // If not a collaborator, strip directives with a warning
  if (!authorIsCollaborator) {
    const directiveKeys = Object.keys(directives).filter(
      (k) => directives[k] !== true // skip flags
    );
    if (directiveKeys.length > 0 || Object.values(directives).some((v) => v === true)) {
      warnings.push(
        "Directives ignored: issue author is not a repo collaborator/owner"
      );
      // Reset directives but keep the model default (remote)
      Object.keys(directives).forEach((k) => delete directives[k]);
    }
  }

  // Validate keys and collect warnings
  validateDirectives({ directives, warnings, errors: [] });

  // Build JobOptions — defaults: remote model
  const model = directives["model"] === "local" ? "local" : "remote";
  const base = typeof directives["base"] === "string" ? directives["base"] : "";
  const filesRaw = directives["files"];
  const fileHints =
    typeof filesRaw === "string"
      ? filesRaw
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : [];

  return {
    model,
    baseBranch: base,
    fileHints,
    planOnly: !!directives["plan-only"],
    dryRun: !!directives["dry-run"],
    noPr: !!directives["no-pr"],
    warnings,
  };
}

/**
 * Top-level directive parser: combines /luci blocks from body with
 * @local-model from title, validates, and returns normalized results.
 */
export function parseDirectives(
  issueTitle: string,
  issueBody: string | null | undefined,
  authorIsCollaborator: boolean
): DirectiveResult & { jobOptions: JobOptions } {
  const bodyDirectives = parseDirectiveBlock(issueBody ?? "");
  const titleDirectives: DirectiveResult[] = [];

  // Check title for @local-model prefix
  if (issueTitle && hasLocalModelDirective(issueTitle)) {
    titleDirectives.push(parseLocalModelDirective(issueTitle));
  }

  // Merge title directives with body directives
  const mergedDirectives: Record<string, string | boolean> = {};
  const allWarnings: string[] = [...bodyDirectives.warnings];

  for (const td of titleDirectives) {
    Object.assign(mergedDirectives, td.directives);
    allWarnings.push(...td.warnings);
  }
  Object.assign(mergedDirectives, bodyDirectives.directives);
  allWarnings.push(...bodyDirectives.warnings);

  const mergedResult: DirectiveResult = {
    directives: mergedDirectives,
    warnings: allWarnings,
    errors: bodyDirectives.errors,
  };

  const jobOptions = normalizeToJobOptions(mergedResult, titleDirectives, authorIsCollaborator);

  return {
    ...mergedResult,
    jobOptions,
  };
}
