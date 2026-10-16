import { JsonQueueStore, JobRecord, JobStatus } from "./store.js";
import { getConfig } from "./config.js";

export interface JobOutcome {
  success: boolean;
  prUrl?: string;
  error?: string;
  /** Finished without changes (e.g. nothing to commit, plan posted). Recorded as no_op. */
  noOp?: boolean;
  /** false = do not retry (bad input, refusal, validation). Default: retry until maxAttempts. */
  retryable?: boolean;
  /** Wait at least this long before the retry (e.g. the model endpoint is down). */
  retryDelayMs?: number;
}

export type JobProcessor = (job: JobRecord) => Promise<JobOutcome>;

export class JobQueue {
  private store: JsonQueueStore;
  private processor: JobProcessor | null = null;
  private running = false;
  private runningJobs = new Set<string>();
  private pendingRetries = 0;
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
    this.kick();
  }

  /** Start as many queued jobs as there are free slots. */
  kick(): void {
    const free = this.maxConcurrent - this.runningJobs.size;
    for (let i = 0; i < free; i++) void this.processNext();
  }

  /** Stop taking new jobs and wait (up to timeoutMs) for running ones to finish. */
  async stop(timeoutMs = 60_000): Promise<void> {
    this.running = false;
    const deadline = Date.now() + timeoutMs;
    while ((this.runningJobs.size > 0 || this.pendingRetries > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.runningJobs.size > 0) {
      console.log(`[queue] Shutdown timeout reached with ${this.runningJobs.size} job(s) still running`);
    }
  }

  isIdle(): boolean {
    return this.runningJobs.size === 0 && this.pendingRetries === 0 && this.getQueueDepth() === 0;
  }

  enqueue(repo: string, issueNumber: number, payload: Record<string, unknown>): string {
    const id = this.store.enqueueJob(repo, issueNumber, payload).id;
    this.kick();
    return id;
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

      const current = this.store.getJob(job.id);
      if (current?.status === "cancelled") {
        console.log(`[queue] Job ${job.id} was cancelled while running`);
      } else if (result.noOp) {
        this.store.noOpJob(job.id);
        console.log(`[queue] Job ${job.id} finished without changes`);
      } else if (result.success) {
        this.store.completeJob(job.id, result.prUrl);
        console.log(`[queue] Job ${job.id} succeeded`);
      } else if (result.retryable === false) {
        this.store.failJob(job.id, result.error ?? "failed");
        console.log(`[queue] Job ${job.id} failed (not retryable): ${result.error}`);
      } else {
        this.handleJobFailure(this.store.getJob(job.id) ?? job, result.error ?? "unknown_error", result.retryDelayMs);
      }
    } catch (error) {
      this.handleJobFailure(job, error instanceof Error ? error.message : String(error));
    } finally {
      this.runningJobs.delete(job.id);
      // Process next in the queue
      setImmediate(() => this.kick());
    }
  }

  private handleJobFailure(job: JobRecord, errorMsg: string, minDelayMs = 0): void {
    if (job.attempts < job.maxAttempts) {
      // Exponential backoff: 1s, 2s, 4s... (or longer when the outcome asks for it)
      const delay = Math.max(minDelayMs, Math.min(1000 * Math.pow(2, job.attempts - 1), 30_000));
      console.log(`[queue] Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}), retrying in ${delay}ms`);
      this.pendingRetries++;
      setTimeout(() => {
        this.pendingRetries--;
        if (this.store.getJob(job.id)?.status === "cancelled") return;
        this.store.requeueJob(job.id);
        this.kick();
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
