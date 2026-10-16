import { redact as redactCore } from "./redact.js";
const STATUS_LABELS = ["bot:queued", "bot:in-progress", "bot:awaiting-review", "bot:blocked"] as const;
export const BOT_COMMENT_MARKER = "<!-- luci-bot:status -->";

// ── Public types ──────────────────────────────────────────────────────────

export interface RepoInfo {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface ClientError extends Error {
  status: number;
  retries: number;
}

export type StatusCode = (typeof STATUS_LABELS)[number];

// ── Redaction ─────────────────────────────────────────────────────────────

export function redact(text: string): string {
  // GitHub-specific forms first (keeps the readable `ghp_***` / `github_pat_***` markers),
  // then the shared patterns from redact.ts (gho_/ghs_/bearer/configured secrets).
  return redactCore(
    text
      .replace(/ghp_[A-Za-z0-9]{30,45}/g, "ghp_***")
      .replace(/github_pat_[A-Za-z0-9_]{20,60}_[A-Za-z0-9_]{20,60}/g, "github_pat_***")
      .replace(/(https?:\/\/)[^:/\s]+:([^@\s]+)@/g, "$1***:***@")
      .replace(/(token=)[^&\s]+/g, "$1***")
      .replace(/(Authorization:\s*)Bearer .+/g, "$1Bearer ***")
  );
}

export function redactError(msg: string): string {
  const r = redact(msg);
  return r.length > 200 ? r.slice(0, 200) + "..." : r;
}

// ── Retry helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoff(attempt: number): Promise<number> {
  const base = Math.min(500 * Math.pow(2, attempt), 30_000);
  const jitter = base * 0.3 * Math.random();
  return base + jitter;
}

// ── Client ────────────────────────────────────────────────────────────────

export interface GitHubClientOptions {
  token: string;
  retries?: number;
  maxRetryDelay?: number;
}

