import fs from "fs";
import path from "path";
import type { GitHubClient } from "./github.js";

/**
 * GitHub Action mode keeps the per-issue state directory (queue.json + plans/) in one hidden
 * comment on the issue, so `/luci plan` → `/luci go` and `/luci status` work across runs.
 * (The Actions cache can't be used: runs triggered by `issues` / `issue_comment` get read-only
 * cache access.) Only a comment written by the bot account is trusted.
 */

export const STATE_MARKER = "<!-- luci-bot:state";
const COMMENT_LIMIT = 60_000; // GitHub allows 65 536 characters

type Snapshot = Record<string, string>; // relative path → file content

function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : e.name.endsWith(".json") ? [path.relative(base, p)] : [];
  });
}

/** Finished jobs don't need their payload (the full event); dropping it keeps the comment small. */
function compactQueue(content: string): string {
  try {
    const q = JSON.parse(content) as { jobs?: Array<Record<string, unknown>>; deliveries?: unknown[] };
    for (const j of q.jobs ?? []) if (j.status !== "queued" && j.status !== "running") delete j.payload;
    q.deliveries = [];
    return JSON.stringify(q);
  } catch {
    return content;
  }
}

export function encodeState(stateDir: string): string {
  const snap: Snapshot = {};
  for (const rel of walk(stateDir)) {
    const content = fs.readFileSync(path.join(stateDir, rel), "utf-8");
    snap[rel] = rel === "queue.json" ? compactQueue(content) : content;
  }
  // base64url: no `--` (would end the HTML comment) and no `/luci` (would look like a command)
  const data = Buffer.from(JSON.stringify(snap)).toString("base64url");
  return `${STATE_MARKER} ${data} -->\n_luci-bot keeps its state for this issue here; please don't edit._`;
}

export function decodeState(body: string, stateDir: string): number {
  const m = body.match(/<!-- luci-bot:state ([A-Za-z0-9_-]*) -->/);
  if (!m) return 0;
  const snap = JSON.parse(Buffer.from(m[1], "base64url").toString("utf-8")) as Snapshot;
  const root = path.resolve(stateDir);
  let n = 0;
  for (const [rel, content] of Object.entries(snap)) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep) || !rel.endsWith(".json")) continue; // no traversal
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    n++;
  }
  return n;
}

export async function loadIssueState(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  botUsername: string,
  stateDir: string
): Promise<number | undefined> {
  const c = await gh.findCommentWithMarker(repo, issueNumber, STATE_MARKER, botUsername);
  return c ? decodeState(c.body, stateDir) : undefined;
}

export async function saveIssueState(
  gh: GitHubClient,
  repo: string,
  issueNumber: number,
  botUsername: string,
  stateDir: string
): Promise<void> {
  const body = encodeState(stateDir);
  if (body.length > COMMENT_LIMIT) throw new Error(`state too large for a comment (${body.length} chars)`);
  const existing = await gh.findCommentWithMarker(repo, issueNumber, STATE_MARKER, botUsername);
  if (existing) {
    if (existing.body !== body) await gh.updateComment(repo, existing.id, body);
  } else if (walk(stateDir).length > 0) {
    await gh.createComment(repo, issueNumber, body);
  }
}
