// ---------------------------------------------------------------------------
// Brief 15: Plan-only / approval flow
// ---------------------------------------------------------------------------
// Plan stage: ask LLM for a PLAN (files, approach, risks) without writing code
// Approval: /luci go starts real generation constrained to plan files
// Persistence: JSON file keyed by repo#issue, with TTL expiration
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { getConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanFile {
  path: string;
  reason: string;
  operation: "create" | "update" | "delete";
}

export interface Plan {
  branchName: string;
  commitMessage: string;
  files: PlanFile[];
  approach: string;
  risks: string[];
  openQuestions: string[];
  createdAt: string;
  issueBodyHash?: string;
}

export interface PlanState {
  plan: Plan;
  status: "pending" | "approved" | "cancelled" | "expired" | "executed";
  approvedBy?: string;
  approvedAt?: string;
  expiredAt?: string;
  issueBodyHash?: string;
}

// ---------------------------------------------------------------------------
// Persistence (JSON file-based job store)
// ---------------------------------------------------------------------------

function getPlanDir(): string {
  try {
    const config = getConfig();
    const dataDir = config.planDataDir ?? ".luci-bot-plans";
    return path.resolve(dataDir);
  } catch {
    return path.resolve(".luci-bot-plans");
  }
}

function getPlanKey(owner: string, repo: string, issueNumber: number): string {
  // Sanitize repo name to avoid path separators
  const safeRepo = repo.replace(/[/:]/g, "-");
  return `${owner}__${safeRepo}__${issueNumber}`;
}

function getPlanFilePath(key: string): string {
  return path.join(getPlanDir(), `${key}.json`);
}

function readPlanState(key: string): PlanState | null {
  const filePath = getPlanFilePath(key);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as PlanState;
  } catch {
    return null;
  }
}

function writePlanState(key: string, state: PlanState): void {
  const dir = getPlanDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getPlanFilePath(key), JSON.stringify(state, null, 2));
}

function deletePlanState(key: string): void {
  try {
    fs.unlinkSync(getPlanFilePath(key));
  } catch {
    // Ignore if file doesn't exist
  }
}

// ---------------------------------------------------------------------------
// TTL / expiration
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function isPlanExpired(state: PlanState, ttlMs: number = DEFAULT_TTL_MS): boolean {
  const created = new Date(state.plan.createdAt).getTime();
  return Date.now() - created > ttlMs;
}

// ---------------------------------------------------------------------------
// Issue body hash
// ---------------------------------------------------------------------------

