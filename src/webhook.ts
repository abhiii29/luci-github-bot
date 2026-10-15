import crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { getConfig } from "./config.js";
import { DockerWorker } from "./docker-worker.js";
import { ResourceStats } from "./resource-monitor.js";
import { metrics } from "./metrics.js";
import { JsonQueueStore } from "./store.js";
import { parseDirectives } from "./directives.js";
import { loadRepoConfig } from "./repo-config.js";
import { logger } from "./logger.js";
import { redact } from "./redact.js";
import type { JobOptions } from "./types.js";

let dockerWorker: DockerWorker | null = null;
type RetryHandler = (event: GitHubIssueEvent) => Promise<void>;
let retryHandler: RetryHandler | null = null;
let queueStore: JsonQueueStore | null = null;

/** Cached result of collaborator/owner checks. */
const collaboratorCache = new Map<string, { isCollab: boolean; timestamp: number }>();
const COLLABORATOR_CACHE_TTL_MS = 300_000; // 5 min

const repoConfigCache = new Map<string, { result: import("./repo-config.js").RepoConfigResult; timestamp: number }>();
const REPO_CONFIG_CACHE_TTL_MS = 300_000;

export function setDockerWorker(worker: DockerWorker): void {
  dockerWorker = worker;
}

export function onRetry(handler: RetryHandler): void {
  retryHandler = handler;
}

export function setQueueStore(store: JsonQueueStore): void {
  queueStore = store;
}

export function __resetWebhookState(): void {
  handlers.length = 0;
  retryHandler = null;
  collaboratorCache.clear();
  repoConfigCache.clear();
}

/** Check whether a user is a collaborator/owner of a repo (cached). */
async function checkCollaborator(
  githubToken: string,
  repoFullName: string,
  username: string
): Promise<boolean> {
  const now = Date.now();
  const cacheKey = `${repoFullName}:${username}`;
  const cached = collaboratorCache.get(cacheKey);
  if (cached && now - cached.timestamp < COLLABORATOR_CACHE_TTL_MS) {
    return cached.isCollab;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/collaborators/${username}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
    const isCollab = res.ok;
    collaboratorCache.set(cacheKey, { isCollab, timestamp: now });
    return isCollab;
  } catch {
    collaboratorCache.set(cacheKey, { isCollab: false, timestamp: now });
    return false;
  }
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
    pull_request?: { url?: string };
  };
  repository: {
    full_name: string;
    clone_url: string;
    private: boolean;
  };
  sender: { login: string };
  changes?: { assignee?: { login?: string } };
  jobOptions?: JobOptions;
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

type IssueHandler = (event: GitHubIssueEvent) => Promise<void>;

const handlers: IssueHandler[] = [];

const ipRateLimit = new Map<string, { count: number; resetAt: number }>();

export function onIssue(handler: IssueHandler): void {
  handlers.push(handler);
}

function rateLimitMiddleware(
  windowMs: number,
  maxRequests: number
): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let entry = ipRateLimit.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      ipRateLimit.set(ip, entry);
    }

    entry.count++;

    if (entry.count > maxRequests) {
      logger.warn("[webhook] Rate limited", { ip: redact(ip) });
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    next();
  };
}

