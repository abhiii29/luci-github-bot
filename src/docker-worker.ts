import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { GitHubIssueEvent } from "./webhook.js";
import { getConfig } from "./config.js";
import { CodeGenerationResult } from "./llm.js";
import { ResourceMonitor, ResourceStats } from "./resource-monitor.js";

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

export interface WorkerResult {
  success: boolean;
  branchName: string;
  prUrl?: string;
  issueNumber: number;
  error?: string;
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
  create(image: string, env: string[], containerName: string): Promise<{ id: string }>;
  start(containerId: string): Promise<void>;
  logs(containerId: string): Promise<string>;
  inspect(containerId: string): Promise<{ Running: boolean; ExitCode: number }>;
  kill(containerId: string): Promise<void>;
  rm(containerId: string): Promise<void>;
  ps(): Promise<Array<{ Id: string; Name: string; Status: string }>>;
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

  private async runWithOutput(args: string[], opts?: { timeout?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = opts?.timeout ?? 300_000;
      execFile(
        "podman",
        args,
        { timeout, maxBuffer: 10 * 1024 * 1024 },
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

  async create(image: string, env: string[], containerName: string): Promise<{ id: string }> {
    const envArgs = env.flatMap((e) => ["-e", e]);
    const result = await this.runWithOutput([
      "create",
      "--name",
      containerName,
      ...envArgs,
      image,
    ]);
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

  private async runWithOutput(args: string[], opts?: { timeout?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("docker", args, { timeout: opts?.timeout ?? 300_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
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

  async create(image: string, env: string[], containerName: string): Promise<{ id: string }> {
    const envArgs = env.flatMap((e) => ["-e", e]);
    const result = await this.runWithOutput([
      "create",
      "--name",
      containerName,
      ...envArgs,
      image,
    ]);
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

    try {
      await execFile(
        this.runtime.name,
        ["image", "inspect", this.imageTag],
        { timeout: 5_000, maxBuffer: 1024 }
      );
      this.imageBuilt = true;
      console.log(`[worker] ${this.runtime.name} image already exists`);
      return;
    } catch {
      // Build it
    }

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
    onProgress?: (progress: WorkerProgress) => void
  ): Promise<WorkerResult> {
    const config = getConfig();
    const repoFullName = event.repository.full_name;
    const issueNumber = event.issue.number;
    const branchName = solution.branchName || `bot/issue-${issueNumber}`;
    const containerName = `luci-bot-${issueNumber}-${Date.now().toString(36)}`;

    onProgress?.({
      stage: "starting",
      message: `Queued: ${repoFullName}#${issueNumber}`,
    });

    // Acquire semaphore slot
    await this.semaphore.acquire();
    let containerId: string | null = null;

    try {
      onProgress?.({
        stage: "starting",
        message: `Acquired slot. Starting container for ${repoFullName}#${issueNumber}`,
      });

      // Ensure image exists
      if (!this.imageBuilt) {
        await this.ensureImage();
      }

      // Pull image (best effort)
      onProgress?.({ stage: "pulling", message: "Pulling image..." });
      try {
        await this.runtime.pull(this.imageTag);
      } catch {
        // Image already local or build is in progress
      }

      // Prepare environment variables
      const env = [
        `GITHUB_TOKEN=${config.githubToken}`,
        `REPO_FULL_NAME=${repoFullName}`,
        `ISSUE_NUMBER=${issueNumber}`,
        `BRANCH_NAME=${branchName}`,
        `COMMIT_MESSAGE=${solution.commitMessage}`,
        `GIT_AUTHOR_NAME=${config.gitAuthorName}`,
        `GIT_AUTHOR_EMAIL=${config.gitAuthorEmail}`,
        `CODE_SOLUTION=${JSON.stringify(solution)}`,
        `WORKER_TIMEOUT_MS=${config.workerTimeoutMs}`,
      ];

      // Create container
      onProgress?.({ stage: "running", message: "Creating container..." });
      const { id } = await this.runtime.create(this.imageTag, env, containerName);
      containerId = id;

      onProgress?.({
        stage: "cloning",
        message: "Container started, cloning repo and coding...",
      });

      // Start container (this blocks until completion or timeout)
      await this.runtime.start(id);

      // Check result
      const state = await this.runtime.inspect(id);

      if (state.ExitCode !== 0) {
        const logs = await this.runtime.logs(id);
        const errorLog = logs.slice(-2000);
        throw new Error(`Worker exited with code ${state.ExitCode}: ${errorLog}`);
      }

      onProgress?.({
        stage: "complete",
        message: `✅ Worker completed for #${issueNumber}`,
      });

      return {
        success: true,
        branchName,
        issueNumber,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[worker] Failed for #${issueNumber}:`, errorMsg);

      onProgress?.({
        stage: "failed",
        message: `❌ Worker failed: ${errorMsg}`,
      });

      // Collect logs on failure for debugging
      if (containerId) {
        try {
          const logs = await this.runtime.logs(containerId);
          console.error(`[worker] Container logs:\n${logs.slice(-3000)}`);
        } catch {}
        await this.runtime.kill(containerId).catch(() => {});
      }

      return {
        success: false,
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
