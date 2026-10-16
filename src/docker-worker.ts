import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { GitHubIssueEvent } from "./webhook.js";
import { getConfig } from "./config.js";
import { CodeGenerationResult } from "./llm.js";
import { ResourceMonitor, ResourceStats } from "./resource-monitor.js";
import { redact } from "./redact.js";
import { validateSolution, type ValidateSolutionOptions } from "./solution-validator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type WorkerProgress = {
  stage:
    | "starting"
    | "pulling"
    | "running"
    | "cloning"
    | "coding"
    | "committing"
    | "pushing"
    | "creating-pr"
    | "complete"
    | "failed";
  message: string;
};

export interface WorkerRunOptions {
  /** Base branch for the PR (default: the repo's default branch, detected in the container). */
  baseBranch?: string;
  /** Push the branch but do not open a PR. */
  noPr?: boolean;
  /** Extra validator options (denied paths, file limits, ...). */
  validation?: ValidateSolutionOptions;
}

export type WorkerStatus = "pr_created" | "pr_exists" | "branch_pushed" | "no_changes" | "error";

export interface WorkerResult {
  success: boolean;
  branchName: string;
  prUrl?: string;
  issueNumber: number;
  error?: string;
  /** Machine-readable outcome reported by the worker script (`RESULT:` line). */
  status?: WorkerStatus;
}

/** Extract the last `RESULT: {...}` line the worker script printed. */
export function parseWorkerResult(logs: string): { status: WorkerStatus; url?: string; branch?: string; error?: string } | null {
  const lines = logs.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("RESULT:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i].slice("RESULT:".length).trim());
      if (parsed && typeof parsed.status === "string") return parsed;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Whether all worker slots are currently occupied */
export interface WorkerCapacity {
  available: number;
  max: number;
  full: boolean;
}

// --- Dynamic semaphore: capacity-aware permits ---

class DynamicSemaphore {
  private available: number;
  private max: number;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(max: number) {
    this.max = max;
    this.available = max;
  }

  getAvailable(): number {
    return this.available;
  }

  getMax(): number {
    return this.max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.available++;
    }
  }

  adjustByCapacity(capacity: number): void {
    const target = Math.max(0, Math.round(capacity * this.max));
    if (target < this.available) {
      this.available = target;
    }
  }
}

// --- Container runtime abstraction ---

interface ContainerRuntime {
  name: string;
  build(image: string, dockerfile: string, context: string): Promise<void>;
  pull(image: string): Promise<void>;
  create(image: string, spec: ContainerSpec, containerName: string): Promise<{ id: string }>;
  start(containerId: string): Promise<void>;
  logs(containerId: string): Promise<string>;
  inspect(containerId: string): Promise<{ Running: boolean; ExitCode: number }>;
  kill(containerId: string): Promise<void>;
  rm(containerId: string): Promise<void>;
  ps(): Promise<Array<{ Id: string; Name: string; Status: string }>>;
}

/** What to create a worker container with. Secrets never appear on the host command line. */
export interface ContainerSpec {
  /** Plain environment variables (passed as `-e KEY=value`). */
  env: Record<string, string>;
  /** Secret environment variables: passed as `-e KEY` with the value in the child's env, not argv. */
  secretEnv: Record<string, string>;
  /** Extra `create` flags (resource limits, mounts, tmpfs, security options). */
  args: string[];
}

function buildCreateArgs(image: string, spec: ContainerSpec, containerName: string): string[] {
  return [
    "create",
    "--name",
    containerName,
    ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.keys(spec.secretEnv).flatMap((k) => ["-e", k]),
    ...spec.args,
    image,
  ];
}

class PodmanRuntime implements ContainerRuntime {
  readonly name = "podman";

  private run(args: string[], opts?: { silent?: boolean; timeout?: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = opts?.timeout ?? 300_000;
      const child = execFile(
        "podman",
        args,
        { timeout, maxBuffer: 10 * 1024 * 1024 },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
      if (!opts?.silent) {
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
      }
    });
  }

  private async runWithOutput(args: string[], opts?: { timeout?: number; env?: Record<string, string> }): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = opts?.timeout ?? 300_000;
      execFile(
        "podman",
        args,
        { timeout, maxBuffer: 10 * 1024 * 1024, env: opts?.env ? { ...process.env, ...opts.env } : process.env },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.toString());
        }
      );
    });
  }

  async build(image: string, dockerfile: string, context: string) {
    await this.run(["build", "-f", dockerfile, "-t", image, context]);
  }

  async pull(image: string) {
    await this.run(["pull", image], { silent: true });
  }

  async create(image: string, spec: ContainerSpec, containerName: string): Promise<{ id: string }> {
    const result = await this.runWithOutput(buildCreateArgs(image, spec, containerName), {
      env: spec.secretEnv,
    });
    const id = result.trim().split("\n")[0].trim();
    return { id };
  }

  async start(containerId: string) {
    // Start container in detached mode (no -a), then poll for exit
    await this.run(["start", containerId]);
    const deadline = Date.now() + getConfig().workerTimeoutMs;
    while (Date.now() < deadline) {
      const state = await this.inspect(containerId);
      if (!state.Running) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  async logs(containerId: string) {
    return this.runWithOutput(["logs", containerId]);
  }

  async inspect(containerId: string) {
    const output = await this.runWithOutput([
      "inspect",
      containerId,
      "--format",
      "{{json .State}}",
    ]);
    return JSON.parse(output) as { Running: boolean; ExitCode: number };
  }

  async kill(containerId: string) {
    try {
      await this.run(["kill", containerId], { silent: true });
    } catch {
      // Container may have already exited
    }
  }

  async rm(containerId: string) {
    try {
      await this.run(["rm", containerId], { silent: true });
    } catch {
      // Already removed
    }
  }

  async ps() {
    try {
      const output = await this.runWithOutput(["ps", "--all", "--format", "{{.ID}} {{.Names}} {{.Status}}"]);
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return { Id: parts[0] ?? "", Name: parts[1] ?? "", Status: parts.slice(2).join(" ") };
        });
    } catch {
      return [];
    }
  }
}

