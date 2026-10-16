import type { JobQueue } from "./queue.js";
import type { JobRecord, JsonQueueStore } from "./store.js";
import type { GitHubIssueEvent } from "./webhook.js";

/**
 * The single entry point for starting work on an issue. Everything that wants a job to run
 * (assignment, `needs-retry`, `/luci retry|plan|go`) goes through here, so the durable queue
 * enforces "one open job per issue" and the concurrency limit in one place.
 */

let store: JsonQueueStore | null = null;
let queue: JobQueue | null = null;

export function initDispatch(s: JsonQueueStore, q: JobQueue): void {
  store = s;
  queue = q;
}

export function resetDispatch(): void {
  store = null;
  queue = null;
}

export function isDispatchReady(): boolean {
  return store !== null && queue !== null;
}

export type EnqueueResult = { status: "queued"; jobId: string } | { status: "already_queued"; job: JobRecord } | { status: "unavailable" };

export function enqueueIssue(event: GitHubIssueEvent): EnqueueResult {
  if (!store || !queue) return { status: "unavailable" };
  const repo = event.repository.full_name;
  const open = store.getOpenJobPerIssue(repo, event.issue.number);
  if (open) return { status: "already_queued", job: open };
  const jobId = queue.enqueue(repo, event.issue.number, { event: event as unknown as Record<string, unknown> });
  return { status: "queued", jobId };
}

export function openJobFor(repo: string, issueNumber: number): JobRecord | undefined {
  return store?.getOpenJobPerIssue(repo, issueNumber);
}

export type CancelResult = "cancelled" | "cancelling" | "none";

/**
 * Cancel the open job for an issue. A queued job is dropped; a running job is marked cancelled
 * and the handler stops at its next checkpoint (before pushing anything).
 */
export function cancelIssue(repo: string, issueNumber: number): CancelResult {
  if (!store) return "none";
  const open = store.getOpenJobPerIssue(repo, issueNumber);
  if (!open) return "none";
  const wasRunning = open.status === "running";
  store.cancelJob(open.id);
  return wasRunning ? "cancelling" : "cancelled";
}

export function isJobCancelled(jobId: string | undefined): boolean {
  if (!store || !jobId) return false;
  return store.getJob(jobId)?.status === "cancelled";
}

/** Most recent job for an issue (any status). */
export function latestJobForIssue(repo: string, issueNumber: number): JobRecord | undefined {
  if (!store) return undefined;
  const jobs = store
    .getSnapshot()
    .jobs.filter((j) => j.repo === repo && j.issueNumber === issueNumber)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return jobs[0];
}

/** Payload shape stored with each job. */
export function eventFromJob(job: JobRecord): GitHubIssueEvent | null {
  const event = (job.payload as { event?: GitHubIssueEvent }).event;
  return event && typeof event === "object" && event.issue && event.repository ? event : null;
}
