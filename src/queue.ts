import { JsonQueueStore, JobRecord, JobStatus } from "./store.js";
import { getConfig } from "./config.js";

export type JobProcessor = (job: JobRecord) => Promise<{ success: boolean; prUrl?: string; error?: string }>;

export class JobQueue {
  private store: JsonQueueStore;
  private processor: JobProcessor | null = null;
  private running = false;
  private runningJobs = new Set<string>();
  private maxConcurrent: number;

  constructor(store: JsonQueueStore, maxConcurrent: number = 1) {
    this.store = store;
    this.maxConcurrent = maxConcurrent;
  }

  setProcessor(processor: JobProcessor): void {
    this.processor = processor;
  }

  async start(): Promise<void> {
    this.running = true;
    this.processNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    // Wait for running jobs to finish with a timeout
    if (this.runningJobs.size > 0) {
      const timeout = setTimeout(() => {
        console.log("[queue] Shutdown timeout reached, stopping jobs");
      }, 60_000);
      // Don't block — jobs will complete naturally
      clearTimeout(timeout);
    }
  }

  enqueue(repo: string, issueNumber: number, payload: Record<string, unknown>): string {
    return this.store.enqueueJob(repo, issueNumber, payload).id;
  }

  async processNext(): Promise<void> {
    if (!this.running || !this.processor) return;
    if (this.runningJobs.size >= this.maxConcurrent) return;

    const job = this.store.getNextQueuedJob();
    if (!job) return;

    this.runningJobs.add(job.id);
    this.store.startJob(job.id);

    try {
      console.log(`[queue] Processing job ${job.id} for ${job.repo}#${job.issueNumber}`);
      const result = await this.processor(job);

      if (result.success) {
        this.store.completeJob(job.id, result.prUrl);
        console.log(`[queue] Job ${job.id} succeeded`);
      } else {
        this.handleJobFailure(job, result.error ?? "unknown_error");
      }
    } catch (error) {
      this.handleJobFailure(job, error instanceof Error ? error.message : String(error));
    } finally {
      this.runningJobs.delete(job.id);
      // Process next in the queue
      setImmediate(() => this.processNext());
    }
  }

  private handleJobFailure(job: JobRecord, errorMsg: string): void {
    if (job.attempts < job.maxAttempts) {
      // Exponential backoff: 1s, 2s, 4s...
      const delay = Math.min(1000 * Math.pow(2, job.attempts - 1), 30_000);
      console.log(`[queue] Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}), retrying in ${delay}ms`);
      setTimeout(() => {
        this.store.requeueJob(job.id);
        this.processNext();
      }, delay);
    } else {
      this.store.failJob(job.id, "exceeded_max_attempts");
      console.error(`[queue] Job ${job.id} permanently failed after ${job.attempts} attempts: ${errorMsg}`);
    }
  }

  getQueueDepth(): number {
    return this.store.getJobCountByStatus().queued;
  }

  getJobsByStatus(status: JobStatus): JobRecord[] {
    return this.store.getJobsByStatus(status);
  }

  getJob(id: string): JobRecord | undefined {
    return this.store.getJob(id);
  }
}