class DockerRuntime implements ContainerRuntime {
  readonly name = "docker";

  private run(args: string[], opts?: { silent?: boolean; timeout?: number }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = execFile(
        "docker",
        args,
        { timeout: opts?.timeout ?? 300_000, maxBuffer: 10 * 1024 * 1024 },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
      if (!opts?.silent) {
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
      }
    });
  }

  private async runWithOutput(args: string[], opts?: { timeout?: number; env?: Record<string, string> }): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("docker", args, { timeout: opts?.timeout ?? 300_000, maxBuffer: 10 * 1024 * 1024, env: opts?.env ? { ...process.env, ...opts.env } : process.env }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.toString());
      });
    });
  }

  async build(image: string, dockerfile: string, context: string) {
    await this.run(["build", "-f", dockerfile, "-t", image, context]);
  }

  async pull(image: string) {
    await this.run(["pull", image], { silent: true });
  }

  async create(image: string, spec: ContainerSpec, containerName: string): Promise<{ id: string }> {
    const result = await this.runWithOutput(buildCreateArgs(image, spec, containerName), {
      env: spec.secretEnv,
    });
    const id = result.trim().split("\n")[0].trim();
    return { id };
  }

  async start(containerId: string) {
    await this.run(["start", containerId]);
    const deadline = Date.now() + getConfig().workerTimeoutMs;
    while (Date.now() < deadline) {
      const state = await this.inspect(containerId);
      if (!state.Running) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  async logs(containerId: string) {
    return this.runWithOutput(["logs", containerId]);
  }

  async inspect(containerId: string) {
    const output = await this.runWithOutput([
      "inspect",
      containerId,
      "--format",
      "{{json .State}}",
    ]);
    return JSON.parse(output) as { Running: boolean; ExitCode: number };
  }

  async kill(containerId: string) {
    try {
      await this.run(["kill", containerId], { silent: true });
    } catch {
      // Container may have already exited
    }
  }

  async rm(containerId: string) {
    try {
      await this.run(["rm", containerId], { silent: true });
    } catch {
      // Already removed
    }
  }

  async ps() {
    try {
      const output = await this.runWithOutput(["ps", "--all", "--format", "{{.ID}} {{.Names}} {{.Status}}"]);
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return { Id: parts[0] ?? "", Name: parts[1] ?? "", Status: parts.slice(2).join(" ") };
        });
    } catch {
      return [];
    }
  }
}

// --- Worker ---

export class DockerWorker {
  private runtime: ContainerRuntime;
  private semaphore: DynamicSemaphore;
  private resourceMonitor: ResourceMonitor | null = null;
  private imageBuilt = false;
  private readonly imageTag = "luci-github-bot-worker:latest";
  private readonly contextDir = path.join(__dirname, "..");
  private readonly dockerfilePath = path.join(this.contextDir, "Dockerfile.worker");

