import type { GitHubClient } from "./github.js";
import { redact } from "./redact.js";

export type ModelAction = "plan" | "code";

/** Rolling stats per "model|action". */
export type TimingStats = Record<string, { count: number; avgMs: number; avgOutputTokens: number }>;

export interface Estimate {
  lowMs: number;
  highMs: number;
  source: "history" | "default";
}

const WINDOW = 50;
const MIN_SAMPLES = 3;
/** Measured on the Adesso gateway (Oct 2026): plans take about a minute, code a few. */
const DEFAULTS: Record<ModelAction, [number, number]> = {
  plan: [30_000, 120_000],
  code: [60_000, 300_000],
};

export const STATS_TITLE = "📊 luci-bot stats";
const STATS_MARKER = /<!-- luci-bot:stats ([A-Za-z0-9_-]+) -->/;

const key = (model: string, action: ModelAction) => `${model}|${action}`;

export function addSample(stats: TimingStats, model: string, action: ModelAction, durationMs: number, outputTokens = 0): TimingStats {
  const k = key(model, action);
  const s = stats[k] ?? { count: 0, avgMs: 0, avgOutputTokens: 0 };
  const count = s.count + 1;
  const n = Math.min(count, WINDOW);
  return {
    ...stats,
    [k]: {
      count,
      avgMs: s.avgMs + (durationMs - s.avgMs) / n,
      avgOutputTokens: s.avgOutputTokens + (outputTokens - s.avgOutputTokens) / n,
    },
  };
}

export function estimateMs(stats: TimingStats, model: string, action: ModelAction, inputTokens = 0): Estimate {
  const s = stats[key(model, action)];
  if (s && s.count >= MIN_SAMPLES) {
    return { lowMs: Math.round(s.avgMs * 0.7), highMs: Math.round(s.avgMs * 1.5), source: "history" };
  }
  const [low, high] = DEFAULTS[action];
  const extra = action === "code" ? Math.max(0, inputTokens - 8_000) : 0; // +1 s per 1,000 tokens over 8k
  return { lowMs: low + extra, highMs: high + extra, source: "default" };
}

function fmt(ms: number): string {
  const s = ms / 1000;
  return s < 90 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)} min`;
}

export function formatEstimate(e: Estimate): string {
  if (e.source === "history") return `usually ~${fmt(e.lowMs / 0.7)}`;
  return `usually ${fmt(e.lowMs)}–${fmt(e.highMs)}`;
}

// ── Storage: one closed, bot-authored issue per repo ────────────────────

type StatsGitHub = Pick<GitHubClient, "findIssueByTitle" | "createIssue" | "updateIssue">;

export function encodeStats(stats: TimingStats): string {
  const rows = Object.entries(stats).map(([k, s]) => {
    const [model, action] = k.split("|");
    return `| ${model} | ${action} | ${s.count} | ${fmt(s.avgMs)} | ${Math.round(s.avgOutputTokens)} |`;
  });
  return [
    "Response-time history used for the bot's time estimates. Updated automatically; please don't edit.",
    "",
    "| Model | Action | Runs | Avg time | Avg output tokens |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `<!-- luci-bot:stats ${Buffer.from(JSON.stringify(stats)).toString("base64url")} -->`,
  ].join("\n");
}

export function decodeStats(body: string): TimingStats {
  const m = body.match(STATS_MARKER);
  if (!m) return {};
  try {
    return JSON.parse(Buffer.from(m[1], "base64url").toString("utf-8")) as TimingStats;
  } catch {
    return {};
  }
}

export async function loadStats(gh: StatsGitHub, repo: string, botUsername: string): Promise<TimingStats> {
  try {
    const issue = await gh.findIssueByTitle(repo, STATS_TITLE, botUsername);
    return issue ? decodeStats(issue.body) : {};
  } catch (err) {
    console.warn(`[timing] Could not load stats: ${redact(err instanceof Error ? err.message : String(err))}`);
    return {};
  }
}

export async function saveStats(gh: StatsGitHub, repo: string, botUsername: string, stats: TimingStats): Promise<void> {
  try {
    const body = encodeStats(stats);
    const issue = await gh.findIssueByTitle(repo, STATS_TITLE, botUsername);
    if (issue) {
      await gh.updateIssue(repo, issue.number, { body });
    } else {
      const created = await gh.createIssue(repo, STATS_TITLE, body);
      await gh.updateIssue(repo, created.number, { state: "closed" }); // keep open issues uncluttered
    }
  } catch (err) {
    console.warn(`[timing] Could not save stats: ${redact(err instanceof Error ? err.message : String(err))}`);
  }
}
