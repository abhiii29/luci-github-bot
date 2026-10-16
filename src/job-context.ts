import { checkCollaborator } from "./collaborators.js";
import { parseDirectives } from "./directives.js";
import { resolveJobOptions, type ResolvedJobOptions } from "./job-options.js";
import { loadRepoConfig, type RepoConfigResult } from "./repo-config.js";
import type { GitHubIssueEvent } from "./webhook.js";

const repoConfigCache = new Map<string, { result: RepoConfigResult; timestamp: number }>();
const REPO_CONFIG_CACHE_TTL_MS = 300_000;

export function clearRepoConfigCache(): void {
  repoConfigCache.clear();
}

/**
 * Work out the effective options for an issue: `/luci` directives (honoured only when the issue
 * author is a collaborator), `bot:*` label switches, and the repo's `.luci-bot.yml`.
 */
export async function computeJobOptions(event: GitHubIssueEvent, githubToken: string): Promise<ResolvedJobOptions> {
  const repo = event.repository.full_name;
  const [repoConfig, isCollab] = await Promise.all([
    loadRepoConfig(githubToken, repo, repoConfigCache, REPO_CONFIG_CACHE_TTL_MS),
    checkCollaborator(githubToken, repo, event.issue.user.login),
  ]);
  const directives = parseDirectives(event.issue.title, event.issue.body, isCollab);
  return resolveJobOptions(
    directives.jobOptions,
    event.issue.labels.map((l) => l.name),
    repoConfig.config,
    repoConfig.warnings
  );
}