export class GitHubClient {
  private token: string;
  private retries: number;
  private maxRetryDelay: number;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.retries = options.retries ?? 2;
    this.maxRetryDelay = options.maxRetryDelay ?? 60_000;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempt: number = 0
  ): Promise<Response> {
    const res = await fetch(url, init);

    if (res.ok || res.status >= 400 && res.status < 500 && res.status !== 429) {
      return res;
    }

    if (attempt >= this.retries) {
      const body = await safeBody(res);
      const err = Object.assign(
        new Error(`GitHub API ${res.status}: ${redactError(body)}`),
        { status: res.status, retries: attempt + 1 } as ClientError
      );
      throw err;
    }

    let delayMs: number;
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      delayMs = Math.min(parseInt(retryAfter, 10) * 1000, this.maxRetryDelay);
    } else {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      if (resetHeader) {
        const resetTime = parseInt(resetHeader, 10) * 1000;
        delayMs = Math.min(Math.max(resetTime - Date.now(), 1_000), this.maxRetryDelay);
      } else {
        delayMs = await backoff(attempt);
      }
    }

    console.log(`[gh] Retry ${attempt + 1}/${this.retries} after ${Math.round(delayMs)}ms (${res.status})`);
    await sleep(delayMs);
    return this.fetchWithRetry(url, init, attempt + 1);
  }

  async getRepo(repo: string): Promise<RepoInfo> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}`,
      { headers: this.headers() }
    );
    const data = await res.json() as { default_branch: string };
    const match = repo.match(/^([^/]+)\/([^/]+)$/);
    if (!match) throw new Error("Invalid repo format: " + repo);
    return { owner: match[1], name: match[2], defaultBranch: data.default_branch };
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ labels }),
      }
    );
    if (!res.ok) {
      const body = await safeBody(res);
      throw Object.assign(
        new Error(`addLabels ${res.status}: ${redactError(body)}`),
        { status: res.status, retries: 0 } as ClientError
      );
    }
  }

  async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE", headers: this.headers() }
    );
    if (res.status === 404) return; // label not found, ignore
    if (!res.ok) {
      const body = await safeBody(res);
      throw Object.assign(
        new Error(`removeLabel ${res.status}: ${redactError(body)}`),
        { status: res.status, retries: 0 } as ClientError
      );
    }
  }

  async setLabels(repo: string, issueNumber: number, statusLabel: StatusCode): Promise<void> {
    // Exactly one bot:* status label at a time; never touch any other label on the issue.
    const removals = STATUS_LABELS.filter((l) => l !== statusLabel);
    await Promise.allSettled(removals.map((l) => this.removeLabel(repo, issueNumber, l)));
    await this.ensureLabel(repo, statusLabel);
    await this.addLabels(repo, issueNumber, [statusLabel]);
  }

  private async ensureLabel(repo: string, label: string): Promise<void> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/labels/${encodeURIComponent(label)}`,
      { method: "GET", headers: this.headers() }
    );
    if (res.status === 404) {
      // Create with a safe default color
      await this.fetchWithRetry(
        `https://api.github.com/repos/${repo}/labels`,
        {
          method: "POST",
          headers: this.jsonHeaders(),
          body: JSON.stringify({ name: label, color: "ededed" }),
        }
      );
    }
    // 200 = exists, 201 = just created
  }

  async createComment(repo: string, issueNumber: number, body: string): Promise<{ id: number; url: string }> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ body }),
      }
    );
    if (!res.ok) {
      const bodyText = await safeBody(res);
      throw Object.assign(
        new Error(`createComment ${res.status}: ${redactError(bodyText)}`),
        { status: res.status, retries: 0 } as ClientError
      );
    }
    const data = await res.json() as { id: number; html_url: string };
    return { id: data.id, url: data.html_url };
  }

  async updateComment(repo: string, commentId: number, body: string): Promise<void> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/issues/comments/${commentId}`,
      {
        method: "PATCH",
        headers: this.jsonHeaders(),
        body: JSON.stringify({ body }),
      }
    );
    if (!res.ok) {
      const bodyText = await safeBody(res);
      throw Object.assign(
        new Error(`updateComment ${res.status}: ${redactError(bodyText)}`),
        { status: res.status, retries: 0 } as ClientError
      );
    }
  }

  async findBotComment(repo: string, issueNumber: number): Promise<{ id: number; body: string } | undefined> {
    // Search comments for the bot marker
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      { headers: this.headers() }
    );
    const data = await res.json() as Array<{ id: number; body: string }>;
    return data.find((c) => c.body.includes(BOT_COMMENT_MARKER));
  }

  /** First comment containing `marker`, optionally only one written by `author`. */
  async findCommentWithMarker(
    repo: string,
    issueNumber: number,
    marker: string,
    author?: string
  ): Promise<{ id: number; body: string } | undefined> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      { headers: this.headers() }
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as Array<{ id: number; body: string; user?: { login?: string } }>;
    return data.find(
      (c) => c.body.includes(marker) && (!author || c.user?.login?.toLowerCase() === author.toLowerCase())
    );
  }

  async createIssue(repo: string, title: string, body: string): Promise<{ number: number; url: string }> {
    const res = await this.fetchWithRetry(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      const bodyText = await safeBody(res);
      throw Object.assign(
        new Error(`createIssue ${res.status}: ${redactError(bodyText)}`),
        { status: res.status, retries: 0 } as ClientError
      );
    }
    const data = (await res.json()) as { number: number; html_url: string };
    return { number: data.number, url: data.html_url };
  }

  async getIssue(
    repo: string,
    issueNumber: number
  ): Promise<{ number: number; state: string; title: string; body: string; author: string; assignees: string[]; isPullRequest: boolean }> {
    const res = await this.fetchWithRetry(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const bodyText = await safeBody(res);
      throw Object.assign(
        new Error(`getIssue ${res.status}: ${redactError(bodyText)}`),
        { status: res.status, retries: 0 } as ClientError
      );
    }
    const data = (await res.json()) as {
      number: number;
      state: string;
      title: string;
      body: string | null;
      user?: { login?: string };
      assignees?: Array<{ login: string }>;
      pull_request?: unknown;
    };
    return {
      number: data.number,
      state: data.state,
      title: data.title,
      body: data.body ?? "",
      author: data.user?.login ?? "",
      assignees: (data.assignees ?? []).map((a) => a.login),
      isPullRequest: !!data.pull_request,
    };
  }

  async addAssignees(repo: string, issueNumber: number, logins: string[]): Promise<void> {
    const res = await this.fetchWithRetry(`https://api.github.com/repos/${repo}/issues/${issueNumber}/assignees`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ assignees: logins }),
    });
    if (!res.ok) {
      const bodyText = await safeBody(res);
      throw Object.assign(
        new Error(`addAssignees ${res.status}: ${redactError(bodyText)}`),
        { status: res.status, retries: 0 } as ClientError
      );
    }
  }

  /** An open PR the bot already made for this issue (its body says "Closes #N"), if any. */
  async findOpenBotPrForIssue(repo: string, issueNumber: number): Promise<{ url: string; number: number } | undefined> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`,
      { headers: this.headers() }
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as Array<{ number: number; html_url: string; body: string | null }>;
    const closes = new RegExp(`\\bCloses #${issueNumber}\\b`);
    const pr = data.find((p) => (p.body ?? "").includes("generated by luci-github-bot") && closes.test(p.body ?? ""));
    return pr ? { url: pr.html_url, number: pr.number } : undefined;
  }

  async getPullRequestForBranch(repo: string, branch: string): Promise<{ url: string } | undefined> {
    const res = await this.fetchWithRetry(
      // `head` must be "owner:branch"; with a bare branch GitHub ignores the filter.
      `https://api.github.com/repos/${repo}/pulls?head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}&state=all&per_page=1`,
      { headers: this.headers() }
    );
    const data = await res.json() as Array<{ html_url: string }>;
    return data[0] ? { url: data[0].html_url } : undefined;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private jsonHeaders(): Record<string, string> {
    return {
      ...this.headers(),
      "Content-Type": "application/json",
    };
  }
}