function authMiddleware(config: ReturnType<typeof getConfig>): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.apiToken) {
      const host = req.headers.host || "localhost";
      if (!host.includes("127.0.0.1") && !host.includes("localhost")) {
        logger.warn("[webhook] /api/* accessed remotely without API_TOKEN", { ip: req.ip });
        return res.status(403).json({ error: "API access denied" });
      }
      return next();
    }

    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${config.apiToken}`) {
      logger.warn("[webhook] Unauthorized /api/* access", { path: req.path });
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  };
}

export function createWebhookApp(config?: ReturnType<typeof getConfig>): express.Express {
  const appConfig = config ?? getConfig();
  const app = express();
  const realConfig = getConfig();

  app.use(express.json({
    limit: appConfig.webhookBodyLimit,
    verify: (req: Request, _res: Response, buf) => {
      (req as any).rawBody = buf;
    },
  }  ));

  app.use("/webhook", rateLimitMiddleware(
    realConfig.rateLimitWindowMs,
    realConfig.rateLimitMaxRequests
  ));

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
    (async (req: Request, res: Response) => {
      const signature =
        req.headers["x-hub-signature-256"] as string | undefined;

      if (!signature) {
        logger.warn("[webhook] Missing X-Hub-Signature-256 header");
        return res.status(400).json({ error: "Missing signature header" });
      }

        // Verify signature (handle length mismatch without throwing)
        const hmac = crypto.createHmac("sha256", appConfig.webhookSecret);
        const digest = "sha256=" + hmac.update((req as any).rawBody).digest("hex");
        const sigBuf = Buffer.from(signature);
        const digBuf = Buffer.from(digest);
        const sigValid = sigBuf.length === digBuf.length
          && crypto.timingSafeEqual(sigBuf, digBuf);

       if (!sigValid) {
         logger.error("[webhook] Signature verification failed");
         return res.status(401).json({ error: "Invalid signature" });
       }

      const eventType = req.headers["x-github-event"] as string;
      const deliveryId = req.headers["x-github-delivery"] as string;

      // Reject missing X-GitHub-Event header
      if (!eventType) {
        logger.warn("[webhook] Missing X-GitHub-Event header");
        return res.status(400).json({ error: "Missing X-GitHub-Event header" });
      }

      // Only handle issues events
      if (eventType !== "issues") {
        logger.info("[webhook] Ignoring event type: " + eventType);
        return res.status(200).json({ status: "ignored" });
      }

      const body = req.body as unknown;

      if (!isGitHubIssueEvent(body)) {
        logger.error("[webhook] Invalid issue event payload");
        return res.status(400).json({ error: "Invalid payload" });
      }

      const event = body;

      // Check if repo is monitored
      if (!appConfig.monitoredRepos.includes(event.repository.full_name)) {
        logger.info(
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
          logger.info(
            `[webhook] Retry triggered for issue #${event.issue.number} in ${event.repository.full_name}`
          );
          retryHandler(event).catch((error) => {
            logger.error(
              `[webhook] Retry handler error for issue #${event.issue.number}: ${redact(error instanceof Error ? error.message : String(error))}`
            );
          });
          return res.status(200).json({ status: "retry", action: event.action });
        }
      }

      if (event.action === "assigned" && event.issue.assignee) {
        // Skip if the bot assigned itself
        if (event.sender.login === appConfig.botUsername) {
          logger.info(
            `[webhook] Ignoring self-assignment #${event.issue.number}`
          );
          return res.status(200).json({ status: "ignored" });
        }

        // Skip closed issues
        if (event.issue.state === "closed") {
          logger.info(
            `[webhook] Ignoring closed issue #${event.issue.number}`
          );
          return res.status(200).json({ status: "ignored" });
        }

        // Skip pull requests (issues with pull_request field)
        if (event.issue.pull_request) {
          logger.info(
            `[webhook] Ignoring PR #${event.issue.number}`
          );
          return res.status(200).json({ status: "ignored" });
        }

        // Skip issues with bot:no-run label
        if (event.issue.labels.some((l) => l.name === "bot:no-run")) {
          logger.info(
            `[webhook] Ignoring issue #${event.issue.number} (bot:no-run)`
          );
          return res.status(200).json({ status: "ignored" });
        }

        // Skip reassignments from another user to the bot
        if (event.changes?.assignee?.login) {
          logger.info(
            `[webhook] Ignoring reassignment #${event.issue.number}`
          );
          return res.status(200).json({ status: "ignored" });
        }

        // Check assignee matches bot
        if (event.issue.assignee.login !== appConfig.botUsername) {
          logger.info(
            `[webhook] Ignoring assign #${event.issue.number} — assigned to ${event.issue.assignee.login}`
          );
          return res.status(200).json({ status: "ignored", assignee: event.issue.assignee.login });
        }

        const deliveryId = (req.headers["x-github-delivery"] as string) ?? "";
        if (queueStore && queueStore.deliveryReceived(deliveryId)) {
          console.log(`[webhook] Duplicate delivery ${deliveryId}, ignoring`);
          return res.status(200).json({ status: "ignored", reason: "duplicate" });
        }

        if (queueStore) {
          const openJob = queueStore.getOpenJobPerIssue(
            event.repository.full_name,
            event.issue.number
          );
          if (openJob) {
            console.log(
              `[webhook] Issue #${event.issue.number} already has open job ${openJob.id}, ignoring`
            );
            return res.status(200).json({ status: "ignored", reason: "already_queued" });
          }
          queueStore.enqueue(
            event.repository.full_name,
            event.issue.number,
            { action: event.action, title: event.issue.title }
          );
          metrics.recordQueue();
          return res.status(200).json({ status: "queued" });
        }

        logger.info(
          `[webhook] Bot assigned issue #${event.issue.number} in ${event.repository.full_name}: ${event.issue.title}`
        );

        // Parse per-repo config and directives
        const [repoConfigResult, directivesResult] = await Promise.all([
          loadRepoConfig(
            appConfig.githubToken,
            event.repository.full_name,
            repoConfigCache,
            REPO_CONFIG_CACHE_TTL_MS
          ),
          checkCollaborator(
            appConfig.githubToken,
            event.repository.full_name,
            event.issue.user.login
          ).then((isCollab) =>
            parseDirectives(
              event.issue.title,
              event.issue.body,
              isCollab
            )
          ),
        ]);

        event.jobOptions = directivesResult.jobOptions;

        handlers.forEach(async (handler) => {
          try {
            await handler(event);
          } catch (error) {
            logger.error(
              `[webhook] Handler error for issue #${event.issue.number}: ${redact(error instanceof Error ? error.message : String(error))}`
            );
          }
        });
        return res.status(200).json({ status: "accepted" });
      }

      return res.status(200).json({ status: "ignored" });
    })
  );

  // Health check endpoint (public, coarse info only)
  app.get("/health", (_req: Request, res: Response) => {
    const stats = getHealthStats();
    res.json({ status: stats.status, timestamp: stats.timestamp, capacity: stats.capacity });
  });

  // Auth middleware for /api/* routes
  app.use("/api", authMiddleware(realConfig));

  // Stats endpoint
  app.get("/api/stats", (_req: Request, res: Response) => {
    res.json(metrics.getSnapshot());
  });

  // Recent activity endpoint
  app.get("/api/activity", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(metrics.getRecentActivity(Math.min(limit, 100)));
  });

  return app;
}
