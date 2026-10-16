import type { GitHubIssueEvent } from "./webhook.js";
import {
  generateSolution,
  generateSolutionWithDecomposition,
  generatePlanText,
  isLocalModelTrigger,
  extractLocalPrompt,
  fetchFileContent,
  type CodeGenerationResult,
} from "./llm.js";
import { guardChanges } from "./change-guard.js";
import { DockerWorker, type WorkerProgress } from "./docker-worker.js";
import { getConfig } from "./config.js";
import { metrics } from "./metrics.js";
import { GitHubClient, buildStatusComment, redact, type StatusCode, type StatusStage } from "./github.js";
import { buildRepoContext } from "./repo-context.js";
import { validateSolutionContent } from "./solution-validator.js";
import { DEFAULT_JOB_OPTIONS, pathsOutsideScope, type ResolvedJobOptions } from "./job-options.js";
import { createPlan, getApprovedFiles, markPlanExecuted, planKeyFor, type PlanState } from "./plan.js";
import type { JobOutcome } from "./queue.js";

let worker: DockerWorker | null = null;

/** Share the bot's single DockerWorker (one semaphore, one resource monitor). */
export function setIssueWorker(w: DockerWorker): void {
  worker = w;
}

function getWorker(): DockerWorker {
  if (!worker) worker = new DockerWorker();
  return worker;
}

export interface HandleContext {
  /** Returns true once the job was cancelled (`/luci cancel`); checked before anything is pushed. */
  isCancelled?: () => boolean;
}

// ── GitHub helpers (never throw: a failed comment must not fail the job) ──

function makeClient(githubToken: string): GitHubClient {
  return new GitHubClient({ token: githubToken, retries: 2 });
}

