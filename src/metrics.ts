export interface MetricsSnapshot {
  totalIssuesProcessed: number;
  issuesByStatus: {
    success: number;
    failed: number;
    queued: number;
    blocked: number;
  };
  llmGenerations: {
    total: number;
    success: number;
    failed: number;
    localModelUsed: number;
    remoteModelUsed: number;
  };
  workerExecutions: {
    total: number;
    success: number;
    failed: number;
  };
  recentActivity: Array<{
    id: string;
    timestamp: string;
    repo: string;
    issueNumber: number;
    action: string;
    status?: string;
    branch?: string;
    durationMs?: number;
  }>;
  uptimeSeconds: number;
  startTime: string;
  queueDepth: number;
}

interface ActivityEntry {
  id: string;
  timestamp: string;
  repo: string;
  issueNumber: number;
  action: string;
  status?: string;
  branch?: string;
  durationMs?: number;
}

export class MetricsCollector {
  private issuesProcessed = 0;
  private issuesByStatus = { success: 0, failed: 0, queued: 0, blocked: 0 };
  private llmGenerations = { total: 0, success: 0, failed: 0, localModelUsed: 0, remoteModelUsed: 0 };
  private workerExecutions = { total: 0, success: 0, failed: 0 };
  private recentActivity: ActivityEntry[] = [];
  private startTime: number;
  private maxRecentEntries = 100;
  private _queueDepth = 0;

  constructor() {
    this.startTime = Date.now();
  }

  recordIssueReceived(repo: string, issueNumber: number): void {
    this.addActivity(repo, issueNumber, "issue-received");
  }

  recordIssueProcessing(repo: string, issueNumber: number): void {
    this.addActivity(repo, issueNumber, "processing-started");
  }

  recordLlmGeneration(success: boolean, useLocalModel: boolean): void {
    this.llmGenerations.total++;
    if (success) {
      this.llmGenerations.success++;
    } else {
      this.llmGenerations.failed++;
    }
    if (useLocalModel) {
      this.llmGenerations.localModelUsed++;
    } else {
      this.llmGenerations.remoteModelUsed++;
    }
  }

  recordWorkerExecution(success: boolean): void {
    this.workerExecutions.total++;
    if (success) {
      this.workerExecutions.success++;
    } else {
      this.workerExecutions.failed++;
    }
  }

  recordIssueCompleted(branchName?: string, durationMs?: number, repo?: string, issueNumber?: number): void {
    this.issuesProcessed++;
    this.issuesByStatus.success++;
    this.addActivity(repo ?? "", issueNumber ?? 0, "issue-completed", "success", branchName, durationMs);
  }

  recordIssueFailed(error?: string, durationMs?: number, repo?: string, issueNumber?: number): void {
    this.issuesProcessed++;
    this.issuesByStatus.failed++;
    const action = error ? `issue-failed: ${error}` : "issue-failed";
    this.addActivity(repo ?? "", issueNumber ?? 0, action, "failed", undefined, durationMs);
  }

  recordQueue(): void {
    this.issuesByStatus.queued++;
  }

  recordBlocked(error?: string): void {
    this.issuesByStatus.blocked++;
    const action = error ? `blocked: ${error}` : "blocked";
    this.addActivity("", 0, action, "blocked", undefined);
  }

  private addActivity(
    repo: string,
    issueNumber: number,
    action: string,
    status?: string,
    branch?: string,
    durationMs?: number
  ): void {
    this.recentActivity.push({
      id: `${repo}#${issueNumber}-${action}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      repo,
      issueNumber,
      action,
      status,
      branch,
      durationMs,
    });

    if (this.recentActivity.length > this.maxRecentEntries) {
      this.recentActivity = this.recentActivity.slice(-this.maxRecentEntries);
    }
  }

  setQueueDepth(depth: number): void {
    this._queueDepth = depth;
  }

  getSnapshot(): MetricsSnapshot {
    return {
      totalIssuesProcessed: this.issuesProcessed,
      issuesByStatus: { ...this.issuesByStatus },
      llmGenerations: { ...this.llmGenerations },
      workerExecutions: { ...this.workerExecutions },
      recentActivity: this.recentActivity.slice(-20).map((a) => ({ ...a })),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      startTime: new Date(this.startTime).toISOString(),
      queueDepth: this._queueDepth,
    };
  }

  getRecentActivity(limit: number = 20): Array<{
    id: string;
    timestamp: string;
    repo: string;
    issueNumber: number;
    action: string;
    status?: string;
    branch?: string;
    durationMs?: number;
  }> {
    return this.recentActivity.slice(-limit).map((a) => ({ ...a }));
  }

  reset(): void {
    this.issuesProcessed = 0;
    this.issuesByStatus = { success: 0, failed: 0, queued: 0, blocked: 0 };
    this.llmGenerations = { total: 0, success: 0, failed: 0, localModelUsed: 0, remoteModelUsed: 0 };
    this.workerExecutions = { total: 0, success: 0, failed: 0 };
    this.recentActivity = [];
    this.startTime = Date.now();
  }
}

export const metrics = new MetricsCollector();