async function safeBody(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

// ── Status comment builder ────────────────────────────────────────────────

export type StatusStage =
  | "queued"
  | "working"
  | "pr-opened"
  | "branch-pushed"
  | "plan-pending"
  | "dry-run"
  | "no-changes"
  | "failed";

export function buildStatusComment(
  stage: StatusStage,
  errorCategory?: string,
  prUrl?: string,
  hint?: string,
  notes: string[] = [],
  usageLine?: string
): string {
  let text = `${BOT_COMMENT_MARKER}\n\n`;
  const clean = (s: string) => redact(s.replace(/\s+at\s+\S+/g, "").replace(/\n{2,}/g, "\n").trim());

  switch (stage) {
    case "queued":
      text += "⏳ **Queued** — waiting for a worker slot.";
      break;
    case "working":
      text += "🔨 **Working** — generating a solution.";
      break;
    case "pr-opened":
      text += prUrl ? `✅ **PR opened!** [View PR](${prUrl})` : "✅ **PR opened!**";
      break;
    case "branch-pushed":
      text += `✅ **Branch pushed** — \`${hint ?? ""}\` (no PR opened, as requested).`;
      break;
    case "plan-pending":
      text += "📝 **Plan ready** — see the plan comment below. A collaborator can reply `/luci go` to implement it or `/luci cancel` to drop it.";
      break;
    case "dry-run":
      text += "🧪 **Dry run** — a solution was generated but nothing was pushed. See the summary comment below.";
      break;
    case "no-changes":
      text += "ℹ️ **No changes** — the generated solution did not change any file. Add more detail to the issue and reply `/luci retry`.";
      break;
    case "failed":
      text += `❌ **Failed** — ${errorCategory ?? "unknown"}\n\n`;
      if (hint) text += `💡 ${clean(hint)}\n\n`;
      text += "Reply `/luci retry` (or add the `needs-retry` label) to try again.";
      break;
  }

  if (notes.length > 0) {
    text += "\n\n**Notes:**\n" + notes.map((n) => `- ${clean(n)}`).join("\n");
  }
  if (usageLine) text += `\n\n${usageLine}`;

  return text;
}
