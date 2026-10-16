/**
 * End-to-end test of the worker path with a REAL container (podman or docker), no GitHub needed.
 *
 *   npx tsx scripts/e2e/worker-e2e.ts
 *
 * - serves a throwaway bare git repo with `git daemon` (stands in for github.com)
 * - runs a stub of the GitHub "create pull request" API
 * - drives DockerWorker.processIssue() exactly as the bot does, and checks each outcome
 */
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

const REPO = "e2e-owner/e2e-repo";
const GIT_PORT = 19418;
const API_PORT = 19419;
const HOST = "host.containers.internal";
const FAKE_TOKEN = "ghp_" + "e2eFakeTokenDoNotUse0000000000000000";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luci-e2e-"));
const bare = path.join(tmp, "repos", `${REPO}.git`);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOr = (fallback: string, cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return fallback;
  }
};

// --- Seed repo ---------------------------------------------------------------
fs.mkdirSync(bare, { recursive: true });
git(bare, "init", "--bare", "--quiet", "--initial-branch=main");
const seed = path.join(tmp, "seed");
fs.mkdirSync(path.join(seed, "src"), { recursive: true });
git(seed, "init", "--quiet", "--initial-branch=main");
fs.writeFileSync(path.join(seed, "README.md"), "# e2e\n");
fs.writeFileSync(path.join(seed, "src", "a.ts"), "export const a = 1;\n");
git(seed, "add", "-A");
git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "--quiet", "-m", "seed");
git(seed, "push", "--quiet", bare, "main");

// --- Environment for the bot (must be set before importing config) -----------
Object.assign(process.env, {
  GITHUB_TOKEN: FAKE_TOKEN,
  WEBHOOK_SECRET: "e2e-webhook-secret-0123456789",
  MONITORED_REPOS: REPO,
  GITHUB_BOT_USERNAME: "luci-bot",
  CONTAINER_RUNTIME: process.env.CONTAINER_RUNTIME ?? "podman",
  GIT_BASE_URL: `git://${HOST}:${GIT_PORT}`,
  GITHUB_API_URL: `http://${HOST}:${API_PORT}`,
  CONTAINER_MEMORY: "512m",
  CONTAINER_PIDS_LIMIT: "256",
  WORKER_TIMEOUT_MS: "180000",
  MAX_CONCURRENT_WORKERS: "2",
});

type PrRequest = { headers: http.IncomingHttpHeaders; body: any };
const prRequests: PrRequest[] = [];

