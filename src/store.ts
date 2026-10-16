import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DEFAULT_DB_PATH = path.join(process.cwd(), ".luci-queue.json");

// ── Types ──────────────────────────────────────────────────────────────

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "no_op";
export type DeliveryStatus = "received" | "expired";

export interface JobRecord {
  id: string;
  repo: string;
  issueNumber: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  errorCategory?: string;
  prUrl?: string;
}

export interface DeliveryRecord {
  id: string;
  deliveryId: string; // X-GitHub-Delivery header
  receivedAt: string;
  status: DeliveryStatus;
}

export interface QueueStore {
  jobs: JobRecord[];
  deliveries: DeliveryRecord[];
}

// ── Store implementation ──────────────────────────────────────────────

function loadStore(dbPath: string): QueueStore {
  try {
    const raw = fs.readFileSync(dbPath, "utf-8");
    const store: QueueStore = JSON.parse(raw);
    if (!Array.isArray(store.jobs)) store.jobs = [];
    if (!Array.isArray(store.deliveries)) store.deliveries = [];
    return store;
  } catch {
    return { jobs: [], deliveries: [] };
  }
}

function saveStore(dbPath: string, store: QueueStore): void {
  const tmpPath = dbPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, dbPath);
}

export class JsonQueueStore {
  private dbPath: string;
  private store: QueueStore;
  private ttlMs: number;

  constructor(dbPath?: string, ttlMs = 86_400_000) { // 24h delivery TTL
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
    this.ttlMs = ttlMs;
    this.store = loadStore(this.dbPath);
    this.cleanupDeliveries();
  }

  private cleanupDeliveries(): void {
    const cutoff = Date.now() - this.ttlMs;
    this.store.deliveries = this.store.deliveries.filter(
      (d) => new Date(d.receivedAt).getTime() > cutoff
    );
  }

  // ── Delivery dedup ──────────────────────────────────────────────────

  deliveryReceived(deliveryId: string): boolean {
    if (this.store.deliveries.some((d) => d.deliveryId === deliveryId && d.status === "received")) {
      return true;
    }
    this.store.deliveries.push({
      id: randomUUID(),
      deliveryId,
      receivedAt: new Date().toISOString(),
      status: "received",
    });
    saveStore(this.dbPath, this.store);
    return false;
  }

  // ── Job queries ─────────────────────────────────────────────────────

  getJob(id: string): JobRecord | undefined {
    return this.store.jobs.find((j) => j.id === id);
  }

  getNextQueuedJob(repo?: string): JobRecord | undefined {
    const filtered = repo
      ? this.store.jobs.filter((j) => j.repo === repo && j.status === "queued")
      : this.store.jobs.filter((j) => j.status === "queued");
    return filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
  }

  getRunningJobs(repo?: string): JobRecord[] {
    return this.store.jobs.filter(
      (j) => j.status === "running" && (!repo || j.repo === repo)
    );
  }

  getOpenJobPerIssue(repo: string, issueNumber: number): JobRecord | undefined {
    return this.store.jobs.find(
      (j) => j.repo === repo && j.issueNumber === issueNumber && j.status !== "succeeded" && j.status !== "failed" && j.status !== "cancelled" && j.status !== "no_op"
    );
  }

  getJobsByStatus(status: JobStatus): JobRecord[] {
    return this.store.jobs.filter((j) => j.status === status);
  }

  getJobCountByStatus(): Record<JobStatus, number> {
    const counts: Record<string, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, no_op: 0 };
    for (const j of this.store.jobs) {
      if (j.status in counts) counts[j.status]++;
    }
    return counts as Record<JobStatus, number>;
  }

  // ── Job mutations ───────────────────────────────────────────────────

  enqueue(repo: string, issueNumber: number, payload: Record<string, unknown>): string {
    return this.enqueueJob(repo, issueNumber, payload).id;
  }

  enqueueJob(repo: string, issueNumber: number, payload: Record<string, unknown>, maxAttempts: number = 2): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      repo,
      issueNumber,
      status: "queued",
      attempts: 0,
      maxAttempts,
      payload,
      createdAt: now,
      updatedAt: now,
    };
    this.store.jobs.push(job);
    saveStore(this.dbPath, this.store);
    return job;
  }

  startJob(id: string): void {
    const job = this.getJob(id);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = "running";
    job.attempts++;
    job.startedAt = now;
    job.updatedAt = now;
    saveStore(this.dbPath, this.store);
  }

  completeJob(id: string, prUrl?: string): void {
    const job = this.getJob(id);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = "succeeded";
    job.completedAt = now;
    job.updatedAt = now;
    job.prUrl = prUrl;
    saveStore(this.dbPath, this.store);
  }

  failJob(id: string, errorCategory?: string): void {
    const job = this.getJob(id);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = "failed";
    job.errorCategory = errorCategory;
    job.completedAt = now;
    job.updatedAt = now;
    saveStore(this.dbPath, this.store);
  }

  noOpJob(id: string): void {
    const job = this.getJob(id);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = "no_op";
    job.completedAt = now;
    job.updatedAt = now;
    saveStore(this.dbPath, this.store);
  }

  requeueJob(id: string): void {
    const job = this.getJob(id);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = "queued";
    job.startedAt = undefined;
    job.completedAt = undefined;
    job.updatedAt = now;
    saveStore(this.dbPath, this.store);
  }

  cancelJob(id: string): void {
    const job = this.getJob(id);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = "cancelled";
    job.completedAt = now;
    job.updatedAt = now;
    saveStore(this.dbPath, this.store);
  }

  // ── Startup recovery ────────────────────────────────────────────────

  /**
   * Called once at startup: any job still marked `running` was orphaned by the previous process.
   * Re-queue it if it has attempts left, otherwise fail it as `interrupted`.
   */
  recoverInterrupted(_timeoutMs?: number): JobRecord[] {
    const now = new Date().toISOString();
    const interrupted: JobRecord[] = [];
    for (const job of this.store.jobs) {
      if (job.status !== "running") continue;
      if (job.attempts < job.maxAttempts) {
        job.status = "queued";
        job.startedAt = undefined;
      } else {
        job.status = "failed";
        job.errorCategory = "interrupted";
        job.completedAt = now;
      }
      job.updatedAt = now;
      interrupted.push(job);
    }
    if (interrupted.length > 0) saveStore(this.dbPath, this.store);
    return interrupted;
  }

  /**
   * GitHub Action mode: a run always drains its queue before exiting, so any job still open in the
   * restored state belongs to a run that was cancelled or killed. Fail it instead of re-running it
   * (cancelling the workflow run is how a running job is stopped in that mode).
   */
  abandonOpenJobs(): JobRecord[] {
    const now = new Date().toISOString();
    const abandoned = this.store.jobs.filter((j) => j.status === "running" || j.status === "queued");
    for (const job of abandoned) {
      job.status = "failed";
      job.errorCategory = "interrupted";
      job.completedAt = now;
      job.updatedAt = now;
    }
    if (abandoned.length > 0) saveStore(this.dbPath, this.store);
    return abandoned;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  save(): void {
    saveStore(this.dbPath, this.store);
  }

  getSnapshot(): QueueStore {
    return { jobs: [...this.store.jobs], deliveries: [...this.store.deliveries] };
  }
}
