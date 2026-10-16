import type { JobOptions, RepoConfig } from "./types.js";
import { resolveLabelSwitches } from "./label-switches.js";

/** Effective options for one job: directives + labels + `.luci-bot.yml`. */
export interface ResolvedJobOptions extends JobOptions {
  /** Extra denied globs from `.luci-bot.yml` (added to the built-in deny list). */
  deniedPaths: string[];
  /** If non-empty, every changed file must match one of these globs. */
  allowedPaths: string[];
  /** Max files per solution (repo limit; never raised above the bot default). */
  maxFiles?: number;
  /** Set when `/luci go` approved a plan: generation is restricted to these files. */
  approvedPlanFiles?: string[];
}

export const DEFAULT_JOB_OPTIONS: ResolvedJobOptions = {
  model: "remote",
  baseBranch: "",
  fileHints: [],
  planOnly: false,
  dryRun: false,
  noPr: false,
  warnings: [],
  deniedPaths: [],
  allowedPaths: [],
};

const BOT_MAX_FILES = 20;

/**
 * Merge per-issue settings. Precedence: `.luci-bot.yml` limits > labels > directives > defaults.
 * Labels and directives can only switch behaviour on (local model, plan-only, dry-run, no-pr);
 * nothing an issue says can widen the repo's path rules or limits.
 */
export function resolveJobOptions(
  directives: JobOptions | undefined,
  labels: string[],
  repoConfig: RepoConfig | undefined,
  repoConfigWarnings: string[] = []
): ResolvedJobOptions {
  const d = directives ?? DEFAULT_JOB_OPTIONS;
  const l = resolveLabelSwitches(labels);
  const rc = repoConfig ?? {};

  const directiveSetModel = d.model === "local";
  const model: "local" | "remote" = l.useLocal || directiveSetModel ? "local" : rc.model ?? "remote";

  return {
    model,
    baseBranch: d.baseBranch || rc.baseBranch || "",
    fileHints: d.fileHints ?? [],
    planOnly: d.planOnly || l.planOnly,
    dryRun: d.dryRun || l.dryRun,
    noPr: d.noPr || l.noPr,
    warnings: [...(d.warnings ?? []), ...repoConfigWarnings],
    deniedPaths: rc.deniedPaths ?? [],
    allowedPaths: rc.allowedPaths ?? [],
    maxFiles: rc.maxFiles ? Math.min(rc.maxFiles, BOT_MAX_FILES) : undefined,
  };
}

/** Minimal glob: `**` matches across directories, `*` within one segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more directories
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(filePath));
}

/** Files that fall outside the repo's allowedPaths or an approved plan. */
export function pathsOutsideScope(paths: string[], opts: ResolvedJobOptions): string[] {
  return paths.filter((p) => {
    if (opts.allowedPaths.length > 0 && !matchesAnyGlob(p, opts.allowedPaths)) return true;
    if (opts.approvedPlanFiles && !opts.approvedPlanFiles.includes(p)) return true;
    return false;
  });
}
