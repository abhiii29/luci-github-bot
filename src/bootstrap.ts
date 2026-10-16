import { setDockerWorker, onIssue, onRetry, onComment, onIssueEdited, onQueued, setQueueStore } from "./webhook.js";
import { handleIssue, retryQueuedIssue, markIssueQueued, setIssueWorker } from "./issue-handler.js";
import { handleIssueComment } from "./command-handler.js";
import { initDispatch, enqueueIssue, eventFromJob, isJobCancelled } from "./dispatch.js";
import { computeJobOptions } from "./job-context.js";
import { getPlanState, hashIssueBody, invalidatePlan } from "./plan.js";
import { GitHubClient } from "./github.js";
import type { Config } from "./config.js";
import { DockerWorker } from "./docker-worker.js";
import { JsonQueueStore } from "./store.js";
import { JobQueue } from "./queue.js";
import { logger } from "./logger.js";

export interface Bot {
  worker: DockerWorker;
  store: JsonQueueStore;
  queue: JobQueue;
}

/**
 * Build the worker, durable queue and event handlers. Shared by the webhook server (`index.ts`)
 * and the GitHub Action entrypoint (`action.ts`); callers decide how events arrive.
 */
export async function setupBot(config: Config, store: JsonQueueStore): Promise<Bot> {
  // One worker (one semaphore + resource monitor) shared by the whole bot
  const worker = new DockerWorker();
  setDockerWorker(worker);
  setIssueWorker(worker);
  await worker.ensureImage();
  logger.info("[init] Worker ready");

  // Durable queue: every job (assignment, retry, /luci command) goes through it
  const queue = new JobQueue(store, config.maxConcurrentWorkers);
  queue.setProcessor(async (job) => {
    const event = eventFromJob(job);
    if (!event) return { success: false, error: "invalid_job_payload", retryable: false };
    return handleIssue(event, {
      isCancelled: () => isJobCancelled(job.id),
      willRetry: job.attempts < job.maxAttempts, // attempts is incremented when the job is claimed
    });
  });
  initDispatch(store, queue);

  onIssue(handleIssue); // only used when no queue is configured
  onQueued(markIssueQueued);
  onComment(handleIssueComment);
  onRetry(async (event) => {
    event.jobOptions = await computeJobOptions(event, config.githubToken);
    const r = enqueueIssue(event);
    if (r.status === "queued") await retryQueuedIssue(event);
  });
  onIssueEdited(async (event) => {
    const [owner, repo] = event.repository.full_name.split("/");
    const before = getPlanState(owner, repo, event.issue.number);
    if (!before || before.status !== "pending") return;
    const after = invalidatePlan(owner, repo, event.issue.number, hashIssueBody(event.issue.body ?? ""));
    if (after?.status === "expired") {
      await new GitHubClient({ token: config.githubToken })
        .createComment(
          event.repository.full_name,
          event.issue.number,
          "📝 The issue changed, so the pending plan is no longer valid. Reply `/luci plan` to re-plan."
        )
        .catch(() => {});
    }
  });
  setQueueStore(store);

  return { worker, store, queue };
}