function setStatusLabel(gh: GitHubClient, repo: string, issueNumber: number, status: StatusCode): Promise<void> {
  return serialized(repo, issueNumber, async () => {
    try {
      await gh.setLabels(repo, issueNumber, status);
    } catch (err) {
      console.warn(`[handler] Failed to set label ${status}: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  });
}

// All status writes for one issue (label + comment) are serialized in call order. Otherwise the
// "queued" update and the handler's "working" update interleave and leave two bot:* labels or a
// stale/duplicate status comment.
const statusLocks = new Map<string, Promise<void>>();

function serialized(repo: string, issueNumber: number, fn: () => Promise<void>): Promise<void> {
  const key = `${repo}#${issueNumber}`;
  const next = (statusLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  statusLocks.set(key, next);
  void next.finally(() => {
    if (statusLocks.get(key) === next) statusLocks.delete(key);
  });
  return next;
}

function updateStatusComment(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  stage: StatusStage,
  extra: { category?: string; prUrl?: string; hint?: string; notes?: string[] } = {}
): Promise<void> {
  return serialized(repo, issueNumber, () => writeStatusComment(gh, repo, issueNumber, stage, extra));
}

async function writeStatusComment(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  stage: StatusStage,
  extra: { category?: string; prUrl?: string; hint?: string; notes?: string[] }
): Promise<void> {
  try {
    const body = buildStatusComment(stage, extra.category, extra.prUrl, extra.hint, extra.notes);
    const existing = await gh.findBotComment(repo, issueNumber);
    if (existing) await gh.updateComment(repo, existing.id, body);
    else await gh.createComment(repo, issueNumber, body);
  } catch (err) {
    console.warn(`[handler] Failed to update status comment: ${redact(err instanceof Error ? err.message : String(err))}`);
  }
}

async function postComment(gh: GitHubClient, repo: string, issueNumber: number, body: string): Promise<void> {
  try {
    await gh.createComment(repo, issueNumber, body);
  } catch (err) {
    console.warn(`[handler] Failed to post comment: ${redact(err instanceof Error ? err.message : String(err))}`);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ── Plan formatting ─────────────────────────────────────────────────────

export function formatPlanComment(state: PlanState): string {
  const p = state.plan;
  const lines = [
    "📝 **Proposed plan** (no code has been written yet)",
    "",
    `**Approach:** ${p.approach}`,
    "",
    "**Files:**",
    ...p.files.map((f) => `- \`${f.path}\` (${f.operation}) — ${f.reason}`),
  ];
  if (p.risks.length) lines.push("", "**Risks:**", ...p.risks.map((r) => `- ${r}`));
  if (p.openQuestions.length) lines.push("", "**Open questions:**", ...p.openQuestions.map((q) => `- ${q}`));
  lines.push(
    "",
    "Reply `/luci go` to implement exactly these files, or `/luci cancel` to drop the plan. " +
      "Editing the issue invalidates the plan. Plans expire after 7 days."
  );
  return redact(lines.join("\n"));
}

// ── Model outages ────────────────────────────────────────────────────────

/** Wait before retrying when the model endpoint is down (a 1 s retry just fails again). */
export const MODEL_RETRY_DELAY_MS = 3 * 60_000;

export function isModelUnavailable(err: unknown): boolean {
  const e = err as { status?: number; code?: string; name?: string; message?: string };
  if (typeof e?.status === "number" && (e.status === 429 || e.status >= 500)) return true;
  if (e?.code && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(e.code)) return true;
  if (e?.name === "AbortError" || e?.name === "APIConnectionError" || e?.name === "APIConnectionTimeoutError") return true;
  return /\b(502|503|504|429)\b|unavailable|bad gateway|timed? ?out|ECONNREFUSED|fetch failed|Ollama 5\d\d/i.test(e?.message ?? "");
}

// ── retryQueuedIssue ────────────────────────────────────────────────────

/** Prepare an issue for a retry (`needs-retry` label): clear the trigger label, show it as queued. */
export async function retryQueuedIssue(event: GitHubIssueEvent): Promise<void> {
  const gh = makeClient(getConfig().githubToken);
  const repo = event.repository.full_name;
  const issueNumber = event.issue.number;
  try {
    await gh.removeLabel(repo, issueNumber, "needs-retry");
  } catch {
    /* label may not exist */
  }
  await Promise.all([
    setStatusLabel(gh, repo, issueNumber, "bot:queued"),
    updateStatusComment(gh, repo, issueNumber, "queued"),
  ]);
}

/** Mark an issue as queued on GitHub (called when a job is enqueued). */
export async function markIssueQueued(event: GitHubIssueEvent): Promise<void> {
  const gh = makeClient(getConfig().githubToken);
  // Both writes are queued synchronously, so they land before anything the job does afterwards
  await Promise.all([
    setStatusLabel(gh, event.repository.full_name, event.issue.number, "bot:queued"),
    updateStatusComment(gh, event.repository.full_name, event.issue.number, "queued"),
  ]);
}

// ── handleIssue ─────────────────────────────────────────────────────────

const processingIssues = new Set<string>();

export async function handleIssue(event: GitHubIssueEvent, ctx: HandleContext = {}): Promise<JobOutcome> {
  const config = getConfig();
  const { githubToken } = config;
  const gh = makeClient(githubToken);
  const repoFullName = event.repository.full_name;
  const issueNumber = event.issue.number;
  const issueKey = `${repoFullName}#${issueNumber}`;
  const opts: ResolvedJobOptions = { ...DEFAULT_JOB_OPTIONS, ...((event.jobOptions as Partial<ResolvedJobOptions>) ?? {}) };
  const notes = [...opts.warnings];
  const cancelled = () => ctx.isCancelled?.() ?? false;

  if (processingIssues.has(issueKey)) {
    console.log(`[handler] Already processing ${issueKey}, skipping`);
    return { success: false, error: "already_processing", retryable: false };
  }
  processingIssues.add(issueKey);

  const startTime = Date.now();
  metrics.recordIssueReceived(repoFullName, issueNumber);
  metrics.recordIssueProcessing(repoFullName, issueNumber);

  const fail = async (category: string, hint: string, retryable: boolean, error = category): Promise<JobOutcome> => {
    await setStatusLabel(gh, repoFullName, issueNumber, "bot:blocked");
    await updateStatusComment(gh, repoFullName, issueNumber, "failed", { category, hint, notes });
    metrics.recordIssueFailed(error, Date.now() - startTime, repoFullName, issueNumber);
    return { success: false, error: category, retryable };
  };

  try {
    // Idempotency: a re-run (restart recovery, duplicate trigger) must not open a second PR.
    if (!opts.planOnly || opts.approvedPlanFiles) {
      const existing = await gh.findOpenBotPrForIssue(repoFullName, issueNumber).catch(() => undefined);
      if (existing) {
        await setStatusLabel(gh, repoFullName, issueNumber, "bot:awaiting-review");
        await updateStatusComment(gh, repoFullName, issueNumber, "pr-opened", {
          prUrl: existing.url,
          notes: [...notes, `PR #${existing.number} is already open for this issue. Close it, then reply \`/luci retry\` for a new attempt.`],
        });
        return { success: true, prUrl: existing.url };
      }
    }

    const w = getWorker();
    if (w.getCapacity().full) {
      // The worker semaphore waits for a slot; tell the user why it's slow.
      await updateStatusComment(gh, repoFullName, issueNumber, "queued", { notes });
    }

    await setStatusLabel(gh, repoFullName, issueNumber, "bot:in-progress");
    await updateStatusComment(gh, repoFullName, issueNumber, "working", { notes });

    const body = event.issue.body ?? "";
    const useLocal = opts.model === "local" || isLocalModelTrigger(event.issue.title, body || undefined);
    const hintText = opts.fileHints.length > 0 ? `\n\nFiles to focus on: ${opts.fileHints.join(", ")}` : "";
    const repoContext = await buildRepoContext(githubToken, repoFullName, event.issue.title, body + hintText);
    console.log(`[handler] ${issueKey}: ${repoContext.fileCount} file(s) of context, model=${useLocal ? "local" : "remote"}`);

    // ── Plan stage: post a plan and stop until a collaborator says `/luci go` ──
    if (opts.planOnly && !opts.approvedPlanFiles) {
      const { plan } = await createPlan(
        repoFullName.split("/")[0],
        event.issue.title,
        body,
        repoFullName,
        issueNumber,
        () => generatePlanText(event.issue.title, body || "(no description)", repoContext.promptSection, useLocal)
      );
      if (plan.plan.files.length === 0) {
        return await fail("plan_empty", "The model could not produce a usable plan. Add detail to the issue and reply `/luci plan`.", false);
      }
      await postComment(gh, repoFullName, issueNumber, formatPlanComment(plan));
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:awaiting-review");
      await updateStatusComment(gh, repoFullName, issueNumber, "plan-pending", { notes });
      return { success: true, noOp: true };
    }

    // ── Generate ──
    const scopeNote = opts.approvedPlanFiles
      ? `\n\nIMPLEMENT THE APPROVED PLAN. Only these files may change: ${opts.approvedPlanFiles.join(", ")}`
      : "";
    let solution: CodeGenerationResult;
    try {
    if (useLocal) {
      solution = await generateSolutionWithDecomposition(
        event.issue.title,
        extractLocalPrompt(event.issue.title, body || undefined) + hintText + scopeNote,
        repoContext.promptSection,
        [],
        githubToken,
        repoFullName
      );
    } else {
      solution = await generateSolution(
        event.issue.title,
        (body || "(no description)") + hintText + scopeNote,
        repoContext.promptSection
      );
    }
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err));
      if (isModelUnavailable(err)) {
        metrics.recordLlmGeneration(false, useLocal);
        const out = await fail(
          "model_unavailable",
          `The ${useLocal ? "local" : "remote"} model is not reachable right now. The bot will retry in a few minutes.`,
          true,
          msg
        );
        return { ...out, retryDelayMs: MODEL_RETRY_DELAY_MS };
      }
      throw err;
    }
    metrics.recordLlmGeneration(solution.success, useLocal);

    if (!solution.success) {
      if (solution.refused) {
        return await fail("refused", `The model declined: ${truncate(solution.refused, 300)}`, false);
      }
      if (solution.clarification) {
        return await fail(
          "needs_clarification",
          `The model needs more information: ${truncate(solution.clarification, 500)} — update the issue and reply \`/luci retry\`.`,
          false
        );
      }
      return await fail("llm_generation", "The model's answer could not be used. It will be retried automatically.", true, solution.error);
    }

    // ── Resolve patches; refuse rewrites that would silently destroy code ──
    const guarded = await guardChanges(solution.files, {
      known: repoContext.fullContents,
      truncatedPaths: repoContext.truncatedPaths,
      issueText: `${event.issue.title}\n${body}`,
      fetchCurrent: (p) => fetchFileContent(githubToken, repoFullName, p),
    });
    if (!guarded.ok) {
      return await fail(
        "unsafe_change",
        `The generated change was rejected before anything was pushed: ${truncate(guarded.reason, 400)}`,
        true,
        guarded.reason
      );
    }
    solution = { ...solution, files: guarded.files };

    // ── Validate content and scope before anything leaves the bot ──
    const content = validateSolutionContent(solution.files, repoContext.fullContents, {
      warnSecrets: true,
      issueKeywords: `${event.issue.title}\n${body}`,
    });
    notes.push(...content.warnings.map((w) => `${w.value}: ${w.reason}`));
    if (!content.valid) {
      const reasons = content.errors.map((e) => `${e.value}: ${e.reason}`).join("; ");
      return await fail("validation", `The generated change was rejected: ${truncate(reasons, 500)}`, false, reasons);
    }
    const outOfScope = pathsOutsideScope(solution.files.map((f) => f.path), opts);
    if (outOfScope.length > 0) {
      return await fail(
        "out_of_scope",
        `The change touched files outside the allowed scope: ${truncate(outOfScope.join(", "), 300)}`,
        false
      );
    }

    // ── Dry run: report, don't push ──
    if (config.dryRun || opts.dryRun) {
      await postComment(
        gh,
        repoFullName,
        issueNumber,
        redact(
          "🧪 **Dry run** — nothing was pushed.\n\n" +
            `- Branch: \`${solution.branchName}\`\n- Commit: ${solution.commitMessage}\n` +
            solution.files.map((f) => `- ${f.operation}: \`${f.path}\``).join("\n")
        )
      );
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:awaiting-review");
      await updateStatusComment(gh, repoFullName, issueNumber, "dry-run", { notes });
      return { success: true, noOp: true };
    }

    if (cancelled()) {
      await updateStatusComment(gh, repoFullName, issueNumber, "failed", { category: "cancelled", hint: "Cancelled before anything was pushed." });
      return { success: false, error: "cancelled", retryable: false };
    }

    // ── Execute in a container ──
    const result = await w.processIssue(
      event,
      solution,
      (progress: WorkerProgress) => console.log(`[handler] ${issueKey} ${progress.stage}: ${progress.message}`),
      {
        baseBranch: opts.baseBranch || undefined,
        noPr: opts.noPr,
        validation: { deniedPatterns: opts.deniedPaths, ...(opts.maxFiles ? { maxFiles: opts.maxFiles } : {}) },
      }
    );
    metrics.recordWorkerExecution(result.success);

    if (result.status === "no_changes") {
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:blocked");
      await updateStatusComment(gh, repoFullName, issueNumber, "no-changes", { notes });
      return { success: false, noOp: true };
    }

    if (!result.success) {
      const hint = /validation failed/i.test(result.error ?? "")
        ? truncate(result.error ?? "", 400)
        : "The container run failed. It will be retried automatically; check the bot logs if it keeps failing.";
      const retryable = !/validation failed|does not exist/i.test(result.error ?? "");
      return await fail("worker_execution", hint, retryable, result.error);
    }

    if (opts.approvedPlanFiles) markPlanExecuted(planKeyFor(repoFullName, issueNumber));
    metrics.recordIssueCompleted(result.branchName, Date.now() - startTime, repoFullName, issueNumber);
    await setStatusLabel(gh, repoFullName, issueNumber, "bot:awaiting-review");

    if (result.status === "branch_pushed") {
      await updateStatusComment(gh, repoFullName, issueNumber, "branch-pushed", { hint: result.branchName, notes });
      return { success: true };
    }

    let prUrl = result.prUrl;
    if (!prUrl) {
      try {
        prUrl = (await gh.getPullRequestForBranch(repoFullName, result.branchName))?.url;
      } catch {
        /* link is a nice-to-have */
      }
    }
    await updateStatusComment(gh, repoFullName, issueNumber, "pr-opened", { prUrl, notes });
    return { success: true, prUrl };
  } catch (error) {
    const errorMsg = redact(error instanceof Error ? error.message : String(error));
    console.error(`[handler] Unexpected error for ${issueKey}: ${errorMsg}`);
    return await fail("unexpected", "An unexpected error occurred. It will be retried automatically; check the bot logs.", true, errorMsg);
  } finally {
    processingIssues.delete(issueKey);
  }
}

/** Approved-plan helper used by `/luci go`. */
export function approvedFilesFor(repoFullName: string, issueNumber: number): string[] {
  return getApprovedFiles(planKeyFor(repoFullName, issueNumber)).map((f) => f.path);
}

export { handleIssue as default };
