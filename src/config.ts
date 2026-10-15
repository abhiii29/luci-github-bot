import { z } from "zod";
import fs from "fs";
import path from "path";

const configSchema = z.object({
  githubToken: z.string().min(5, "GITHUB_TOKEN must be a valid PAT"),
  adassoBaseUrl: z.string().url("ADASSO_BASE_URL must be a valid URL"),
  adassoApiKeyFile: z.string().default("~/.config/opencode/adesso.key"),
  adassoModel: z.string().default("qwen-3.6-35b-sovereign"),
  ngrokAuthToken: z.string().min(10).optional(),
  listenPort: z.coerce.number().default(3000),
  webhookSecret: z.string().min(1, "WEBHOOK_SECRET is required"),
  monitoredRepos: z.array(z.string()).default(["luci/luci-bot"]),
  workerTimeoutMs: z.coerce.number().default(600_000), // 10 minutes
  maxConcurrentWorkers: z.coerce.number().min(1).max(10).default(1),
  containerRuntime: z.enum(["docker", "podman"]).default("podman"),
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  ollamaModel: z.string().default("qwen3:8b"),
  memoryPressureMax: z.coerce.number().min(0).max(100).default(85),
  cpuMax: z.coerce.number().min(0).max(100).default(90),
  resourceCheckIntervalMs: z.coerce.number().min(1000).default(10_000),
  gitAuthorName: z.string().default("luci-github-bot"),
  gitAuthorEmail: z.string().default("luci-github-bot@users.noreply.github.com"),
  botUsername: z.string().optional(),
  containerMemory: z.string().optional(),
  containerCpus: z.coerce.number().optional(),
  containerPidsLimit: z.coerce.number().optional(),
});

export type Config = z.infer<typeof configSchema>;

function expandHome(filepath: string): string {
  return filepath.replace(/^~($|\/)/, `${process.env.HOME}/`);
}

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), ".env");
  const result: Record<string, string> = {};

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      const unquoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
          ? value.slice(1, -1)
          : value;
      result[key] = unquoted;
    }
  }

  // Process.env takes precedence
  return { ...result, ...process.env } as unknown as Record<string, string>;
}

function parseMonitoredRepos(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      if (!r.includes("/")) throw new Error(`Invalid repo format: "${r}". Use owner/repo`);
      return r;
    });
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const env = loadEnv();

  const raw = {
    githubToken: env.GITHUB_TOKEN ?? "",
    adassoBaseUrl: env.ADASSO_BASE_URL ?? "https://adesso-ai-hub.3asabc.de/v1",
    adassoApiKeyFile: env.ADASSO_API_KEY_FILE ?? "~/.config/opencode/adesso.key",
    adassoModel: env.ADASSO_MODEL ?? "qwen-3.6-35b-sovereign",
    ngrokAuthToken: env.NGROK_AUTHTOKEN || undefined,
    listenPort: env.LISTEN_PORT ?? "3000",
    webhookSecret: env.WEBHOOK_SECRET ?? "",
    monitoredRepos: env.MONITORED_REPOS ?? "luci/luci-bot",
    workerTimeoutMs: env.WORKER_TIMEOUT_MS ?? "600000",
    maxConcurrentWorkers: env.MAX_CONCURRENT_WORKERS ?? "3",
    containerRuntime: (env.CONTAINER_RUNTIME as "docker" | "podman") ?? "podman",
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: env.OLLAMA_MODEL ?? "qwen3:8b",
    memoryPressureMax: env.MEMORY_PRESSURE_MAX ?? "85",
    cpuMax: env.CPU_MAX ?? "90",
    resourceCheckIntervalMs: env.RESOURCE_CHECK_INTERVAL_MS ?? "10000",
    gitAuthorName: env.GIT_AUTHOR_NAME ?? "luci-github-bot",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? "luci-github-bot@users.noreply.github.com",
    containerMemory: env.CONTAINER_MEMORY,
    containerCpus: env.CONTAINER_CPUS,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
  };

  const resolvedRepos = parseMonitoredRepos(raw.monitoredRepos);
  const resolvedBotUsername =
    env.GITHUB_BOT_USERNAME ||
    resolvedRepos[0]?.split("/")[0] ||
    "luci-github-bot";

  _config = configSchema.parse({
    ...raw,
    monitoredRepos: resolvedRepos,
    botUsername: resolvedBotUsername,
  });

  return _config;
}

export async function getAdessoApiKey(): Promise<string> {
  const config = getConfig();
  const filePath = expandHome(config.adassoApiKeyFile);
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content;
}
