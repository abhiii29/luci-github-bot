import crypto from "crypto";
import { readFileSync } from "fs";
import express, { Request, Response, NextFunction } from "express";
import { getConfig } from "./config.js";
import { DockerWorker } from "./docker-worker.js";
import { ResourceStats } from "./resource-monitor.js";
import { metrics } from "./metrics.js";
import { JsonQueueStore } from "./store.js";
import { clearCollaboratorCache } from "./collaborators.js";
import { computeJobOptions, clearRepoConfigCache } from "./job-context.js";
import { enqueueIssue, isDispatchReady, openJobFor } from "./dispatch.js";
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

  // Version endpoint
  app.get("/version", (_req, res) => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { name: string; version: string };
    res.json({ name: pkg.name, version: pkg.version });
  });

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

      const eventType = req.headers["x-github-event"] as st