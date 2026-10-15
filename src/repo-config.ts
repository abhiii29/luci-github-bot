import { RepoConfig, RepoConfigResult } from "./types.js";
import { RepoConfigSchema } from "./types.js";

export type { RepoConfigResult } from "./types.js";

interface CacheEntry {
  result: RepoConfigResult;
  timestamp: number;
}

/**
 * Load per-repo config (.luci-bot.yml) from a repository's default branch.
 * Caches results for `cacheTtlMs` milliseconds to avoid repeated API calls.
 *
 * Returns defaults (empty config) on any error, with warnings surfaced.
 */
export async function loadRepoConfig(
  githubToken: string,
  repoFullName: string,
  cache: Map<string, CacheEntry> | undefined,
  cacheTtlMs: number = 5 * 60 * 1000 // 5 minutes
): Promise<RepoConfigResult> {
  const now = Date.now();
  const cacheKey = repoFullName;

  // Check cache
  if (cache?.has(cacheKey)) {
    const entry = cache.get(cacheKey)!;
    if (now - entry.timestamp < cacheTtlMs) {
      return entry.result;
    }
    cache.delete(cacheKey);
  }

  const warnings: string[] = [];
  const defaults: RepoConfig = {};

  try {
    // Determine default branch (prefer main, fall back to master)
    let defaultBranch = "main";

    try {
      const repoRes = await fetch(
        `https://api.github.com/repos/${repoFullName}`,
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );
      if (repoRes.ok) {
        const repoData = (await repoRes.json()) as { default_branch?: string };
        if (repoData.default_branch) {
          defaultBranch = repoData.default_branch;
        }
      }
    } catch {
      // Fall through to default "main"
    }

    // Fetch .luci-bot.yml from the repo
    const configRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/contents/.luci-bot.yml?ref=${defaultBranch}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!configRes.ok) {
      // No config file — use defaults
      const result: RepoConfigResult = { config: defaults, warnings };
      cache?.set(cacheKey, { result, timestamp: now });
      return result;
    }

    const configData = (await configRes.json()) as { content?: string; encoding?: string };

    if (!configData.content) {
      const result: RepoConfigResult = { config: defaults, warnings };
      cache?.set(cacheKey, { result, timestamp: now });
      return result;
    }

    const decodedContent = Buffer.from(configData.content, "base64").toString("utf-8");

    // Simple YAML-like parsing (supports top-level key: value and key: [list] formats)
    // For full YAML, you'd use a library, but the schema is simple enough
    const parsed = parseSimpleYaml(decodedContent);

    // Validate with Zod
    const parsedResult = RepoConfigSchema.safeParse(parsed);

    if (!parsedResult.success) {
      const fieldErrors = parsedResult.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ");
      warnings.push(`Invalid .luci-bot.yml: ${fieldErrors}`);
      const result: RepoConfigResult = { config: defaults, warnings };
      cache?.set(cacheKey, { result, timestamp: now });
      return result;
    }

    const result: RepoConfigResult = { config: parsedResult.data, warnings };
    cache?.set(cacheKey, { result, timestamp: now });
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to load .luci-bot.yml for ${repoFullName}: ${msg}`);
    const result: RepoConfigResult = { config: defaults, warnings };
    cache?.set(cacheKey, { result, timestamp: now });
    return result;
  }
}

/**
 * Minimal YAML-like parser for the .luci-bot.yml config file.
 * Handles:
 *   key: value          -> { key: "value" }
 *   key: [a, b, c]      -> { key: ["a", "b", "c"] }
 *   # comments          -> ignored
 *   blank lines         -> ignored
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Skip comments and blank lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let valueStr = trimmed.slice(colonIndex + 1).trim();

    if (!key) continue;

    // Check for array syntax [a, b, c]
    if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
      const inner = valueStr.slice(1, -1);
      if (inner.trim()) {
        result[key] = inner
          .split(",")
          .map((v) => v.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        result[key] = [];
      }
    } else {
      // Strip quotes
      if (
        (valueStr.startsWith('"') && valueStr.endsWith('"')) ||
        (valueStr.startsWith("'") && valueStr.endsWith("'"))
      ) {
        valueStr = valueStr.slice(1, -1);
      }
      result[key] = valueStr;
    }
  }

  return result;
}
