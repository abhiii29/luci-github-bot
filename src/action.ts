import fs from "fs";
import path from "path";
import { routeEvent, type RouteResult } from "./webhook.js";
import { setupBot } from "./bootstrap.js";
import { getConfig } from "./config.js";
import { JsonQueueStore } from "./store.js";
import type { JobQueue } from "./queue.js";
import { logger } from "./logger.js";
import { redact, addSecret } from "./redact.js";

/**
 * GitHub Action entrypoint: handle the single `issues` / `issue_comment` event that triggered this
 * workflow run, drain the queue, exit. Uses the same routing, queue and handlers as the webhook
 * server; only the transport differs (no HTTP server, no ngrok, no signature check — GitHub itself
 * delivered the event).
 *
 * State (queue + plans) lives in LUCI_STATE_DIR, which the workflow restores and saves with
 * actions/cache per issue so `/luci plan` → `/luci go` and `/luci status` work across runs.
 */

/** Defaults that only make sense inside Actions; explicit env always wins. */
export function applyActionEnvDefaults(env: NodeJS.ProcessEnv): void {
  const stateDir = env.LUCI_STATE_DIR || ".luci-state";
  env.LUCI_STATE_DIR = stateDir;
  env.PLAN_DATA_DIR ||= path.join(stateDir, "plans");
  // Only the repo that triggered the run is in scope
  env.MONITORED_REPOS ||= env.GITHUB_REPOSITORY;
  env.CONTAINER_RUNTIME ||= "docker";
  // No webhook: the secret is unused but required by the shared config schema
  env.WEBHOOK_SECRET ||= "unused-in-github-actions-mode";
}

/** Resolves once nothing is running, queued or waiting for a retry. */
export async function waitForIdle(queue: JobQueue, pollMs = 500): Promise<void> {
  // Give handlers that enqueue asynchronously a tick to do so
  await new Promise((r) => setTimeout(r, pollMs));
  while (!queue.isIdle()) await new Promise((r) => setTimeout(r, pollMs));
}

export async function runEvent(
  eventName: string,
  payload: unknown,
  queue: JobQueue,
  route: typeof routeEvent = routeEvent
): Promise<RouteResult> {
  const routed = await route(eventName, payload, undefined, getConfig());
  logger.info(`[action] ${eventName}: ${JSON.stringify(routed.body)}`);
  await routed.work;
  await waitForIdle(queue);
  return routed;
}

async function main(): Promise<void> {
  applyActionEnvDefaults(process.env);
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) {
    throw new Error("GITHUB_EVENT_NAME / GITHUB_EVENT_PATH not set: this entrypoint only runs inside GitHub Actions");
  }

  const config = getConfig();
  addSecret(config.githubToken);
  if (config.adassoApiKey) addSecret(config.adassoApiKey);

  const stateDir = process.env.LUCI_STATE_DIR!;
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new JsonQueueStore(path.join(stateDir, "queue.json"));
  const abandoned = store.abandonOpenJobs();
  if (abandoned.length > 0) logger.info(`[action] Marked ${abandoned.length} job(s) from a cancelled run as interrupted`);

  const before = new Set(store.getSnapshot().jobs.map((j) => j.id));

  const { worker, queue } = await setupBot(config, store);
  await queue.start();

  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf-8")) as unknown;
    const routed = await runEvent(eventName, payload, queue);
    if (routed.code >= 400) throw new Error(`event rejected: ${JSON.stringify(routed.body)}`);
  } finally {
    await queue.stop(1_000);
    await worker.stop();
    store.save();
  }

  // The issue already shows the failure; a red run makes it visible in the Actions tab too
  const failedHere = store.getSnapshot().jobs.filter((j) => !before.has(j.id) && j.status === "failed");
  if (failedHere.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error("[fatal]", redact(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