  constructor() {
    const config = getConfig();
    this.runtime = config.containerRuntime === "podman" ? new PodmanRuntime() : new DockerRuntime();
    this.semaphore = new DynamicSemaphore(config.maxConcurrentWorkers);

    // Set up resource monitor
    this.resourceMonitor = new ResourceMonitor(
      config.cpuMax,
      config.memoryPressureMax,
      config.resourceCheckIntervalMs,
      (msg) => console.log(`[resource] ${msg}`)
    );

    // Listen for capacity changes and update semaphore
    this.resourceMonitor.start((capacity: number) => {
      const prevSlots = this.semaphore.getAvailable();
      this.semaphore.adjustByCapacity(capacity);
      const newSlots = this.semaphore.getAvailable();
      if (newSlots !== prevSlots) {
        const active = this.semaphore.getMax() - newSlots;
        const max = this.semaphore.getMax();
        console.log(`[resource] Capacity ${Math.round(capacity * 100)}% → ${newSlots}/${max} slots available (${active} active)`);
      }
    });

    console.log(`[worker] Using ${this.runtime.name}, max concurrent: ${config.maxConcurrentWorkers}`);
  }

  /**
    * Return current worker capacity.
    */
  getCapacity(): WorkerCapacity {
    return {
      available: this.semaphore.getAvailable(),
      max: this.semaphore.getMax(),
      full: this.semaphore.getAvailable() === 0,
    };
  }

  /**
    * Return resource monitor stats.
    */
  getStats(): ResourceStats {
    return this.resourceMonitor?.getStats() ?? { cpuUsagePercent: 0, memoryUsedPercent: 0, capacity: 1 };
  }

  /**
    * Build the worker image if it doesn't exist.
    */
  async ensureImage(): Promise<void> {
    try {
      await this.runtime.ps(); // Check runtime is accessible
    } catch (err) {
      const runtimeName = this.runtime.name;
      throw new Error(
        `${runtimeName} is not available. Install it with:\n  ${runtimeName === "podman" ? "brew install podman" : "brew install docker"}`
      );
    }

    // Always (re)build: layers are cached, and this guarantees the image matches images/worker.sh.
    console.log(`[worker] Building ${this.runtime.name} image...`);
    try {
      await this.runtime.build(this.imageTag, this.dockerfilePath, this.contextDir);
      this.imageBuilt = true;
      console.log(`[worker] Image built successfully`);
    } catch (err) {
      // Try docker as fallback if podman build fails
      if (this.runtime.name === "podman") {
        console.log("[worker] Podman build failed, trying Docker...");
        const dockerRuntime = new DockerRuntime();
        await dockerRuntime.build(this.imageTag, this.dockerfilePath, this.contextDir);
        this.imageBuilt = true;
        this.runtime = dockerRuntime;
        console.log("[worker] Fallback to Docker successful");
      } else {
        throw err;
      }
    }
  }

