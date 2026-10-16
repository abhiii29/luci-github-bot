import { handleCommentCommand, type CommandHooks } from "./commands.js";
import { createSplitIssues } from "./split.js";
import { getConfig } from "./config.js";
import { cancelIssue, enqueueIssue, latestJobForIssue, openJobFor } from "./dispatch.js";
import { GitHubClient, redact } from "./github.js";
import { computeJobOptions } from "./job-context.js";
import { approvePlan, cancelPlan, getPlanState, hashIssueBody, planKeyFor } from "./plan.js";
import { markIssueQueued } from "./issue-handler.js";
import type { GitHubIssueEvent } from "./webhook.js";

/** GitHub `issue_comment` webhook payload (fields we use). */
export interface GitHubCommentEvent {
  action: string;
  issue: GitHubIssueEvent["issue"] & { pull_request?: unknown };
  comment: { id: number; body: string; user: { login: string; type?: string } };
  repository: GitHubIssueEvent["repository"];
  sender: { login: string };
}

function toIssueEvent(e: GitHubCommentEvent): GitHubIssueEvent {
  return { action: "assigned", issue: e.issue, repository: e.repository, sender: e.sender };
}

async function enqueueWith(
  e: GitHubCommentEvent,
  username: string,
  tweak: (opts: Awaited<ReturnType<typeof computeJobOptions>>) => void,
  what: string
): Promise<string> {
  const event = toIssueEvent(e);
  const opts = await computeJobOptions(event, getConfig().githubToken);
  tweak(opts);
  event.jobOptions = opts;
  const open = openJobFor(event.repository.full_name, event.issue.number);
  if (open) return `@${username} a job for this issue is already ${open.status}.`;
  const marked = markIssueQueued(event); // before enqueue: the job may start immediately
  const r = enqueueIssue(event);
  if (r.status === "unavailable") return `@${username} the job queue is not available right now.`;
  await marked;
  return `@${username} ${what} queued.`;
}

export function buildCommandHooks(e: GitHubCommentEvent): CommandHooks {
  const repo = e.repository.full_name;
  const [owner, name] = repo.split("/");
  const n = e.issue.number;

  return {
    retry: (u) => enqueueWith(e, u, () => {}, "retry"),

    plan: (u) => enqueueWith(e, u, (o) => (o.planOnly = true), "planning"),

    go: async (u) => {
      const state = getPlanState(owner, name, n);
      if (!state) return `@${u} there is no plan for this issue yet. Reply \`/luci plan\` first.`;
      if (state.status !== "pending") return `@${u} the plan is ${state.status}. Reply \`/luci plan\` for a new one.`;
      if ((state.issueBodyHash ?? state.plan.issueBodyHash) !== hashIssueBody(e.issue.body ?? "")) {
        return `@${u} the issue changed after the plan was written. Reply \`/luci plan\` to re-plan.`;
      }
      approvePlan(planKeyFor(repo, n), u);
      // Approve first so a repeated /luci go is rejected instead of creating a second set of sub-issues.
      if (state.plan.parts && state.plan.parts.length >= 2) {
        const config = getConfig();
        const gh = new GitHubClient({ token: config.githubToken, retries: 2 });
        const numbers = await createSplitIssues(gh, repo, { number: n, title: e.issue.title }, state.plan.parts, config.botUsername ?? "");
        return `@${u} split into ${numbers.length} sub-issues: ${numbers.map((x) => "#" + x).join(", ")}. Part 1 (#${numbers[0]}) has been assigned and starts now.`;
      }
      const files = state.plan.files.map((f) => f.path);
      return enqueueWith(e, u, (o) => {
        o.planOnly = true;
        o.approvedPlanFiles = files;
      }, `plan approved (${files.length} file(s)); implementation`);
    },

    cancel: async (u) => {
      const job = cancelIssue(repo, n);
      let planCancelled = false;
      const plan = getPlanState(owner, name, n);
      if (plan && (plan.status === "pending" || plan.status === "approved")) {
        cancelPlan(planKeyFor(repo, n));
        planCancelled = true;
      }
      if (job === "none" && !planCancelled) return `@${u} nothing to cancel.`;
      const parts = [];
      if (job === "cancelled") parts.push("the queued job was cancelled");
      if (job === "cancelling") parts.push("the running job will stop before pushing anything");
      if (planCancelled) parts.push("the pending plan was dropped");
      return `@${u} ${parts.join("; ")}.`;
    },

    status: async (u) => {
      const job = latestJobForIssue(repo, n);
      const plan = getPlanState(owner, name, n);
      const lines = [`@${u} status for #${n}:`];
      lines.push(
        job
          ? `- Job: **${job.status}** (attempt ${job.attempts}/${job.maxAttempts}, updated ${job.updatedAt})` +
              (job.errorCategory ? ` — ${job.errorCategory}` : "") +
              (job.prUrl ? ` — [PR](${job.prUrl})` : "")
          : "- Job: none"
      );
      if (plan) lines.push(`- Plan: **${plan.status}** (${plan.plan.files.length} file(s))`);
      return lines.join("\n");
    },

    explain: async (u) => {
      const o = await computeJobOptions(toIssueEvent(e), getConfig().githubToken);
      const lines = [
        `@${u} this is how I would handle #${n} (no model was called):`,
        `- Model: ${o.model}`,
        `- Base branch: ${o.baseBranch || "(repo default)"}`,
        `- Plan first: ${o.planOnly}`,
        `- Dry run: ${o.dryRun || getConfig().dryRun}`,
        `- Open PR: ${!o.noPr}`,
      ];
      if (o.fileHints.length) lines.push(`- File hints: ${o.fileHints.join(", ")}`);
      if (o.allowedPaths.length) lines.push(`- Allowed paths (.luci-bot.yml): ${o.allowedPaths.join(", ")}`);
      if (o.deniedPaths.length) lines.push(`- Extra denied paths (.luci-bot.yml): ${o.deniedPaths.join(", ")}`);
      if (o.warnings.length) lines.push("", "**Warnings:**", ...o.warnings.map((w) => `- ${w}`));
      lines.push("", "Precedence: `.luci-bot.yml` limits > labels > `/luci` directives > defaults.");
      return lines.join("\n");
    },
  };
}

/** Handle an `issue_comment.created` webhook: run `/luci` commands and post the reply. */
export async function handleIssueComment(e: GitHubCommentEvent): Promise<void> {
  const config = getConfig();
  const [owner, repo] = e.repository.full_name.split("/");
  const author = e.comment.user;
  // Only GitHub App/bot accounts are skipped here; the webhook already drops the bot's own replies by content.
  const isBot = author.type === "Bot";

  const res = await handleCommentCommand(
    {
      owner,
      repo,
      issueNumber: e.issue.number,
      username: author.login,
      body: e.comment.body,
      isBot,
      labels: e.issue.labels.map((l) => l.name),
    },
    undefined,
    undefined,
    undefined,
    buildCommandHooks(e)
  );

  if (res.reply) {
    try {
      await new GitHubClient({ token: config.githubToken }).createComment(e.repository.full_name, e.issue.number, redact(res.reply));
    } catch (err) {
      console.warn(`[commands] Failed to reply: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  }
}
