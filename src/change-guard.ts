import { applyPatch, removedLineFraction } from "./patch.js";

type FileChange = { path: string; content: string; operation: "create" | "update" | "delete" | "patch" };

export interface GuardOptions {
  /** Full current content of files the bot already fetched (from repo context). */
  known: Record<string, string>;
  /** Files the model only saw truncated: a whole-file `update` of these is never allowed. */
  truncatedPaths: string[];
  /** Issue title + body, used to tell intended removals from accidental ones. */
  issueText: string;
  /** Fetches the current content of a file from the repo (null if it doesn't exist). */
  fetchCurrent: (path: string) => Promise<string | null>;
  /** Fraction of an existing file's lines an update may remove without the issue asking for it. */
  maxRemovedFraction?: number;
}

export type GuardResult =
  | { ok: true; files: Array<{ path: string; content: string; operation: "create" | "update" | "delete" }> }
  | { ok: false; reason: string };

const REMOVAL_WORDS = /\b(remove|delete|drop|strip|rewrite|replace|clean\s?up|refactor|simplify|shorten)\b/i;
/** Small files can legitimately change most of their lines. */
const MIN_LINES_FOR_DELETION_GUARD = 15;

/**
 * Turn the model's changes into whole-file writes the worker can apply, refusing anything that
 * would silently destroy code: rewrites of files the model never saw in full, patches that don't
 * apply cleanly, and updates that drop most of a file the issue didn't ask to shrink.
 */
export async function guardChanges(files: FileChange[], opts: GuardOptions): Promise<GuardResult> {
  const maxRemoved = opts.maxRemovedFraction ?? 0.4;
  const truncated = new Set(opts.truncatedPaths);
  const out: Array<{ path: string; content: string; operation: "create" | "update" | "delete" }> = [];

  const current = async (path: string): Promise<string | null> =>
    path in opts.known ? opts.known[path] : opts.fetchCurrent(path);

  for (const f of files) {
    if (f.operation === "delete" || f.operation === "create") {
      if (f.operation === "create" && (await current(f.path)) !== null) {
        // "create" over an existing file is a whole-file rewrite in disguise: guard it like one
        const res = checkRewrite(f.path, (await current(f.path))!, f.content, truncated, opts.issueText, maxRemoved);
        if (res) return { ok: false, reason: res };
      }
      out.push({ path: f.path, content: f.content, operation: f.operation });
      continue;
    }

    const before = await current(f.path);
    if (before === null) {
      if (f.operation === "patch") return { ok: false, reason: `${f.path}: patch for a file that does not exist` };
      out.push({ path: f.path, content: f.content, operation: "create" });
      continue;
    }

    if (f.operation === "patch") {
      const applied = applyPatch(before, f.content);
      if (!applied.ok) return { ok: false, reason: `${f.path}: ${applied.error}` };
      const res = checkRewrite(f.path, before, applied.content, new Set(), opts.issueText, maxRemoved);
      if (res) return { ok: false, reason: res };
      out.push({ path: f.path, content: applied.content, operation: "update" });
      continue;
    }

    const res = checkRewrite(f.path, before, f.content, truncated, opts.issueText, maxRemoved);
    if (res) return { ok: false, reason: res };
    out.push({ path: f.path, content: f.content, operation: "update" });
  }

  return { ok: true, files: out };
}

function checkRewrite(
  path: string,
  before: string,
  after: string,
  truncated: Set<string>,
  issueText: string,
  maxRemoved: number
): string | null {
  if (truncated.has(path)) {
    return `${path}: whole-file rewrite of a file the model only saw partially (it must use a patch)`;
  }
  const lines = before.split(/\r?\n/).filter((l) => l.trim()).length;
  const removed = removedLineFraction(before, after);
  if (lines >= MIN_LINES_FOR_DELETION_GUARD && removed > maxRemoved && !REMOVAL_WORDS.test(issueText)) {
    return `${path}: the change would remove ${Math.round(removed * 100)}% of the file, which the issue does not ask for`;
  }
  return null;
}
