import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { getConfig } from "./config.js";
import { DockerWorker } from "./docker-worker.js";
import { ResourceStats } from "./resource-monitor.js";
import { metrics } from "./metrics.js";
import { JsonQueueStore } from "./store.js";
import { clearCollaboratorCache } from "./collaborators.js";
import { computeJobOptions, clearRepoConfigCache } from "./job-context.js";
import { enqueueIssue, isDispatchReady, openJobFor } from "./dispatch.js";
import { listPlans } from "./plan.js";
import type { GitHubCommentEvent } from "./command-handler.js";
import type { ResolvedJobOptions } from "./job-options.js";
import { logger } from "./logger.js";
import { redact } from "./redact.js";

let dockerWorker: DockerWorker | null = null;
type RetryHandler = (event: GitHubIssueEvent) => Promise<void>;
let retryHandler: RetryHandler | null = null;
let queueStore: JsonQueueStore | null = null;

type EventHandler<T> = (event: T) => Promise<void>;
let commentHandler: EventHandler<GitHubCommentEvent> | null = null;
let editHandler: EventHandler<GitHubIssueEvent> | null = null;
let queuedHandler: EventHandler<GitHubIssueEvent> | null = null;

/** `/luci` commands on issue comments. */
export function onComment(handler: EventHandler<GitHubCommentEvent>): void {
  commentHandler = handler;
}

/** Issue body edited (used to invalidate pending plans). */
export function onIssueEdited(handler: EventHandler<GitHubIssueEvent>): void {
  editHandler = handler;
}

/** An assigned issue was put on the queue. */
export function onQueued(handler: EventHandler<GitHubIssueEvent>): void {
  queuedHandler = handler;
}

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
  commentHandler = null;
  editHandler = null;
  queuedHandler = null;
  queueStore = null;
  clearCollaboratorCache();
  clearRepoConfigCache();
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
  /** For `assigned`: the user that was just assigned. */
  assignee?: { login: string };
  /** For `labeled`: the label that was just added. */
  label?: { name: string };
  changes?: { body?: { from: string }; title?: { from: string } };
  jobOptions?: ResolvedJobOptions;
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

type IssueHandler = (event: GitHubIssueEvent) => Promise<unknown>;

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

/** True only for requests made directly on this machine (not through ngrok or another proxy). */
function isDirectLocalRequest(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const proxied = !!(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers["ngrok-trace-id"]);
  return loopback && !proxied;
}

