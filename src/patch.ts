/**
 * Search/replace edits for files too large to rewrite whole.
 *
 * The model answers `OPERATION: patch` with one or more blocks:
 *
 *   <<<<<<< SEARCH
 *   exact existing lines
 *   =======
 *   replacement lines
 *   >>>>>>> REPLACE
 *
 * The bot applies them to the FULL current file, so a model that only saw part of a file can still
 * change it without dropping the rest. Each SEARCH must match exactly once.
 */

export interface PatchBlock {
  search: string;
  replace: string;
}

export type PatchResult = { ok: true; content: string } | { ok: false; error: string };

const BLOCK_RE = /^<{7} SEARCH[ \t]*\n([\s\S]*?)\n?^={7}[ \t]*\n([\s\S]*?)\n?^>{7} REPLACE[ \t]*$/gm;

export function parsePatchBlocks(text: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  for (const m of normalized.matchAll(BLOCK_RE)) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  return blocks;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export function applyPatch(original: string, patchText: string): PatchResult {
  const blocks = parsePatchBlocks(patchText);
  if (blocks.length === 0) return { ok: false, error: "patch has no SEARCH/REPLACE blocks" };

  const crlf = original.includes("\r\n");
  let content = original.replace(/\r\n/g, "\n");

  for (const [i, b] of blocks.entries()) {
    if (b.search.trim() === "") return { ok: false, error: `block ${i + 1}: empty SEARCH` };
    let search = b.search;
    let n = countOccurrences(content, search);
    if (n === 0) {
      // Models often get trailing whitespace wrong; retry with it trimmed per line
      const trimLines = (s: string) => s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");
      const trimmedContent = trimLines(content);
      const trimmedSearch = trimLines(search);
      if (countOccurrences(trimmedContent, trimmedSearch) === 1) {
        content = trimmedContent;
        search = trimmedSearch;
        n = 1;
      }
    }
    if (n === 0) return { ok: false, error: `block ${i + 1}: SEARCH text not found` };
    if (n > 1) return { ok: false, error: `block ${i + 1}: SEARCH text matches ${n} places (must be unique)` };
    const at = content.indexOf(search);
    content = content.slice(0, at) + b.replace + content.slice(at + search.length);
  }

  return { ok: true, content: crlf ? content.replace(/\n/g, "\r\n") : content };
}

/**
 * Fraction of the original's non-blank lines that are gone from the updated version (0..1).
 * Used to stop "rewrites" that silently drop most of a file.
 */
export function removedLineFraction(original: string, updated: string): number {
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const before = lines(original);
  if (before.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const l of lines(updated)) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  let removed = 0;
  for (const l of before) {
    const c = remaining.get(l) ?? 0;
    if (c > 0) remaining.set(l, c - 1);
    else removed++;
  }
  return removed / before.length;
}