async function main() {
  // git daemon (read + push)
  const daemon = spawn(
    "git",
    ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${path.join(tmp, "repos")}`, `--port=${GIT_PORT}`, "--listen=127.0.0.1"],
    { stdio: "ignore" }
  );

  // Stub API
  const api = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === `/repos/${REPO}/pulls`) {
        const body = JSON.parse(data);
        prRequests.push({ headers: req.headers, body });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ html_url: `https://github.com/${REPO}/pull/${prRequests.length}` }));
      } else {
        res.writeHead(404).end("{}");
      }
    });
  });
  await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
  await new Promise((r) => setTimeout(r, 500));

  const { DockerWorker } = await import("../../src/docker-worker.js");
  const worker = new DockerWorker();
  await worker.ensureImage();

  const event = (n: number) =>
    ({
      action: "assigned",
      issue: { number: n, title: "t", body: "b", state: "open", labels: [], html_url: "", user: { login: "u" }, created_at: "", updated_at: "" },
      repository: { full_name: REPO, clone_url: "", private: false },
      sender: { login: "u" },
    }) as any;

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const branches = () => git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads");

  try {
    // 1. Normal update -> PR created against main, with Closes #N
    const r1 = await worker.processIssue(event(1), {
      success: true,
      branchName: "bot/issue-1-update-a",
      commitMessage: "Update a to 2",
      files: [{ path: "src/a.ts", operation: "update", content: "export const a = 2;\n" }],
    });
    check("update -> pr_created", r1.success && r1.status === "pr_created" && !!r1.prUrl, JSON.stringify(r1));
    check("branch pushed to remote", branches().includes("bot/issue-1-update-a"));
    check("file content committed", gitOr("<missing>", bare, "show", "bot/issue-1-update-a:src/a.ts") === "export const a = 2;");
    const pr1 = prRequests[0];
    check("PR targets detected default branch", pr1?.body.base === "main", pr1?.body.base);
    check("PR body links the issue (Closes #1)", /Closes #1\b/.test(pr1?.body.body ?? ""));
    check("API call authenticated with the token", pr1?.headers.authorization === `Bearer ${FAKE_TOKEN}`);

    // 2. Hostile commit message / branch-safe but shell-hostile content -> stored literally, nothing executed
    const hostile = "fix $(touch /tmp/pwned) `id` \"; rm -rf / #";
    const r2 = await worker.processIssue(event(2), {
      success: true,
      branchName: "bot/issue-2-hostile",
      commitMessage: hostile,
      files: [{ path: "src/b.ts", operation: "create", content: "export const b = '$(id)';\n" }],
    });
    check("hostile commit message -> pr_created", r2.success && r2.status === "pr_created", JSON.stringify(r2));
    check("commit message stored literally", gitOr("<missing>", bare, "log", "-1", "--format=%s", "bot/issue-2-hostile") === hostile);
    check("PR title stored literally", prRequests[1]?.body.title === hostile, prRequests[1]?.body.title);

    // 3. No-op solution -> no_changes, no PR
    const before = prRequests.length;
    const r3 = await worker.processIssue(event(3), {
      success: true,
      branchName: "bot/issue-3-noop",
      commitMessage: "Nothing",
      files: [{ path: "README.md", operation: "update", content: "# e2e\n" }],
    });
    check("no-op -> no_changes, not success", !r3.success && r3.status === "no_changes", JSON.stringify(r3));
    check("no PR opened for no-op", prRequests.length === before);

    // 4. Retry onto an existing branch -> unique branch, no force push
    const r4 = await worker.processIssue(event(1), {
      success: true,
      branchName: "bot/issue-1-update-a",
      commitMessage: "Update a to 3",
      files: [{ path: "src/a.ts", operation: "update", content: "export const a = 3;\n" }],
    });
    check("existing branch -> new unique branch", r4.success && r4.branchName.startsWith("bot/issue-1-update-a-"), r4.branchName);
    check("original branch untouched", gitOr("<missing>", bare, "show", "bot/issue-1-update-a:src/a.ts") === "export const a = 2;");

    // 5. NO_PR -> branch pushed, no PR
    const before5 = prRequests.length;
    const r5 = await worker.processIssue(
      event(5),
      { success: true, branchName: "bot/issue-5-nopr", commitMessage: "No PR please", files: [{ path: "src/c.ts", operation: "create", content: "export {};\n" }] },
      undefined,
      { noPr: true }
    );
    check("noPr -> branch_pushed", r5.success && r5.status === "branch_pushed", JSON.stringify(r5));
    check("no PR opened with noPr", prRequests.length === before5);

    // 6. Path traversal -> rejected before any container runs
    const r6 = await worker.processIssue(event(6), {
      success: true,
      branchName: "bot/issue-6-evil",
      commitMessage: "evil",
      files: [{ path: "../../etc/passwd", operation: "update", content: "x" }],
    });
    check("path traversal rejected by validator", !r6.success && /validation failed/i.test(r6.error ?? ""), r6.error);
    check("no branch created for rejected solution", !branches().includes("bot/issue-6-evil"));

    // 7. Unknown base branch -> clean error, not a crash
    const r7 = await worker.processIssue(
      event(7),
      { success: true, branchName: "bot/issue-7-base", commitMessage: "x", files: [{ path: "src/d.ts", operation: "create", content: "x\n" }] },
      undefined,
      { baseBranch: "does-not-exist" }
    );
    check("missing base branch -> error result", !r7.success && r7.status === "error" && /does not exist/.test(r7.error ?? ""), r7.error);

    // 8. Token never leaks into results/errors
    const all = JSON.stringify([r1, r2, r3, r4, r5, r6, r7]);
    check("token absent from all results", !all.includes(FAKE_TOKEN));
  } finally {
    await worker.stop();
    api.close();
    daemon.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
