import { execFile } from "child_process";
import { promisify } from "util";
import express from "express";
import { createWebhookApp, setDockerWorker, onIssue, onRetry } from "./webhook.js";
import { handleIssue, retryQueuedIssue } from "./issue-handler.js";
import { getConfig } from "./config.js";
import { DockerWorker } from "./docker-worker.js";
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
        const exists = (hooks as any[]).some(
          (h: any) => h.config?.url === webhookUrl && h.events?.includes("issues")
        );
        if (exists) {
          logger.info(`[webhook] Already registered for ${repo}`);
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
          events: ["issues"],
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
    require("fs").accessSync(apiKeyPath, require("fs").constants.R_OK);
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
    const ngrokBin = require("child_process").execFileSync("which", ["ngrok"], {
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    }).toString().trim();
    if (!ngrokBin) {
      problems.push("ngrok binary: not found in PATH (tunnel will not start automatically)");
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

  onIssue(handleIssue);
  onRetry(retryQueuedIssue);

  const app = createWebhookApp(config);

  const worker = new DockerWorker();
  setDockerWorker(worker);
  await worker.ensureImage();
  logger.info("[init] Worker ready");

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

  const server = app.listen(config.listenPort, () => {
    logger.info(`[server] Listening on port ${config.listenPort}`);
    console.log(`[server] Webhook: http://localhost:${config.listenPort}/webhook`);
    console.log(`[server] Health: http://localhost:${config.listenPort}/health`);
    console.log(`[server] Stats: http://localhost:${config.listenPort}/api/stats`);
    console.log(`[server] Activity: http://localhost:${config.listenPort}/api/activity`);
    console.log("=== Bot is ready ===");
    if (ngrokUrl) {
      console.log(`Public URL: ${ngrokUrl}/webhook`);
    }
  });

  const shutdown = async (signal: string) => {
    logger.info(`[shutdown] ${signal} received`, { signal });
    stopNgrokTunnels();
    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[shutdown] Hook error: ${redact(msg)}`);
      }
    }
    await worker.stop();

    server.close(() => {
      logger.info("[shutdown] Server closed");
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("[shutdown] Forced shutdown after timeout");
      process.exit(1);
    }, config.shutdownTimeoutMs);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});
