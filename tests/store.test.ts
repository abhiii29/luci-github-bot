import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JsonQueueStore, type JobStatus } from "../src/store.js";
import * as fs from "fs";
import * as path from "path";

const TEST_DIR = "/tmp/luci-store-test-" + Date.now();

function mkDb(name: string): string {
  const db = path.join(TEST_DIR, name + ".json");
  if (fs.existsSync(db)) fs.unlinkSync(db);
  return db;
}

beforeEach(() => {
  try { fs.mkdirSync(TEST_DIR, { recursive: true }); } catch { /* */ }
});

afterEach(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
});

describe("JsonQueueStore", () => {
  describe("delivery dedup", () => {
    it("returns false for first delivery", () => {
      const store = new JsonQueueStore(mkDb("del-1"), 1000);
      expect(store.deliveryReceived("del-1")).toBe(false);
    });

    it("returns true for duplicate delivery", () => {
      const store = new JsonQueueStore(mkDb("del-2"), 1000);
      store.deliveryReceived("del-2");
      expect(store.deliveryReceived("del-2")).toBe(true);
    });
  });

  describe("enqueue and query", () => {
    it("enqueues a job and finds it by ID", () => {
      const store = new JsonQueueStore(mkDb("enq-1"), 1000);
      const jobId = store.enqueue("owner/repo", 42, { title: "test" });
      const job = store.getJob(jobId);
      expect(job?.status).toBe("queued");
      expect(job?.repo).toBe("owner/repo");
      expect(job?.issueNumber).toBe(42);
    });

    it("returns undefined for unknown job", () => {
      const store = new JsonQueueStore(mkDb("enq-2"), 1000);
      expect(store.getJob("nonexistent")).toBeUndefined();
    });

    it("enqueues multiple jobs and finds earliest by creation order", () => {
      const store = new JsonQueueStore(mkDb("enq-3"), 1000);
      const jobId1 = store.enqueue("a/b", 1, {});
      store.enqueue("a/b", 2, {});
      store.enqueue("a/b", 3, {});
      const first = store.getNextQueuedJob("a/b");
      expect(first?.id).toBe(jobId1);
    });
  });

  describe("job state transitions", () => {
    it("startJob sets running status", () => {
      const store = new JsonQueueStore(mkDb("state-start"), 1000);
      const jobId = store.enqueue("a/b", 1, {});
      store.startJob(jobId);
      expect(store.getJob(jobId)?.status).toBe("running");
    });

    it("completeJob sets succeeded with PR URL", () => {
      const store = new JsonQueueStore(mkDb("state-complete"), 1000);
      const jobId = store.enqueue("a/b", 1, {});
      store.startJob(jobId);
      store.completeJob(jobId, "https://github.com/.../pull/5");
      const completed = store.getJob(jobId)!;
      expect(completed.status).toBe("succeeded");
      expect(completed.prUrl).toBe("https://github.com/.../pull/5");
      expect(completed.completedAt).toBeDefined();
    });

    it("failJob sets failed with error category", () => {
      const store = new JsonQueueStore(mkDb("state-fail"), 1000);
      const jobId = store.enqueue("a/b", 1, {});
      store.startJob(jobId);
      store.failJob(jobId, "llm_error");
      const failed = store.getJob(jobId)!;
      expect(failed.status).toBe("failed");
      expect(failed.errorCategory).toBe("llm_error");
    });

    it("noOpJob sets no_op", () => {
      const store = new JsonQueueStore(mkDb("state-noop"), 1000);
      const jobId = store.enqueue("a/b", 1, {});
      store.noOpJob(jobId);
      expect(store.getJob(jobId)?.status).toBe("no_op");
    });

    it("requeueJob returns to queued", () => {
      const store = new JsonQueueStore(mkDb("state-requeue"), 1000);
      const jobId = store.enqueue("a/b", 1, {});
      store.startJob(jobId);
      store.requeueJob(jobId);
      expect(store.getJob(jobId)?.status).toBe("queued");
    });

    it("cancelJob sets cancelled", () => {
      const store = new JsonQueueStore(mkDb("state-cancel"), 1000);
      const jobId = store.enqueue("a/b", 1, {});
      store.cancelJob(jobId);
      expect(store.getJob(jobId)?.status).toBe("cancelled");
    });
  });

  describe("getOpenJobPerIssue", () => {
    it("finds open running job for issue", () => {
      const store = new JsonQueueStore(mkDb("open-1"), 1000);
      const jobId = store.enqueue("a/b", 5, {});
      store.startJob(jobId);
      expect(store.getOpenJobPerIssue("a/b", 5)?.id).toBe(jobId);
    });

    it("ignores completed jobs for same issue", () => {
      const store = new JsonQueueStore(mkDb("open-2"), 1000);
      const jobId = store.enqueue("a/b", 5, {});
      store.completeJob(jobId);
      expect(store.getOpenJobPerIssue("a/b", 5)).toBeUndefined();
    });

    it("ignores jobs from other issues", () => {
      const store = new JsonQueueStore(mkDb("open-3"), 1000);
      const jobId5 = store.enqueue("a/b", 5, {});
      const jobId6 = store.enqueue("a/b", 6, {});
      store.startJob(jobId6);
      // Issue 5 has an open queued job
      expect(store.getOpenJobPerIssue("a/b", 5)?.id).toBe(jobId5);
      // Issue 6 has an open running job
      expect(store.getOpenJobPerIssue("a/b", 6)?.id).toBe(jobId6);
      // Issue 7 has no jobs
      expect(store.getOpenJobPerIssue("a/b", 7)).toBeUndefined();
    });
  });

  describe("recoverInterrupted", () => {
    it("recovers jobs stuck running beyond timeout", () => {
      const db = mkDb("recover-1");
      const store = new JsonQueueStore(db, 86400000);
      const jobId = store.enqueue("a/b", 1, {});
      store.startJob(jobId);

      // Backdate startedAt directly in file
      const raw = JSON.parse(fs.readFileSync(db, "utf-8"));
      raw.jobs[0].startedAt = new Date(Date.now() - 600_000).toISOString();
      fs.writeFileSync(db, JSON.stringify(raw, null, 2));

      const store2 = new JsonQueueStore(db, 86400000);
      const recovered = store2.recoverInterrupted(300_000);
      expect(recovered.length).toBe(1);
      expect(store2.getJob(jobId)?.status).toBe("failed");
      expect(store2.getJob(jobId)?.errorCategory).toBe("interrupted");
    });

    it("does not recover jobs within timeout", () => {
      const store = new JsonQueueStore(mkDb("recover-2"), 86400000);
      store.enqueue("a/b", 1, {});
      const jobId = store.enqueue("a/b", 2, {});
      store.startJob(jobId);
      const recovered = store.recoverInterrupted(300_000);
      expect(recovered.length).toBe(0);
    });
  });

  describe("getJobCountByStatus", () => {
    it("counts jobs by status", () => {
      const store = new JsonQueueStore(mkDb("counts-1"), 86400000);
      store.enqueue("a/b", 1, {});
      const jobId = store.enqueue("a/b", 2, {});
      store.startJob(jobId);
      store.completeJob(jobId);
      const counts = store.getJobCountByStatus();
      expect(counts.queued).toBe(1);   // job 1 still queued
      expect(counts.running).toBe(0);   // job 2 was started then completed
      expect(counts.succeeded).toBe(1); // job 2 completed
      expect(counts.failed).toBe(0);
    });
  });

  describe("persistence", () => {
    it("survives restart", () => {
      const db = mkDb("persist-1");
      const store = new JsonQueueStore(db);
      store.enqueue("a/b", 1, {});
      store.save();
      const store2 = new JsonQueueStore(db);
      const job = store2.getNextQueuedJob("a/b");
      expect(job).toBeDefined();
      expect(job?.issueNumber).toBe(1);
    });
  });
});