function authMiddleware(config: ReturnType<typeof getConfig>): express.RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.apiToken) {
      // Without API_TOKEN, /api/* is only reachable from this machine. (The Host header is
      // client-controlled and ngrok traffic arrives from 127.0.0.1, so neither can be trusted.)
      if (!isDirectLocalRequest(req)) {
        logger.warn("[webhook] /api/* accessed remotely without API_TOKEN", { path: req.path });
        return res.status(403).json({ error: "API access denied" });
      }
      return next();
    }

    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${config.apiToken}`;
    const ok = auth.length === expected.length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
    if (!ok) {
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

  // Webhook endpoint
  app.get("/version", (_req: Request, res: Response) => {
    res.json({ name: "luci-github-bot", version: "0.1.0" });
  });

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

      if (eventType === "ping") {
        return res.status(200).json({ status: "pong" });
      }

      if (eventType !== "issues" && eventType !== "issue_comment") {
        logger.info("[webhook] Ignoring event type: " + eventType);
        return res.status(200).json({ status: "ignored" });
      }

      const body = req.body as unknown;
      if (!isGitHubIssueEvent(body)) {
        logger.error("[webhook] Invalid issue event payload");
        return res.status(400).json({ error: "Invalid payload" });
      }

      if (!appConfig.monitoredRepos.includes(body.repository.full_name)) {
        logger.info(
          `[webhook] Ignoring issue #${body.issue.number} from unmonitored repo: ${body.repository.full_name}`
        );
        return res.status(200).json({ status: "ignored", repo: body.repository.full_name });
      }

      // GitHub redelivers on timeouts and manual "Redeliver": process each delivery once
      if (queueStore && deliveryId && queueStore.deliveryReceived(deliveryId)) {
        logger.info(`[webhook] Duplicate delivery ${deliveryId}, ignoring`);
        return res.status(200).json({ status: "ignored", reason: "duplicate" });
      }

      const isBotLogin = (login: string | undefined) =>
        !!login && !!appConfig.botUsername && login.toLowerCase() === appConfig.botUsername.toLowerCase();

      // ── /luci comment commands ──
      if (eventType === "issue_comment") {
        const c = body as unknown as GitHubCommentEvent;
        if (c.action !== "created" || !c.comment || c.issue.pull_request) {
          return res.status(200).json({ status: "ignored" });
        }
        // Loop prevention is content-based: the bot's own comments never start with /luci and carry its
        // marker. (A login check would break the common setup where the bot runs as your own account.)
        const text = c.comment.body ?? "";
        if (!/^\s*\/luci\b/im.test(text) || text.includes("<!-- luci-bot") || c.comment.user?.type === "Bot") {
          return res.status(200).json({ status: "ignored" });
        }
        if (!commentHandler) return res.status(200).json({ status: "ignored", reason: "commands_disabled" });
        commentHandler(c).catch((error) => {
          logger.error(`[webhook] Comment handler error for #${c.issue.number}: ${redact(error instanceof Error ? error.message : String(error))}`);
        });
        return res.status(200).json({ status: "accepted" });
      }

      const event = body;

      if (event.issue.state === "closed" || event.issue.pull_request) {
        return res.status(200).json({ status: "ignored" });
      }

      // ── Retry: `needs-retry` label added (or present when the issue is edited) ──
      const retryLabelAdded = event.action === "labeled" && event.label?.name === "needs-retry";
      const retryOnEdit = event.action === "edited" && event.issue.labels.some((l) => l.name === "needs-retry");
      // The bot never adds `needs-retry` itself (it only removes it), so no sender check is needed.
      if ((retryLabelAdded || retryOnEdit) && retryHandler) {
        logger.info(`[webhook] Retry triggered for issue #${event.issue.number} in ${event.repository.full_name}`);
        retryHandler(event).catch((error) => {
          logger.error(
            `[webhook] Retry handler error for issue #${event.issue.number}: ${redact(error instanceof Error ? error.message : String(error))}`
          );
        });
        return res.status(200).json({ status: "retry", action: event.action });
      }

      // ── Issue body edited: invalidate a pending plan ──
      if (event.action === "edited" && event.changes?.body && editHandler) {
        editHandler(event).catch((error) => {
          logger.error(`[webhook] Edit handler error for #${event.issue.number}: ${redact(error instanceof Error ? error.message : String(error))}`);
        });
        return res.status(200).json({ status: "edited" });
      }

      if (event.action !== "assigned") {
        return res.status(200).json({ status: "ignored" });
      }

      // The payload's top-level `assignee` is the user just assigned (issue.assignee is only the first one)
      const assignee = event.assignee?.login ?? event.issue.assignee?.login;
      if (!isBotLogin(assignee)) {
        logger.info(`[webhook] Ignoring assign #${event.issue.number} — assigned to ${assignee}`);
        return res.status(200).json({ status: "ignored", assignee });
      }
      // Self-assignment is allowed: the bot never assigns issues, and it may run as your own account.
      if (event.issue.labels.some((l) => l.name === "bot:no-run")) {
        logger.info(`[webhook] Ignoring issue #${event.issue.number} (bot:no-run)`);
        return res.status(200).json({ status: "ignored" });
      }

      logger.info(
        `[webhook] Bot assigned issue #${event.issue.number} in ${event.repository.full_name}: ${event.issue.title}`
      );

      try {
        event.jobOptions = await computeJobOptions(event, appConfig.githubToken);
      } catch (error) {
        logger.warn(`[webhook] Could not resolve job options, using defaults: ${redact(error instanceof Error ? error.message : String(error))}`);
      }

      if (isDispatchReady()) {
        if (openJobFor(event.repository.full_name, event.issue.number)) {
          return res.status(200).json({ status: "ignored", reason: "already_queued" });
        }
        // Mark as queued first: enqueueing can start the job immediately, and its status updates
        // must come after this one.
        if (queuedHandler) queuedHandler(event).catch(() => {});
        const r = enqueueIssue(event);
        if (r.status === "already_queued") {
          return res.status(200).json({ status: "ignored", reason: "already_queued" });
        }
        metrics.recordQueue();
        return res.status(200).json({ status: "queued" });
      }

      // No queue configured (tests / minimal setups): run handlers directly
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
    })
  );

  // Dashboard: a static page with no data in it. It reads /api/*, so the same auth applies.
  const dashboardHtml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "dashboard.html"), "utf-8");
  app.get(["/", "/dashboard"], (_req: Request, res: Response) => {
    res
      .type("html")
      .set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .set("X-Content-Type-Options", "nosniff")
      .set("Referrer-Policy", "no-referrer")
      .send(dashboardHtml);
  });

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

  // Everything the dashboard's header needs in one call
  app.get("/api/overview", (_req: Request, res: Response) => {
    const health = getHealthStats();
    const m = metrics.getSnapshot();
    res.json({
      status: health.status,
      capacity: health.capacity,
      resources: health.resources,
      uptimeSeconds: m.uptimeSeconds,
      startTime: m.startTime,
      jobCounts: queueStore?.getJobCountByStatus() ?? null,
      llm: m.llmGenerations,
      workers: m.workerExecutions,
      repos: appConfig.monitoredRepos,
      botUsername: appConfig.botUsername,
      dryRun: !!appConfig.dryRun,
    });
  });

  app.get("/api/plans", (_req: Request, res: Response) => {
    res.json({ plans: listPlans() });
  });

  // Jobs endpoint (no payloads: they contain issue text)
  app.get("/api/jobs", (req: Request, res: Response) => {
    if (!queueStore) return res.json({ jobs: [], queueDepth: 0 });
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const jobs = queueStore
      .getSnapshot()
      .jobs.filter((j) => !status || j.status === status)
      .slice(-100)
      // Never return the payload (issue body, options); the title is already public on GitHub
      .map(({ payload, ...rest }) => ({
        ...rest,
        title: (payload as { event?: { issue?: { title?: string } } })?.event?.issue?.title,
      }));
    res.json({ jobs, queueDepth: queueStore.getJobCountByStatus().queued });
  });

  // Recent activity endpoint
  app.get("/api/activity", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(metrics.getRecentActivity(Math.min(limit, 100)));
  });

  return app;
}
