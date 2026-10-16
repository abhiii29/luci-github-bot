import type { GitHubClient } from "./github.js";
import type { PlanPart } from "./plan.js";

export type SplitGitHub = Pick<
  GitHubClient,
  "createIssue" | "getIssue" | "addAssignees" | "createComment" | "findCommentWithMarker"
>;

export const PART_MARKER = "<!-- luci-bot:part";
export const PARTS_MARKER = "<!-- luci-bot:parts";

export function partIssueBody(
  parent: { number: number; title: string },
  part: PlanPart,
  index: number,
  total: number,
  previous?: number
): string {
  const lines: string[] = [];
  lines.push(`Part ${index} of ${total} for #${parent.number} (${parent.title})`);
  lines.push("");
  lines.push(`Scope: ${part.scope}`);
  if (part.files.length > 0) {
    lines.push(`Files to focus on: ${part.files.join(", ")}`);
  }
  if (previous !== undefined) {
    lines.push(`Depends on #${previous} (merged first).`);
  }
  lines.push("");
  lines.push(`${PART_MARKER} parent=${parent.number} index=${index} total=${total} -->`);
  return lines.join("\n");
}

export function parsePartMarker(body: string): { parent: number; index: number; total: number } | null {
  const match = body.match(/<!-- luci-bot:part parent=(\d+) index=(\d+) total=(\d+) -->/);
  if (!match) return null;
  return {
    parent: parseInt(match[1], 10),
    index: parseInt(match[2], 10),
    total: parseInt(match[3], 10),
  };
}

export function partsComment(numbers: number[]): string {
  const lines = numbers.map((n, i) => `${i + 1}. #${n}`);
  lines.push("");
  lines.push(`${PARTS_MARKER} ${numbers.join(",")} -->`);
  return lines.join("\n");
}

export function parsePartsComment(body: string): number[] | null {
  const match = body.match(/<!-- luci-bot:parts ([\d,]+) -->/);
  if (!match) return null;
  return match[1].split(",").map((s) => parseInt(s.trim(), 10));
}

export async function createSplitIssues(
  gh: SplitGitHub,
  repo: string,
  parent: { number: number; title: string },
  parts: PlanPart[],
  botUsername: string
): Promise<number[]> {
  const numbers: number[] = [];
  let previous: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const body = partIssueBody(parent, part, i + 1, parts.length, previous);
    const res = await gh.createIssue(repo, part.title, body);
    numbers.push(res.number);
    previous = res.number;
  }

  await gh.createComment(repo, parent.number, partsComment(numbers));

  if (numbers.length > 0) {
    await gh.addAssignees(repo, numbers[0], [botUsername]);
  }

  return numbers;
}

export async function nextPartAfterMerge(
  gh: SplitGitHub,
  repo: string,
  mergedIssue: number,
  botUsername: string
): Promise<{ kind: "next"; issue: number; parent: number } | { kind: "done"; parent: number } | null> {
  const issue = await gh.getIssue(repo, mergedIssue);
  if (issue.author.toLowerCase() !== botUsername.toLowerCase()) return null;

  const marker = parsePartMarker(issue.body);
  if (!marker) return null;

  const partsList = await gh.findCommentWithMarker(repo, marker.parent, PARTS_MARKER, botUsername);
  if (!partsList) return null;

  const numbers = parsePartsComment(partsList.body);
  if (!numbers) return null;

  const currentIndex = numbers.indexOf(mergedIssue);
  if (currentIndex === -1) return null;

  if (currentIndex + 1 < numbers.length) {
    return { kind: "next", issue: numbers[currentIndex + 1], parent: marker.parent };
  }
  return { kind: "done", parent: marker.parent };
}