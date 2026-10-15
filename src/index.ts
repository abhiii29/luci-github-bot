import { execFile } from "child_process";
import { promisify } from "util";
import express from "express";
import { createWebhookApp, setDockerWorker, onIssue, onRetry } from "./webhook.js";
import { handleIssue, retryQueuedIssue } from "./issue-handler.js";
import { getConfig } from "./config.js";
import { DockerWorker } from "./docker-worker.js";

const execFileAsync = promisify(execFile);

// Track active ngrok processes for cleanup
let ngrokProcesses: ReturnType<typeof execFile>[] = [];

async function startNgrokTunnel(port: number, authToken: string): Promise<string> {
  console.log("[ngrok] Starting tunnel...");

  // Start ngrok CLI process
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
      console.log(`[ngrok] ${data.toString().trim()}`);

      // Look for the tunnel URL in ngrok output
      if (!connected) {
        const urlMatch = output.match(/https:\/\/([a-zA-Z0-9-]+\.)?ngrok-free\.(app|dev)/);
        if (urlMatch) {
          connected = true;
          resolve(urlMatch[0]);
        }
      }
    });

    ngrok.stderr?.on("data", (data: Buffer) => {
      console.error(`[ngrok-err] ${data.toString().trim()}`);
    });

    ngrok.on("error", (err) => {
      if (!connected) reject(err);
    });

    ngrok.on("close", (code) => {
      if (!connected) {
        reject(new Error(`ngrok exited with code ${code}`));
      }
    });

    // Timeout after 15s
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

  console.log(`[webhook] Registering webhook at: ${webhookUrl}`);

  for (const repo of repos) {
    try {
      // Check if webhook already exists
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
          console.log(`[webhook] Already registered for ${repo}`);
          continue;
        }
      }

      // Create new webhook
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
        console.log(`[webhook] Registered for ${repo}`);
      } else {
        const error = await response.text();
        console.error(`[webhook] Failed for ${repo}: ${error}`);
      }
    } catch (error) {
      console.error(`[webhook] Error for ${repo}:`, error);
    }
  }
}

async function main() {
  const config = getConfig();

  console.log("=== luci-github-bot ===");
  console.log(`Runtime: ${config.containerRuntime}`);
  console.log(`Max concurrent workers: ${config.maxConcurrentWorkers}`);
  console.log(`Hub: ${config.adassoBaseUrl}`);
  console.log(`Model: ${config.adassoModel}`);
  console.log(`Bot user: ${config.botUsername}`);
  console.log(`Monitored repos: ${config.monitoredRepos.join(", ")}`);
  console.log(`Port: ${config.listenPort}`);
  console.log("");

  // Register issue handler
  onIssue(handleIssue);
  onRetry(retryQueuedIssue);

  // Create webhook app
  const app = createWebhookApp();

  // Ensure worker image is ready
  const worker = new DockerWorker();
  setDockerWorker(worker);
  await worker.ensureImage();
  console.log("[init] Worker ready\n");

  // Start ngrok tunnel if token is configured
  let ngrokUrl = "";
  if (config.ngrokAuthToken) {
    try {
      ngrokUrl = await startNgrokTunnel(config.listenPort, config.ngrokAuthToken);
      console.log(`\n[ngrok] Tunnel: ${ngrokUrl}\n`);

      // Register webhook with GitHub
      await registerWebhook(ngrokUrl, config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[ngrok] Failed: ${msg}`);
      console.log("[ngrok] Manual setup: ngrok http 3000");
      console.log("[ngrok] Then manually register: https://github.com/settings/hooks\n");
    }
  } else {
    console.log("[ngrok] No token configured. Run: ngrok http 3000");
    console.log("[ngrok] Then manually register: https://github.com/settings/hooks\n");
  }

  // Start Express server
  const server = app.listen(config.listenPort, () => {
    console.log(`[server] Webhook listener: http://localhost:${config.listenPort}/webhook`);
    console.log(`[server] Health check: http://localhost:${config.listenPort}/health`);
    console.log("");
    console.log("=== Bot is ready ===");
    if (ngrokUrl) {
      console.log(`Public URL: ${ngrokUrl}/webhook`);
    }
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] ${signal} received...`);
    stopNgrokTunnels();
    await worker.stop();
    server.close(() => {
      console.log("[shutdown] Server closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});
