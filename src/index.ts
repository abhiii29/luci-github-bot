import { execFile, execFileSync } from "child_process";
import fs from "fs";
import { promisify } from "util";
import express from "express";
import {
  createWebhookApp,
  setDockerWorker,
  onIssue,
  onRetry,
  onComment,
  onIssueEdited,
  onQueued,
  setQueueStore,
} from "./webhook.js";
import { handleIssue, retryQueuedIssue, markIssueQueued, setIssueWorker } from "./issue-handler.js";
import { handleIssueComment } from "./command-handler.js";
import { initDispatch, enqueueIssue, eventFromJob, isJobCancelled } from "./dispatch.js";
import { computeJobOptions } from "./job-context.js";
import { getPlanState, hashIssueBody, invalidatePlan } from "./plan.js";
import { GitHubClient } from "./github.js";
import { getConfig } from "./config.js";
import { DockerWorker } from "./docker-worker.js";
import { JsonQueueStore } from "./store.js";
import { JobQueue } from "./queue.js";
import { logger } from "./logger.js";
import { redact, addSecret } from "./redact.js";

const execFileAsync = promisify(execFile);

// Track active ngrok processes for cleanup
let ngrokProcesses: ReturnType<typeof execFile>[] = [];

// Shutdown hooks registered by other modules
const shutdownHooks: Array<() => Promise<void>> = [];

export function onShutdown(fn: () => Promise<void>): void {
  shutdownHooks.push(fn);
}

async function startNgrokTunnel(port: number, authToken: string): Promise<string> {
  logger.info("[ngrok] Starting tunnel...");

  const ngrok = execFile(
    "ngrok",
    ["http", port.toString(), "--log", "stdout"],
    {
      timeout: 30_000,
      env: { ...process.env, NGROK_AUTHTOKEN: authToken },
    }
  );

  ngrokProcesses.push(ngrok);

  return new Promise<string>((resolve, reject) => {
    let output = "";
    let connected = false;

    ngrok.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      logger.info(`[ngrok] ${data.toString().trim()}`);

      if (!connected) {
        const urlMatch = output.match(/https:\/\/([a-zA-Z0-9-]+\.)?ngrok-free\.(app|dev)/);
        if (urlMatch) {
          connected = true;
          resolve(urlMatch[0]);
        }
      }
    });

    ngrok.stderr?.on("data", (data: Buffer) => {
      logger.warn(`[ngrok] ${redact(data.toString().trim())}`);
    });

    ngrok.on("error", (err) => {
      if (!connected) reject(err);
    });

    ngrok.on("close", (code) => {
      if (!connected) {
        reject(new Error(`ngrok exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!connected) {
        ngrok.kill();
        reject(new Error("ngrok tunnel failed to start within 15s"));
      }
    }, 15_000);
  });
}

function stopNgrokTunnels(): void {
  for (const p of ngrokProcesses) {
    try {
      p.kill();
    } catch {}
  }
  ngrokProcesses = [];
}

/** `issues` for assignment/retry/edits, `issue_comment` for `/luci` commands. */
const WEBHOOK_EVENTS = ["issues", "issue_comment"];

async function registerWebhook(ngrokUrl: string, config: ReturnType<typeof getConfig>): Promise<void> {
  const repos = config.monitoredRepos;
  const webhookUrl = `${ngrokUrl}/webhook`;

  logger.info(`[webhook] Registering webhook at: ${webhookUrl}`);

  for (const repo of repos) {
    try {
      const existing = await fetch(
        `https://api.github.com/repos/${repo}/hooks`,
        {
          headers: {
            Authorization: `Bearer ${config.githubToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );

      if (existing.ok) {
        const hooks = await existing.json();
        const hook = (hooks as any[]).find((h: any) => h.config?.url === webhookUrl);
        if (hook) {
          const missing = WEBHOOK_EVENTS.filter((e) => !hook.events?.includes(e));
          if (missing.length > 0) {
            await fetch(`https://api.github.com/repos/${repo}/hooks/${hook.id}`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${config.githubToken}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ add_events: missing }),
            });
            logger.info(`[webhook] Added events ${missing.join(", ")} for ${repo}`);
          } else {
            logger.info(`[webhook] Already registered for ${repo}`);
          }
          continue;
        }
      }

      const response = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: WEBHOOK_EVENTS,
          config: {
            url: webhookUrl,
            secret: config.webhookSecret,
            content_type: "json",
          },
        }),
      });

      if (response.ok) {
        logger.info(`[webhook] Registered for ${repo}`);
      } else {
        const error = await response.text();
        logger.error(`[webhook] Failed for ${repo}: ${redact(error)}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[webhook] Error for ${repo}: ${redact(msg)}`);
    }
  }
}

