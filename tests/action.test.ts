import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("../src/config.js", () => ({
  getConfig: () => ({ monitoredRepos: ["o/r"], botUsername: "bot", githubToken: "t", maxConcurrentWorkers: 1 }),
}));

import { applyActionEnvDefaults, runEvent } from "../src/action.js";
import { JsonQueueStore } from "../src/store.js";
import { JobQueue } from "../src/queue.js";
import type { RouteResult } from "../src/webhook.js";

const TEST_DIR = "/tmp/luci-action-test-" + Date.now();

beforeEach(() => fs.mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe("applyActionEnvDefaults", () => {
  it("scopes the bot to the triggering repo and keeps state in LUCI_STATE_DIR", () => {
    const env: NodeJS.ProcessEnv = { GITHUB_REPOSITORY: "o/r" };
    applyActionEnvDefaults(env);
    expect(env.MONITORED_REPOS).toBe("o/r");
    expect(env.LUCI_STATE_DIR).toBe(".luci-state");
    expect(env.PLAN_DATA_DIR).toBe(path.join(".luci-state", "plans"));
    expect(env.CONTAINER_RUNTIME).toBe("docker");
    expect(env.WEBHOOK_SECRET).toBeTruthy();
  });

  it("never overrides explicit settings", () => {
    const env: NodeJS.ProcessEnv = { GITHUB_REPOSITORY: "o/r", MONITORED_REPOS: "x/y", CONTAINER_RUNTIME: "podman", PLAN_DATA_DIR: "p" };
    applyActionEnvDefaults(env);
    expect(env.MONITORED_REPOS).toBe("x/y");
    expect(env.CONTAINER_RUNTIME).toBe("podman");
    expect(env.PLAN_DATA_DIR).toBe("p");
  });
});

describe("JsonQueueStore.abandonOpenJobs", () => {
  it("fails jobs a cancelled run left open instead of re-running them", () => {
    const store = new JsonQueueStore(path.join(TEST_DIR, "q.json"));
    const running = store.enqueueJob("o/r", 1, {});
    store.startJob(running.id);
    const queued = store.enqueueJob("o/r", 2, {});
    const done = store.enqueueJob("o/r", 3, {});
    store.completeJob(done.id);

    expect(store.abandonOpenJobs().map((j) => j.id).sort()).toEqual([running.id, queued.id].sort());
    expect(store.getJob(running.id)).toMatchObject({ status: "failed", errorCategory: "interrupted" });
    expect(store.getJob(queued.id)?.status).toBe("failed");
    expect(store.getJob(done.id)?.status).toBe("succeeded");
    expect(store.getOpenJobPerIssue("o/r", 1)).toBeUndefined();
  });
});

describe("runEvent", () => {
  it("waits for the routed work and every job it enqueued before returning", async () => {
    const store = new JsonQueueStore(path.join(TEST_DIR, "q.json"));
    const queue = new JobQueue(store, 1);
    const order: string[] = [];
    queue.setProcessor(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("job");
      return { success: true };
    });
    await queue.start();

    const route = vi.fn(async (): Promise<RouteResult> => {
      const work = (async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("handler");
        queue.enqueue("o/r", 7, {});
      })();
      return { code: 200, body: { status: "accepted" }, work };
    });

    const result = await runEvent("issue_comment", { any: 1 }, queue, route);

    expect(route).toHaveBeenCalledWith("issue_comment", { any: 1 }, undefined, expect.anything());
    expect(result.body).toEqual({ status: "accepted" });
    expect(order).toEqual(["handler", "job"]);
    expect(store.getSnapshot().jobs[0].status).toBe("succeeded");
  });

  it("returns ignored events without running anything", async () => {
    const store = new JsonQueueStore(path.join(TEST_DIR, "q.json"));
    const queue = new JobQueue(store, 1);
    await queue.start();
    const route = async (): Promise<RouteResult> => ({ code: 200, body: { status: "ignored" } });
    const result = await runEvent("issues", {}, queue, route);
    expect(result.body.status).toBe("ignored");
    expect(store.getSnapshot().jobs).toHaveLength(0);
  });
});
