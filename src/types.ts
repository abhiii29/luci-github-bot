import { z } from "zod";

/**
 * Options extracted from directives, per-repo config, and trigger checks.
 * Attached to webhook events so downstream code (issue-handler, llm, worker)
 * can consume them without re-parsing.
 */
export interface JobOptions {
  model: "local" | "remote";
  baseBranch: string;
  fileHints: string[];
  planOnly: boolean;
  dryRun: boolean;
  noPr: boolean;
  warnings: string[];
}

/** Result of parsing the `/luci` directive block(s) from text. */
export interface DirectiveResult {
  /** Parsed key=value pairs and flag presence. */
  directives: Record<string, string | boolean>;
  /** Unknown keys collected as warnings (not fatal). */
  warnings: string[];
  /** Parsing errors (e.g. unterminated quote). */
  errors: string[];
}

/** Allowed per-repo configuration schema (Zod). */
export const RepoConfigSchema = z.object({
  model: z.enum(["local", "remote"]).optional(),
  baseBranch: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  deniedPaths: z.array(z.string()).optional(),
  maxFiles: z.coerce.number().int().positive().optional(),
  labels: z.array(z.string()).optional(),
  reviewers: z.array(z.string()).optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/** Loaded repo config with any validation warnings. */
export interface RepoConfigResult {
  config: RepoConfig;
  warnings: string[];
  error?: string;
}