function validateStartup(config: ReturnType<typeof getConfig>): string[] {
  const problems: string[] = [];

  if (!config.githubToken || config.githubToken.length < 10) {
    problems.push("GITHUB_TOKEN: missing or too short");
  }

  if (!config.webhookSecret || config.webhookSecret.length < 16) {
    problems.push("WEBHOOK_SECRET: required and must be at least 16 characters");
  }

  const apiKeyPath = config.adassoApiKeyFile.replace(/^~($|\/)/, process.env.HOME + "/");
  try {
    fs.accessSync(apiKeyPath, fs.constants.R_OK);
  } catch {
    problems.push(`API key file not readable: ${config.adassoApiKeyFile}`);
  }

  for (const repo of config.monitoredRepos) {
    if (!repo.includes("/")) {
      problems.push(`MONITORED_REPOS: invalid format "${repo}". Use owner/repo`);
    }
  }

  if (!config.botUsername) {
    problems.push("Bot username: undetectable (set GITHUB_BOT_USERNAME)");
  }

  const hasNgrok = !!(config.ngrokAuthToken && config.ngrokAuthToken.length > 10);
  if (hasNgrok) {
    try {
      execFileSync("which", ["ngrok"], { timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      problems.push("ngrok binary: not found in PATH (unset NGROK_AUTHTOKEN or install ngrok)");
    }
  }

  addSecret(config.webhookSecret);
  addSecret(config.githubToken);

  return problems;
}

async function main() {
  const config = getConfig();

  // Startup validation
  const problems = validateStartup(config);
  if (problems.length > 0) {
    console.error("=== Startup validation failed ===");
    for (const p of problems) {
      console.error(`  - ${p}`);
    }
    console.error("Fix the issues above and restart.");
    process.exit(1);
  }

  // Warn about API_TOKEN
  if (!config.apiToken) {
    console.error("[startup] WARNING: API_TOKEN not set. /api/* routes bound to localhost only.");
  }

  logger.info("=== luci-github-bot ===", {
    runtime: config.containerRuntime,
    maxWorkers: config.maxConcurrentWorkers,
    model: config.adassoModel,
    botUsername: config.botUsername,
    repos: config.monitoredRepos,
    port: config.listenPort,
  });

  // One worker (one semaphore + resource monitor) shared by the whole bot
  const worker = new DockerWorker();
  setDockerWorker(worker);
  setIssueWorker(worker);
  await worker.ensureImage();
  logger.info("[init] Worker ready");

  // Durable queue: every job (assignment, retry, /luci command) goes through it
  const store = new JsonQueueStore();
  const queue = new JobQueue(store, config.maxConcurrentWorkers);
  queue.setProcessor(async (job) => {
    const event = eventFromJob(job);
    if (!event) return { success: false, error: "invalid_job_payload", retryable: false };
    return handleIssue(event, { isCancelled: () => isJobCancelled(job.id) });
  });
  initDispatch(store, queue);

  const recovered = store.recoverInterrupted();
  if (recovered.length > 0) {
    logger.info(`[queue] Recovered ${recovered.length} job(s) interrupted by the last shutdown`);
  }

  onIssue(handleIssue); // only used when no queue is configured
  onQueued(markIssueQueued);
  onComment(handleIssueComment);
  onRetry(async (event) => {
    event.jobOptions = await computeJobOptions(event, config.githubToken);
    const r = enqueueIssue(event);
    if (r.status === "queued") await retryQueuedIssue(event);
  });
  onIssueEdited(async (event) => {
    const [owner, repo] = event.repository.full_name.split("/");
    const before = getPlanState(owner, repo, event.issue.number);
    if (!before || before.status !== "pending") return;
    const after = invalidatePlan(owner, repo, event.issue.number, hashIssueBody(event.issue.body ?? ""));
    if (after?.status === "expired") {
      await new GitHubClient({ token: config.githubToken })
        .createComment(
          event.repository.full_name,
          event.issue.number,
          "📝 The issue changed, so the pending plan is no longer valid. Reply `/luci plan` to re-plan."
        )
        .catch(() => {});
    }
  });

  const app = createWebhookApp(config);
  setQueueStore(store);

  onShutdown(async () => {
    stopNgrokTunnels();
  });

  let ngrokUrl = "";
  if (config.ngrokAuthToken) {
    try {
      ngrokUrl = await startNgrokTunnel(config.listenPort, config.ngrokAuthToken);
      logger.info(`[ngrok] Tunnel: ${ngrokUrl}`);
      await registerWebhook(ngrokUrl, config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[ngrok] Failed: ${redact(msg)}`);
      console.error("[ngrok] Manual setup: ngrok http 3000");
      console.error("[ngrok] Then manually register: https://github.com/settings/hooks\n");
    }
  } else {
    logger.info("[ngrok] No token configured");
  }

  const server = app.listen(config.listenPort, async () => {
    logger.info(`[server] Listening on port ${config.listenPort}`);
    console.log(`[server] Webhook: http://localhost:${config.listenPort}/webhook`);
    console.log(`[server] Health: http://localhost:${config.listenPort}/health`);
    console.log(`[server] Stats: http://localhost:${config.listenPort}/api/stats`);
    console.log(`[server] Activity: http://localhost:${config.listenPort}/api/activity`);
    console.log(`[server] Jobs: http://localhost:${config.listenPort}/api/jobs`);
    console.log("=== Bot is ready ===");
    if (ngrokUrl) {
      console.log(`Public URL: ${ngrokUrl}/webhook`);
    }

    // Start queue processor
    await queue.start();
    console.log("[queue] Processor started");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[shutdown] ${signal} received`, { signal });
    setTimeout(() => {
      logger.error("[shutdown] Forced shutdown after timeout");
      process.exit(1);
    }, config.shutdownTimeoutMs).unref();

    server.close();
    stopNgrokTunnels();
    // Let running jobs finish; anything still running is re-queued on the next start
    await queue.stop(Math.max(config.shutdownTimeoutMs - 5_000, 1_000));
    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[shutdown] Hook error: ${redact(msg)}`);
      }
    }
    await worker.stop();
    store.save();
    logger.info("[shutdown] Done");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});