export function hashIssueBody(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Top-level functions
// ---------------------------------------------------------------------------

/**
 * Create a plan for an issue. Returns the plan and the state key.
 */
export async function createPlan(
  owner: string,
  issueTitle: string,
  issueBody: string,
  repoFullName: string,
  issueNumber: number,
  /** Produces the raw plan text. Builds its own fenced prompt (see prompts.buildPlanPrompt). */
  llmGenerate: () => Promise<string>,
): Promise<{ key: string; plan: PlanState }> {
  const key = getPlanKey(owner, repoFullName, issueNumber);

  // Check if issue body changed since last plan
  const existing = readPlanState(key);
  const bodyHash = hashIssueBody(issueBody ?? "");
  if (existing && existing.plan.issueBodyHash === bodyHash && existing.status === "pending") {
    return { key, plan: existing };
  }

  const rawOutput = await llmGenerate();
  const plan = parsePlanOutput(rawOutput, issueBody ?? "");

  const state: PlanState = {
    plan,
    status: "pending",
    issueBodyHash: bodyHash,
  };

  writePlanState(key, state);

  return { key, plan: state };
}

/**
 * Approve a plan. Requires collaborator approval.
 */
/** Mark an approved plan as executed so it cannot be run twice. */
export function markPlanExecuted(key: string): void {
  const state = readPlanState(key);
  if (!state) return;
  state.status = "executed";
  writePlanState(key, state);
}

/** Stable key for a repo/issue pair ("owner/repo", n). */
export function planKeyFor(repoFullName: string, issueNumber: number): string {
  return getPlanKey(repoFullName.split("/")[0], repoFullName, issueNumber);
}

export function approvePlan(
  key: string,
  username: string
): PlanState {
  const state = readPlanState(key);
  if (!state) {
    throw new Error(`No plan found for key: ${key}`);
  }
  if (state.status === "cancelled") {
    throw new Error("Plan is cancelled");
  }
  if (state.status === "expired" || isPlanExpired(state)) {
    throw new Error("Plan is expired");
  }
  if (state.status === "executed") {
    throw new Error("Plan was already executed");
  }

  state.status = "approved";
  state.approvedBy = username;
  state.approvedAt = new Date().toISOString();

  writePlanState(key, state);
  return state;
}

/**
 * Cancel a plan.
 */
export function cancelPlan(key: string): PlanState {
  const state = readPlanState(key);
  if (!state) {
    throw new Error(`No plan found for key: ${key}`);
  }

  state.status = "cancelled";
  writePlanState(key, state);
  return state;
}

/**
 * Get plan state, checking expiration.
 */
export function getPlanState(
  owner: string,
  repo: string,
  issueNumber: number,
  ttlMs: number = DEFAULT_TTL_MS
): PlanState | null {
  const key = getPlanKey(owner, `${owner}/${repo}`, issueNumber);
  const state = readPlanState(key);
  if (!state) return null;

  if (isPlanExpired(state, ttlMs) && state.status === "pending") {
    state.status = "expired";
    state.expiredAt = new Date().toISOString();
    writePlanState(key, state);
  }

  return state;
}

/**
 * Invalidate plan due to issue body change.
 */
export function invalidatePlan(
  owner: string,
  repo: string,
  issueNumber: number,
  newBodyHash: string
): PlanState | null {
  const key = getPlanKey(owner, `${owner}/${repo}`, issueNumber);
  const state = readPlanState(key);
  if (!state) return null;
  if ((state.issueBodyHash ?? state.plan.issueBodyHash) === newBodyHash) return state;
  if (state.status !== "pending" && state.status !== "approved") return state;

  state.status = "expired";
  state.expiredAt = new Date().toISOString();
  writePlanState(key, state);
  return state;
}

/**
 * Get approved plan files for execution.
 */
export function getApprovedFiles(key: string): PlanFile[] {
  const state = readPlanState(key);
  if (!state || state.status !== "approved") {
    return [];
  }
  return state.plan.files;
}

// ---------------------------------------------------------------------------
// Plan parsing
// ---------------------------------------------------------------------------

export function parsePlanOutput(raw: string, _issueBody: string): Plan {
  const lines = raw.split("\n").map((l) => l.trim());

  let branchName = "";
  let commitMessage = "";
  let approach = "";
  const risks: string[] = [];
  const questions: string[] = [];
  const fileEntries: Array<{ path: string; operation: string; reason: string }> = [];

  for (const line of lines) {
    if (line.startsWith("BRANCH: ")) {
      branchName = line.slice(8).trim();
    } else if (line.startsWith("COMMIT: ")) {
      commitMessage = line.slice(8).trim();
    } else if (line.startsWith("APPROACH: ")) {
      approach = line.slice(10).trim();
    } else if (line.startsWith("RISK: ")) {
      risks.push(line.slice(6).trim());
    } else if (line.startsWith("QUESTION: ")) {
      questions.push(line.slice(10).trim());
    } else if (line.startsWith("FILES: ")) {
      const rest = line.slice(7).trim();
      // Parse path:operation:reason
      const parts = rest.split(":");
      if (parts.length >= 3) {
        const path_ = parts[0].trim();
        const op = parts[1].trim() as "create" | "update" | "delete";
        const reason = parts.slice(2).join(":").trim();
        if (op === "create" || op === "update" || op === "delete") {
          fileEntries.push({ path: path_, operation: op, reason });
        }
      }
    }
  }

  const files: PlanFile[] = fileEntries.map((f) => ({
    path: f.path,
    operation: f.operation as "create" | "update" | "delete",
    reason: f.reason,
  }));

  return {
    branchName: branchName || `plan/${approach.slice(0, 30).replace(/\s+/g, "-")}`,
    commitMessage: commitMessage || "Implement approved plan",
    files,
    approach: approach || "TBD",
    risks,
    openQuestions: questions,
    createdAt: new Date().toISOString(),
  };
}

/** All stored plans (for the dashboard). Expiry is applied on read. */
export function listPlans(ttlMs: number = DEFAULT_TTL_MS): Array<{
  repo: string;
  issueNumber: number;
  status: PlanState["status"];
  createdAt: string;
  approvedBy?: string;
  files: PlanFile[];
  approach: string;
}> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(getPlanDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = name.match(/^(.+?)__(.+)__(\d+)\.json$/);
    const state = readPlanState(name.replace(/\.json$/, ""));
    if (!m || !state) continue;
    const status = state.status === "pending" && isPlanExpired(state, ttlMs) ? "expired" : state.status;
    // The key stores "owner/repo" with "/" replaced by "-": the owner prefix tells us where it was.
    const owner = m[1];
    const repo = m[2].startsWith(owner + "-") ? `${owner}/${m[2].slice(owner.length + 1)}` : m[2];
    out.push({
      repo,
      issueNumber: Number(m[3]),
      status,
      createdAt: state.plan.createdAt,
      approvedBy: state.approvedBy,
      files: state.plan.files,
      approach: state.plan.approach,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
