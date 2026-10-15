import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "../src/metrics.js";

function makeEnv(overrides?: Record<string, string>): void {
  // Ensure WEBHOOK_SECRET for getConfig
  if (!process.env.WEBHOOK_SECRET) process.env.WEBHOOK_SECRET = "test-secret";
  if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = "ghp_test1234567890";
  if (!process.env.ADASSO_BASE_URL) process.env.ADASSO_BASE_URL = "http://localhost:8080/v1";
  for (const [k, v] of Object.entries(overrides ?? {})) {
    process.env[k] = v;
  }
}

describe("MetricsCollector", () => {
  let m: MetricsCollector;

  beforeEach(() => {
    makeEnv();
    m = new MetricsCollector();
  });

  it("records issue received", () => {
    m.recordIssueReceived("owner/repo", 42);
    const snap = m.getSnapshot();
    expect(snap.recentActivity).toHaveLength(1);
    expect(snap.recentActivity[0].action).toBe("issue-received");
  });

  it("records processing started", () => {
    m.recordIssueProcessing("owner/repo", 42);
    expect(m.getSnapshot().recentActivity.at(-1)?.action).toBe("processing-started");
  });

  it("records LLM generation success", () => {
    m.recordLlmGeneration(true, false);
    const snap = m.getSnapshot();
    expect(snap.llmGenerations.total).toBe(1);
    expect(snap.llmGenerations.success).toBe(1);
    expect(snap.llmGenerations.failed).toBe(0);
  });

  it("records LLM generation failure with local model", () => {
    m.recordLlmGeneration(false, true);
    const snap = m.getSnapshot();
    expect(snap.llmGenerations.failed).toBe(1);
    expect(snap.llmGenerations.localModelUsed).toBe(1);
  });

  it("records worker execution success", () => {
    m.recordWorkerExecution(true);
    const snap = m.getSnapshot();
    expect(snap.workerExecutions.total).toBe(1);
    expect(snap.workerExecutions.success).toBe(1);
  });

  it("records issue completed", () => {
    m.recordIssueCompleted("feat/x", 100, "owner/repo", 5);
    const snap = m.getSnapshot();
    expect(snap.totalIssuesProcessed).toBe(1);
    expect(snap.issuesByStatus.success).toBe(1);
    expect(snap.recentActivity.at(-1)?.action).toBe("issue-completed");
    expect(snap.recentActivity.at(-1)?.branch).toBe("feat/x");
    expect(snap.recentActivity.at(-1)?.durationMs).toBe(100);
  });

  it("records issue failed", () => {
    m.recordIssueFailed("timeout", 50, "owner/repo", 10);
    const snap = m.getSnapshot();
    expect(snap.totalIssuesProcessed).toBe(1);
    expect(snap.issuesByStatus.failed).toBe(1);
  });

  it("records queue and blocked", () => {
    m.recordQueue();
    m.recordBlocked("rate limited");
    const snap = m.getSnapshot();
    expect(snap.issuesByStatus.queued).toBe(1);
    expect(snap.issuesByStatus.blocked).toBe(1);
  });

  it("getSnapshot returns uptime and startTime", () => {
    const snap = m.getSnapshot();
    expect(typeof snap.uptimeSeconds).toBe("number");
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snap.startTime).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("getRecentActivity respects limit", () => {
    for (let i = 0; i < 10; i++) {
      m.recordIssueReceived("r", i);
    }
    expect(m.getRecentActivity(5).length).toBe(5);
  });

  it("reset clears all state", () => {
    m.recordIssueReceived("r", 1);
    m.recordIssueCompleted();
    m.reset();
    const snap = m.getSnapshot();
    expect(snap.totalIssuesProcessed).toBe(0);
    expect(snap.recentActivity).toHaveLength(0);
  });

  it("caps recent activity at maxRecentEntries (100) internally", () => {
    for (let i = 0; i < 110; i++) {
      m.recordIssueReceived("r", i);
    }
    // Internal array is capped at 100
    expect(m.getRecentActivity(200).length).toBe(100);
    // getSnapshot caps at 20
    expect(m.getSnapshot().recentActivity.length).toBe(20);
  });
});
