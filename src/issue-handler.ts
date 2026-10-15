import { GitHubIssueEvent, onIssue } from "./webhook.js";
import {
  generateSolution,
  generateSolutionWithDecomposition,
  isLocalModelTrigger,
  extractLocalPrompt,
} from "./llm.js";
import { DockerWorker, WorkerProgress } from "./docker-worker.js";
import { getConfig } from "./config.js";
import { metrics } from "./metrics.js";
import { GitHubClient, buildStatusComment, redact, type StatusCode } from "./github.js";
import { buildRepoContext } from "./repo-context.js";

const worker = new DockerWorker();
const processingIssues = new Set<string>();

// ── GitHub client per-handler factory ────────────────────────────────────

function makeClient(githubToken: string): GitHubClient {
  return new GitHubClient({ token: githubToken, retries: 2 });
}

// ── Status label helper ──────────────────────────────────────────────────

async function setStatusLabel(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  status: StatusCode
): Promise<void> {
  try {
    await gh.setLabels(repo, issueNumber, status);
  } catch (err) {
    const msg = err instanceof Error ? redact(err.message) : String(err);
    console.warn(`[handler] Failed to set label ${status}: ${msg}`);
  }
}

// ── Status comment helper (create once, update in place) ────────────────

async function updateStatusComment(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  stage: "queued" | "working" | "pr-opened" | "failed",
  errorCategory?: string,
  prUrl?: string,
  hint?: string
): Promise<void> {
  try {
    const existing = await gh.findBotComment(repo, issueNumber);
    const body = buildStatusComment(stage, errorCategory, prUrl, hint);
    if (existing) {
      await gh.updateComment(repo, existing.id, body);
    } else {
      await gh.createComment(repo, issueNumber, body);
    }
  } catch (err) {
    const msg = err instanceof Error ? redact(err.message) : String(err);
    console.warn(`[handler] Failed to update status comment: ${msg}`);
  }
}

// ── Repo file list (moved from Brief 3, kept here for now) ───────────────

async function getRepoFileList(
  githubToken: string,
  repoFullName: string
): Promise<string[]> {
  const gh = makeClient(githubToken);
  try {
    const repo = await gh.getRepo(repoFullName);
    // Use repo-context instead in production; stub here for transition
    return [];
  } catch {
    return [];
  }
}

// ── retryQueuedIssue ────────────────────────────────────────────────────

export async function retryQueuedIssue(event: GitHubIssueEvent): Promise<void> {
  const config = getConfig();
  const { githubToken } = config;
  const gh = makeClient(githubToken);
  const repoFullName = event.repository.full_name;
  const issueNumber = event.issue.number;

  // Remove needs-retry correctly (per-label endpoint, ignore 404)
  try {
    await gh.removeLabel(repoFullName, issueNumber, "needs-retry");
  } catch {
    /* ignore — label may not exist */
  }

  // Set status to queued
  await setStatusLabel(gh, repoFullName, issueNumber, "bot:queued");
  await updateStatusComment(gh, repoFullName, issueNumber, "queued");

  console.log(`[handler] Retrying queued issue ${repoFullName}#${issueNumber}`);
  await handleIssue(event);
}

// ── handleIssue ─────────────────────────────────────────────────────────

