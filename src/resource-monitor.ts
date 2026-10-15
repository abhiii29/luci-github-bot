import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ResourceStats {
  cpuUsagePercent: number;
  memoryUsedPercent: number;
  capacity: number; // 0-1, fraction of system resources available
}

export class ResourceMonitor {
  private polling: boolean = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private stats: ResourceStats = { cpuUsagePercent: 0, memoryUsedPercent: 0, capacity: 1 };
  private onCapacityChange?: (capacity: number, prevCapacity: number) => void;

  constructor(
    private readonly cpuThreshold: number,
    private readonly memoryThreshold: number,
    private readonly checkIntervalMs: number,
    private readonly onNotify?: (message: string) => void
  ) {}

  /** Start background resource polling */
  start(onCapacityChange?: (capacity: number, prevCapacity: number) => void): void {
    this.onCapacityChange = onCapacityChange;
    if (this.polling) return;
    this.polling = true;
    this.poll();
    this.intervalId = setInterval(() => this.poll(), this.checkIntervalMs);
  }

  /** Stop background polling */
  stop(): void {
    this.polling = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Get current capacity (0-1). 1 = fully available, 0 = exhausted */
  getCapacity(): number {
    return this.stats.capacity;
  }

  /** Get current stats snapshot */
  getStats(): ResourceStats {
    return { ...this.stats };
  }

  private async poll(): Promise<void> {
    try {
      const stats = await this.collectStats();
      const prevCapacity = this.stats.capacity;
      this.stats = stats;

      if (this.onCapacityChange && stats.capacity !== prevCapacity) {
        this.onCapacityChange(stats.capacity, prevCapacity);
      }
    } catch (err) {
      // Don't crash the bot on monitoring errors
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[resource-monitor] Polling error: ${msg}`);
    }
  }

  /** Collect CPU and memory stats from macOS */
  private async collectStats(): Promise<ResourceStats> {
    const cpu = await this.getCpuUsage();
    const memory = await this.getMemoryPressure();
    const capacity = this.calculateCapacity(cpu, memory);
    return { cpuUsagePercent: cpu, memoryUsedPercent: memory, capacity };
  }

  private async getCpuUsage(): Promise<number> {
    try {
      const { stdout } = await execFileAsync("top", ["-l", "1", "-n", "1"]);
      // Parse: "% CPU usage" or "CPU usage: X.X%"
      const match = stdout.match(/CPU usage:\s*([\d.]+)%/i);
      if (match) return parseFloat(match[1]);
      // Fallback: look for "Tasks: ... \n%CPU ..."
      const lines = stdout.split("\n");
      for (const line of lines) {
        const cpuMatch = line.match(/(\d+\.\d+)\%.*cpu/);
        if (cpuMatch) {
          // This is usually idle CPU, invert to get usage
          return 100 - parseFloat(cpuMatch[1]);
        }
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private async getMemoryPressure(): Promise<number> {
    try {
      // Get total memory
      const { stdout: memSize } = await execFileAsync("sysctl", ["hw.memsize"]);
      const totalBytes = parseInt(memSize.match(/:\s*(\d+)/)?.[1] ?? "0");
      if (totalBytes === 0) return 0;

      // Get memory pages
      const { stdout: vmStat } = await execFileAsync("vm_stat");
      const pageBytes = 4096;

      // Parse vm_stat: pages free, active, inactive, wired
      const lines = vmStat.split("\n");
      let activePages = 0;
      let wiredPages = 0;
      let usedPages = 0;

      for (const line of lines) {
        const clean = line.trim().replace(/pages\s*[\w\s]*:/, "").trim();
        const pages = parseInt(clean) || 0;

        if (line.includes("Pages active")) activePages = pages;
        if (line.includes("Pages wired")) wiredPages = pages;
        if (line.includes("Pages free")) {
          // Memory used = total - free
          const totalPages = totalBytes / pageBytes;
          usedPages = totalPages - pages;
        }
      }

      // Memory pressure = (active + wired) / total — these are the "hard to reclaim" pages
      const pressure = ((activePages + wiredPages) / (totalBytes / pageBytes)) * 100;
      return Math.min(100, Math.max(0, pressure));
    } catch {
      return 0;
    }
  }

  private calculateCapacity(cpu: number, memory: number): number {
    // If either threshold exceeded, capacity drops
    const cpuHeadroom = Math.max(0, this.cpuThreshold - cpu) / this.cpuThreshold;
    const memoryHeadroom = Math.max(0, this.memoryThreshold - memory) / this.memoryThreshold;

    // Use min of both — the most constrained resource determines capacity
    // Apply a smoothing curve: capacity drops faster as we approach thresholds
    const capacity = Math.min(cpuHeadroom, memoryHeadroom);

    // Clamp to 0-1
    return Math.max(0, Math.min(1, capacity));
  }
}
