// ---------------------------------------------------------------------------
// Brief 14: Comment command handler for /luci commands
// ---------------------------------------------------------------------------
// Handles issue_comment.created events on monitored repos.
// Commands: retry, cancel, status, explain, plan, go
// Only repo collaborators (write permission) may issue commands.
// ---------------------------------------------------------------------------

import { metrics } from "./metrics.js";
import { resolveLabelSwitches } from "./label-switches.js";
import { isCollaborator } from "./collaborators.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobOptions {
  useLocal: boolean;
  dryRun: boolean;
  noPr: boolean;
  planOnly: boolean;
  noRun: boolean;
  model: "remote" | "local";
  targetFiles?: string[];
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export type CommandName = "retry" | "cancel" | "status" | "explain" | "plan" | "go";

export interface ParsedCommand {
  name: CommandName;
  args: string;
}

const KNOWN_COMMANDS: CommandName[] = [
  "retry",
  "cancel",
  "status",
  "explain",
  "plan",
  "go",
];

/**
 * Parse a comment body into a command. Returns null if no command found.
 * Ignores /luci inside fenced code blocks.
 */
export function parseCommand(commentBody: string): ParsedCommand | null {
  if (!commentBody || typeof commentBody !== "string") return null;

  // Remove fenced code blocks (``` ... ```) to avoid false positives
  const stripped = commentBody.replace(/```[\s\S]*?```/g, "");

  // Match /luci command on the first line (case-insensitive)
  const match = stripped.match(/^\/luci\s+(\w+)(?:\s+(.*))?$/mi);
  if (!match) return null;

  const name = match[1].toLowerCase() as CommandName;
  if (!KNOWN_COMMANDS.includes(name)) return null;

  return { name, args: match[2] ?? "" };
}

// ---------------------------------------------------------------------------
// Permission checking
// ---------------------------------------------------------------------------

/**
 * Check if the commenter is a collaborator with write permission.
 * Uses the stub from directives.ts; replace with GitHub API call.
 */
// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export interface IssueCommentPayload {
  owner: string;
  repo: string;
  issueNumber: number;
  username: string;
  body: string;
  isBot: boolean;
  labels?: string[];
}

export interface CommentResponse {
  reply: string;
  status?: "ok" | "denied" | "error";
}

export type CollaboratorCheck = (owner: string, repo: string, username: string) => Promise<boolean>;

/**
 * Handle a /luci command on an issue comment.
 */
export async function handleCommentCommand(
  payload: IssueCommentPayload,
  onRetry?: () => Promise<void>,
  onCancel?: () => Promise<void>,
  collaboratorCheck?: CollaboratorCheck,
): Promise<CommentResponse> {
  const { owner, repo, issueNumber, username, body, isBot, labels = [] } = payload;
  const checkCollab = collaboratorCheck ?? isCollaborator;

  // Ignore comments by the bot itself
  if (isBot) {
    return { reply: "", status: "ok" };
  }

  // Ignore edited/deleted comments
  const trimmed = (body ?? "").trim();
  if (!trimmed.startsWith("/luci")) {
    return { reply: "", status: "ok" };
  }

  // Check collaborator permission
  const perm = (await checkCollab(owner, repo, username)) ? "allowed" : "denied";
  if (perm === "denied") {
    return {
      reply:
        `@${username} only repo collaborators can issue commands. ` +
        `If you believe this is incorrect, ask a maintainer to add you.`,
      status: "denied",
    };
  }

  const cmd = parseCommand(trimmed);
  if (!cmd) {
    return { reply: "", status: "ok" };
  }

  const resolved = resolveLabelSwitches(labels);
  const jobOptions: JobOptions = {
    useLocal: resolved.useLocal,
    dryRun: resolved.dryRun,
    noPr: resolved.noPr,
    planOnly: resolved.planOnly,
    noRun: resolved.noRun,
    model: resolved.useLocal ? "local" : "remote",
  };

  switch (cmd.name) {
    case "retry": {
      if (!onRetry) {
        return { reply: "Retry is not available.", status: "error" };
      }
      await onRetry();
      return { reply: `@${username} retry triggered for #${issueNumber}. Processing will begin shortly.`, status: "ok" };
    }

    case "cancel": {
      if (!onCancel) {
        return { reply: "Cancel is not available.", status: "error" };
      }
      await onCancel();
      return { reply: `@${username} processing cancelled for #${issueNumber}.`, status: "ok" };
    }

    case "status": {
      const snapshot = metrics.getSnapshot();
      const recent = snapshot.recentActivity
        .filter((a) => a.repo.includes(`${owner}/${repo}`) || owner === "")
        .slice(-5);
      const lines = recent.map(
        (a) => `  #${a.issueNumber} ${a.action} — ${a.status ?? "N/A"} (${a.timestamp})`
      );
      return {
        reply:
          `**Status for ${owner}/${repo}#${issueNumber}:**\n\n` +
          (lines.length > 0 ? lines.join("\n") : "  No recent activity.") +
          `\n\n**Overall:** ${snapshot.issuesByStatus.success} success, ${snapshot.issuesByStatus.failed} failed, ` +
          `${snapshot.issuesByStatus.queued} queued, ${snapshot.issuesByStatus.blocked} blocked`,
        status: "ok",
      };
    }

    case "explain": {
      return {
        reply:
          `**Explanation for #${issueNumber}:**\n\n` +
          `**Labels:** ${labels.join(", ") || "(none)"}\n` +
          `**Parsed options:**\n` +
          `  - Model: ${jobOptions.model}\n` +
          `  - Dry run: ${jobOptions.dryRun}\n` +
          `  - No PR: ${jobOptions.noPr}\n` +
          `  - Plan only: ${jobOptions.planOnly}\n` +
          `  - No run: ${jobOptions.noRun}\n` +
          `\nLabels override `.concat(
            `precedence: `.concat(
              `.luci-bot.yml limits > label > directive > defaults`
            )
          ),
        status: "ok",
      };
    }

    case "plan":
    case "go": {
      // These are handled by Brief 15 plan-only flow
      return {
        reply:
          cmd.name === "go"
            ? `@${username} /luci go: plan-only execution not yet configured. Use \`/luci plan\` to generate a plan first.`
            : `@${username} /luci plan: plan-only mode not yet configured. Use \`/luci retry\` for immediate processing.`,
        status: "ok",
      };
    }

    default: {
      return { reply: "", status: "ok" };
    }
  }
}
