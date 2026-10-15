import crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { getConfig } from "./config.js";
import { DockerWorker } from "./docker-worker.js";
import { ResourceStats } from "./resource-monitor.js";

let dockerWorker: DockerWorker | null = null;
type RetryHandler = (event: GitHubIssueEvent) => Promise<void>;
let retryHandler: RetryHandler | null = null;

export function setDockerWorker(worker: DockerWorker): void {
  dockerWorker = worker;
}

export function onRetry(handler: RetryHandler): void {
  retryHandler = handler;
}

export type HealthStats = {
  status: "ok" | "degraded";
  timestamp: string;
  capacity?: { available: number; max: number; full: boolean };
  resources?: ResourceStats;
};

export function getHealthStats(): HealthStats {
  const stats: HealthStats = { status: "ok", timestamp: new Date().toISOString() };

  if (dockerWorker) {
    stats.capacity = dockerWorker.getCapacity();
    stats.resources = dockerWorker.getStats();
    if (stats.capacity?.full) {
      stats.status = "degraded";
    }
  }

  return stats;
}

// Issue event payload from GitHub (simplified)
export interface GitHubIssueEvent {
  action: "opened" | "edited" | "assigned" | "labeled";
  issue: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    labels: { name: string }[];
    assignee?: { login: string };
    html_url: string;
    user: { login: string };
    created_at: string;
    updated_at: string;
  };
  repository: {
    full_name: string;
    clone_url: string;
    private: boolean;
  };
  sender: { login: string };
}

// Type guard for webhook event
function isGitHubIssueEvent(body: unknown): body is GitHubIssueEvent {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  return (
    "action" in obj &&
    "issue" in obj &&
    typeof obj.issue === "object" &&
    obj.issue !== null &&
    "number" in (obj.issue as Record<string, unknown>) &&
    "repository" in obj &&
    typeof obj.repository === "object"
  );
}

// Webhook handler registry
type IssueHandler = (event: GitHubIssueEvent) => Promise<void>;

const handlers: IssueHandler[] = [];

export function onIssue(handler: IssueHandler): void {
  handlers.push(handler);
}

export function createWebhookApp(): express.Express {
  const app = express();
  const config = getConfig();

  // Parse JSON bodies
  app.use(express.json({
    verify: (req: Request, _res: Response, buf) => {
      (req as any).rawBody = buf;
    },
  }));

  // Webhook endpoint
  app.post(
    "/webhook",
    (err: any, _req: Request, res: Response, next: NextFunction) => {
      if (err) {
        return res.status(400).json({ error: "Failed to parse JSON body" });
      }
      next();
    },
    (req: Request, res: Response) => {
      const signature =
        req.headers["x-hub-signature-256"] as string | undefined;

      if (!signature) {
        console.error("[webhook] Missing X-Hub-Signature-256 header");
        return res.status(400).json({ error: "Missing signature header" });
      }

      // Verify signature
      const hmac = crypto.createHmac("sha256", config.webhookSecret);
      const digest = "sha256=" + hmac.update((req as any).rawBody).digest("hex");

      try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
          console.error("[webhook] Signature verification failed");
          return res.status(401).json({ error: "Invalid signature" });
        }
      } catch (e) {
        console.error("[webhook] Signature comparison error:", e);
        return res.status(401).json({ error: "Signature verification failed" });
      }

      const eventType = req.headers["x-github-event"] as string;
      const deliveryId = req.headers["x-github-delivery"] as string;

      // Only handle issues events
      if (eventType !== "issues") {
        console.log(`[webhook] Ignoring event type: ${eventType}`);
        return res.status(200).json({ status: "ignored" });
      }

      const body = req.body as unknown;

      if (!isGitHubIssueEvent(body)) {
        console.error("[webhook] Invalid issue event payload");
        return res.status(400).json({ error: "Invalid payload" });
      }

      const event = body;

      // Check if repo is monitored
      if (!config.monitoredRepos.includes(event.repository.full_name)) {
        console.log(
          `[webhook] Ignoring issue #${event.issue.number} from unmonitored repo: ${event.repository.full_name}`
        );
        return res.status(200).json({ status: "ignored", repo: event.repository.full_name });
      }

      // Handle retry trigger: needs-retry label on an open issue
      if (event.action === "edited" && event.issue.state === "open") {
        const hasRetryLabel = event.issue.labels.some(
          (l) => l.name === "needs-retry"
        );
        if (hasRetryLabel && retryHandler) {
          console.log(
            `[webhook] Retry triggered for issue #${event.issue.number} in ${event.repository.full_name}`
          );
          retryHandler(event).catch((error) => {
            console.error(
              `[webhook] Retry handler error for issue #${event.issue.number}:`,
              error
            );
          });
          return res.status(200).json({ status: "retry", action: event.action });
        }
      }

      if (event.action === "assigned" && event.issue.assignee) {
        if (event.issue.assignee.login !== config.botUsername) {
          console.log(
            `[webhook] Ignoring assign #${event.issue.number} — assigned to ${event.issue.assignee.login}`
          );
          return res.status(200).json({ status: "ignored", assignee: event.issue.assignee.login });
        }
        console.log(
          `[webhook] Bot assigned issue #${event.issue.number} in ${event.repository.full_name}: ${event.issue.title}`
        );
        handlers.forEach(async (handler) => {
          try {
            await handler(event);
          } catch (error) {
            console.error(
              `[webhook] Handler error for issue #${event.issue.number}:`,
              error
            );
          }
        });
        return res.status(200).json({ status: "accepted" });
      }

      return res.status(200).json({ status: "ignored" });
    }
  );

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json(getHealthStats());
  });

  return app;
}