  /**
    * Process a GitHub issue in an ephemeral container.
    */
  async processIssue(
    event: GitHubIssueEvent,
    solution: CodeGenerationResult,
    onProgress?: (progress: WorkerProgress) => void,
    opts: WorkerRunOptions = {}
  ): Promise<WorkerResult> {
    const config = getConfig();
    const repoFullName = event.repository.full_name;
    const issueNumber = event.issue.number;
    const branchName = solution.branchName || `bot/issue-${issueNumber}`;
    const containerName = `luci-bot-${issueNumber}-${Date.now().toString(36)}`;

    const validation = validateSolution(
      branchName,
      solution.commitMessage,
      solution.files,
      opts.validation
    );
    if (!validation.valid) {
      const reason = validation.errors.map(e => e.reason).join("; ");
      console.error(`[worker] Solution validation failed for #${issueNumber}: ${reason}`);
      return {
        success: false,
        branchName,
        issueNumber,
        error: `Solution validation failed: ${reason}`,
      };
    }

    onProgress?.({
      stage: "starting",
      message: `Queued: ${repoFullName}#${issueNumber}`,
    });

    // Acquire semaphore slot
    await this.semaphore.acquire();
    let containerId: string | null = null;
    // Unique per container so concurrent workers never overwrite each other's solution
    const solutionPath = path.join(os.tmpdir(), `luci-solution-${containerName}.json`);
    const solutionTarget = "/tmp/.luci-solution.json";

    try {
      onProgress?.({
        stage: "starting",
        message: `Acquired slot. Starting container for ${repoFullName}#${issueNumber}`,
      });

      // Ensure image exists
      if (!this.imageBuilt) {
        await this.ensureImage();
      }

      const env: Record<string, string> = {
        REPO_FULL_NAME: repoFullName,
        ISSUE_NUMBER: String(issueNumber),
        BRANCH_NAME: branchName,
        COMMIT_MESSAGE: solution.commitMessage,
        GIT_AUTHOR_NAME: config.gitAuthorName,
        GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
        SOLUTION_FILE: solutionTarget,
      };
      if (opts.baseBranch) env.BASE_BRANCH = opts.baseBranch;
      if (opts.noPr) env.NO_PR = "1";
      if (config.gitBaseUrl) env.GIT_BASE_URL = config.gitBaseUrl;
      if (config.githubApiUrl) env.API_BASE_URL = config.githubApiUrl;

      const args: string[] = [];
      if (config.containerMemory) args.push("--memory", config.containerMemory);
      if (config.containerCpus) args.push("--cpus", String(config.containerCpus));
      if (config.containerPidsLimit) args.push("--pids-limit", String(config.containerPidsLimit));
      args.push("--cap-drop=ALL");
      args.push("--security-opt", "no-new-privileges");
      args.push("--read-only");
      // The image runs as the unprivileged `node` user (uid 1000); give it writable scratch space.
      // podman chowns tmpfs to the container user with `U`; docker takes uid/gid mount options.
      const owner = this.runtime.name === "podman" ? "U" : "uid=1000,gid=1000";
      args.push("--tmpfs", `/tmp:rw,noexec,nosuid,size=64m,${owner}`);
      args.push("--tmpfs", `/home/node:rw,noexec,nosuid,size=16m,${owner}`);
      args.push("--tmpfs", `/workspace:rw,noexec,nosuid,size=512m,${owner}`);

      fs.writeFileSync(
        solutionPath,
        JSON.stringify({
          branchName: solution.branchName,
          commitMessage: solution.commitMessage,
          files: solution.files,
        }),
        { mode: 0o644 }
      );
      args.push("--mount", `type=bind,source=${solutionPath},target=${solutionTarget},ro`);

      // Create container (the token travels via the child's environment, not argv)
      onProgress?.({ stage: "running", message: "Creating container..." });
      const { id } = await this.runtime.create(
        this.imageTag,
        { env, secretEnv: { GITHUB_TOKEN: config.githubToken }, args },
        containerName
      );
      containerId = id;

      onProgress?.({
        stage: "cloning",
        message: "Container started, cloning repo and applying changes...",
      });

      // Start container (this blocks until completion or timeout)
      await this.runtime.start(id);

      const state = await this.runtime.inspect(id);
      if (state.Running) {
        await this.runtime.kill(id).catch(() => {});
        throw new Error(`Worker timed out after ${Math.round(config.workerTimeoutMs / 1000)}s`);
      }

      const logs = await this.runtime.logs(id);
      const result = parseWorkerResult(logs);

      if (state.ExitCode !== 0 || result?.status === "error") {
        const detail = result?.error ?? logs.slice(-2000);
        throw new Error(`Worker exited with code ${state.ExitCode}: ${redact(detail)}`);
      }
      if (!result) {
        throw new Error("Worker finished without reporting a result");
      }

      const effectiveBranch = result.branch || branchName;

      if (result.status === "no_changes") {
        onProgress?.({ stage: "complete", message: `Worker made no changes for #${issueNumber}` });
        return {
          success: false,
          status: "no_changes",
          branchName: effectiveBranch,
          issueNumber,
          error: "The generated solution did not change any file",
        };
      }

      onProgress?.({
        stage: "complete",
        message: `✅ Worker completed for #${issueNumber}`,
      });

      return {
        success: true,
        status: result.status,
        branchName: effectiveBranch,
        prUrl: result.url,
        issueNumber,
      };
    } catch (error) {
      const errorMsg = redact(error instanceof Error ? error.message : String(error));
      console.error(`[worker] Failed for #${issueNumber}:`, errorMsg);

      onProgress?.({
        stage: "failed",
        message: `❌ Worker failed: ${errorMsg}`,
      });

      // Collect logs on failure for debugging
      if (containerId) {
        try {
          const logs = await this.runtime.logs(containerId);
          console.error(`[worker] Container logs:\n${redact(logs.slice(-3000))}`);
        } catch {}
        await this.runtime.kill(containerId).catch(() => {});
      }

      return {
        success: false,
        status: "error",
        branchName,
        issueNumber,
        error: errorMsg,
      };
    } finally {
      // Clean up container
      if (containerId) {
        try {
          await this.runtime.rm(containerId);
        } catch {}
      }
      this.semaphore.release();
      // Remove temporary solution file
      try {
        fs.unlinkSync(solutionPath);
      } catch {}
    }
  }

  /**
   * Stop all running worker containers and resource monitor.
   */
  async stop(): Promise<void> {
    if (this.resourceMonitor) {
      this.resourceMonitor.stop();
    }
    const containers = await this.runtime.ps();
    const workerContainers = containers.filter((c) => c.Name.includes("luci-bot"));
    for (const c of workerContainers) {
      console.log(`[worker] Stopping container: ${c.Name}`);
      await this.runtime.kill(c.Id).catch(() => {});
    }
  }
}
