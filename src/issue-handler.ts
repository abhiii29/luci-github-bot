import { GitHubIssueEvent, onIssue } from "./webhook.js";
import { generateSolution, generateSolutionWithDecomposition, isLocalModelTrigger, extractLocalPrompt } from "./llm.js";
import { DockerWorker, WorkerResult, WorkerProgress, WorkerCapacity } from "./docker-worker.js";
import { getConfig } from "./config.js";
import { metrics } from "./metrics.js";
import { buildRepoContext } from "./repo-context.js";

const worker = new DockerWorker();

// Track which issues are being processed to avoid duplicates
const processingIssues = new Set<string>();

async function getRepoFileList(githubToken: string, repoFullName: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees/main?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!response.ok) {
      // Try master branch as fallback
      const fallback = await fetch(
        `https://api.github.com/repos/${repoFullName}/git/trees/master?recursive=1`,
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );
      if (!fallback.ok) return [];
      const data = await fallback.json();
      return (data.tree || [])
        .filter((item: any) => item.type === "blob" && !item.path.includes("node_modules") && !item.path.includes(".git"))
        .map((item: any) => item.path)
        .slice(0, 200); // Limit to avoid overwhelming the LLM
    }

    const data = await response.json();
    return (data.tree || [])
      .filter((item: any) => item.type === "blob" && !item.path.includes("node_modules") && !item.path.includes(".git"))
      .map((item: any) => item.path)
      .slice(0, 200);
  } catch (error) {
    console.error(`[handler] Failed to get file list:`, error);
    return [];
  }
}

async function commentOnIssue(githubToken: string, repoFullName: string, issueNumber: number, body: string): Promise<void> {
  try {
    await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      }
    );
  } catch (error) {
    console.error(`[handler] Failed to comment on issue:`, error);
  }
}

async function labelIssue(githubToken: string, repoFullName: string, issueNumber: number, label: string): Promise<void> {
  try {
    await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ labels: [label] }),
      }
    );
  } catch (error) {
    console.error(`[handler] Failed to label issue:`, error);
  }
}

export async function retryQueuedIssue(event: GitHubIssueEvent): Promise<void> {
  const config = getConfig();
  const { githubToken } = config;
  const repoFullName = event.repository.full_name;
  const issueNumber = event.issue.number;

  // Remove the needs-retry label so we don't loop
  try {
    const labelBody: { remove_labels: { name: string }[] } = {
      remove_labels: [{ name: "needs-retry" }],
    };
    await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(labelBody),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[handler] Failed to remove needs-retry label: ${msg}`);
  }

  // Clear any stale labels and re-process
  await labelIssue(githubToken, repoFullName, issueNumber, "queued");

  console.log(`[handler] Retrying queued issue ${repoFullName}#${issueNumber}`);
  await handleIssue(event);
}

export async function handleIssue(event: GitHubIssueEvent): Promise<void> {
  const config = getConfig();
  const { githubToken } = config;
  const repoFullName = event.repository.full_name;
  const issueNumber = event.issue.number;
  const issueKey = `${repoFullName}#${issueNumber}`;

  // Skip if already processing this issue
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
      console.log(`[handler] ${issueKey} rejected — all ${cap.max} worker slots occupied`);
      metrics.recordQueue();
      await commentOnIssue(
        githubToken,
        repoFullName,
        issueNumber,
        `⏳ **luci-github-bot** is currently at capacity (${cap.max}/${cap.max} slots occupied).\n\n\`${repoFullName}#${issueNumber}\` has been noted and will be processed when a slot becomes available. Please retry after a few minutes.\n\n💡 Tip: label this issue \`needs-retry\` and comment to trigger a new check.`
      );
      await labelIssue(githubToken, repoFullName, issueNumber, "queued");
      return;
    }

    // Label issue as in-progress
    await labelIssue(githubToken, repoFullName, issueNumber, "in-progress");
    await commentOnIssue(
      githubToken,
      repoFullName,
      issueNumber,
      `🤖 **luci-github-bot** is working on this issue...\n\n\`${repoFullName}#${issueNumber}\` — generating a solution. (${cap.available - 1} slot(s) remaining)`
    );

    console.log(`[handler] Generating solution for ${issueKey}...`);

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
        repoFullName,
        [],
        githubToken
      );
    } else {
      console.log(`[handler] Using remote LLM (single-shot)`);
      solution = await generateSolution(
        event.issue.title,
        event.issue.body || "(no description)",
        repoContext.promptSection,
      );
    }

    metrics.recordLlmGeneration(solution.success, useLocal);

    if (!solution.success) {
      console.error(`[handler] LLM failed to generate solution: ${solution.error}`);
      await commentOnIssue(
        githubToken,
        repoFullName,
        issueNumber,
        `❌ **luci-github-bot** could not generate a solution.\n\n**Error:** ${solution.error || "Unknown error"}\n\nPlease provide more details in the issue and label it \`needs-retry\` to try again.`
      );
      await labelIssue(githubToken, repoFullName, issueNumber, "blocked");
      return;
    }

    console.log(`[handler] Solution generated: ${solution.files.length} file(s) for branch ${solution.branchName}`);

    // Process the issue in a Docker container
    const result = await worker.processIssue(event, solution, (progress: WorkerProgress) => {
      console.log(`[handler] ${progress.stage}: ${progress.message}`);
    });

    metrics.recordWorkerExecution(result.success);

    if (result.success) {
      console.log(`[handler] PR created for ${issueKey}: ${result.branchName}`);
      const duration = Date.now() - startTime;
      metrics.recordIssueCompleted(result.branchName, duration, repoFullName, issueNumber);
      await commentOnIssue(
        githubToken,
        repoFullName,
        issueNumber,
        `✅ **luci-github-bot** completed this issue!\n\nA PR has been created with the changes. Please review and merge.\n\n**Branch:** \`${result.branchName}\`\n\n🔄 Status: \`awaiting-review\``
      );
      await labelIssue(githubToken, repoFullName, issueNumber, "awaiting-review");
    } else {
      console.error(`[handler] Worker failed for ${issueKey}: ${result.error}`);
      const duration = Date.now() - startTime;
      metrics.recordIssueFailed(result.error, duration, repoFullName, issueNumber);
      await commentOnIssue(
        githubToken,
        repoFullName,
        issueNumber,
        `❌ **luci-github-bot** encountered an error while working on this issue.\n\n**Error:** ${result.error}\n\nPlease check the bot logs and try again.`
      );
      await labelIssue(githubToken, repoFullName, issueNumber, "blocked");
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[handler] Unexpected error for ${issueKey}:`, errorMsg);

    const duration = Date.now() - startTime;
    metrics.recordIssueFailed(errorMsg, duration, repoFullName, issueNumber);

    try {
      await commentOnIssue(
        githubToken,
        repoFullName,
        issueNumber,
        `❌ **luci-github-bot** encountered an unexpected error:\n\n\`\`\`\n${errorMsg}\n\`\`\`\n\nPlease try again or check the bot logs.`
      );
    } catch {}
  } finally {
    processingIssues.delete(issueKey);
  }
}

// Handled by index.ts via onIssue()
export { handleIssue as default };