export async function handleIssue(event: GitHubIssueEvent): Promise<void> {
  const config = getConfig();
  const { githubToken } = config;
  const gh = makeClient(githubToken);
  const repoFullName = event.repository.full_name;
  const issueNumber = event.issue.number;
  const issueKey = `${repoFullName}#${issueNumber}`;

  if (processingIssues.has(issueKey)) {
    console.log(`[handler] Already processing ${issueKey}, skipping`);
    return;
  }
  processingIssues.add(issueKey);

  const startTime = Date.now();
  metrics.recordIssueReceived(repoFullName, issueNumber);
  metrics.recordIssueProcessing(repoFullName, issueNumber);

  try {
    const cap = worker.getCapacity();

    if (cap.full) {
      console.log(`[handler] ${issueKey} rejected — all ${cap.max} slots occupied`);
      metrics.recordQueue();
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:queued");
      await updateStatusComment(gh, repoFullName, issueNumber, "queued");
      return;
    }

    // Transition: bot:queued -> bot:in-progress
    await setStatusLabel(gh, repoFullName, issueNumber, "bot:in-progress");
    await updateStatusComment(gh, repoFullName, issueNumber, "working");

    console.log(`[handler] Generating solution for ${issueKey}...`);

    // Build repo context for LLM
    const repoContext = await buildRepoContext(
      githubToken,
      repoFullName,
      event.issue.title,
      event.issue.body || ""
    );
    console.log(`[handler] Loaded ${repoContext.fileCount} file(s) for context`);

    // Generate solution: use decomposition pipeline for local model, single-shot for remote
    const bodyOrNull = event.issue.body;
    let solution: Awaited<ReturnType<typeof generateSolution>>;
    const useLocal = isLocalModelTrigger(event.issue.title, bodyOrNull ?? undefined);

    if (useLocal) {
      const focusedPrompt = extractLocalPrompt(event.issue.title, bodyOrNull ?? undefined);
      console.log(`[handler] Using local LLM decomposition pipeline (@local-model detected)`);
      solution = await generateSolutionWithDecomposition(
        event.issue.title,
        focusedPrompt,
        repoContext.promptSection,
        [],
        githubToken
      );
    } else {
      console.log(`[handler] Using remote LLM (single-shot)`);
      solution = await generateSolution(
        event.issue.title,
        event.issue.body || "(no description)",
        repoContext.promptSection
      );
    }

    metrics.recordLlmGeneration(solution.success, useLocal);

    if (!solution.success) {
      console.error(`[handler] LLM failed: ${solution.error}`);
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:blocked");
      await updateStatusComment(
        gh,
        repoFullName,
        issueNumber,
        "failed",
        "llm_generation",
        undefined,
        "Check the issue description and try again. Label \`needs-retry\` to attempt."
      );
      return;
    }

    console.log(`[handler] Solution: ${solution.files.length} file(s), branch ${solution.branchName}`);

    // Execute in worker
    const result = await worker.processIssue(event, solution, (progress: WorkerProgress) => {
      console.log(`[handler] ${progress.stage}: ${progress.message}`);
    });

    metrics.recordWorkerExecution(result.success);

    if (result.success) {
      // Check if PR exists on this branch
      const pr = await gh.getPullRequestForBranch(repoFullName, result.branchName);
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:awaiting-review");
      await updateStatusComment(
        gh,
        repoFullName,
        issueNumber,
        "pr-opened",
        undefined,
        pr?.url
      );
      metrics.recordIssueCompleted(result.branchName, Date.now() - startTime, repoFullName, issueNumber);
    } else {
      console.error(`[handler] Worker failed: ${result.error}`);
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:blocked");
      await updateStatusComment(
        gh,
        repoFullName,
        issueNumber,
        "failed",
        "worker_execution",
        undefined,
        "Container execution failed. Check bot logs and retry."
      );
      metrics.recordIssueFailed(result.error, Date.now() - startTime, repoFullName, issueNumber);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? redact(error.message) : String(error);
    console.error(`[handler] Unexpected error for ${issueKey}:`, errorMsg);
    metrics.recordIssueFailed(errorMsg, Date.now() - startTime, repoFullName, issueNumber);

    try {
      await setStatusLabel(gh, repoFullName, issueNumber, "bot:blocked");
      await updateStatusComment(
        gh,
        repoFullName,
        issueNumber,
        "failed",
        "unexpected",
        undefined,
        "An unexpected error occurred. Check bot logs."
      );
    } catch {
      console.error(`[handler] Failed to post error comment for ${issueKey}`);
    }
  } finally {
    processingIssues.delete(issueKey);
  }
}

export { handleIssue as default };
