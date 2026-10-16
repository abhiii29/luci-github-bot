export interface RepoFile {
  path: string;
  type?: string;
  size?: number;
}

export interface RepoContext {
  promptSection: string;
  fileCount: number;
  /** Files whose content was cut to fit the budget: the model never saw all of them. */
  truncatedPaths: string[];
  /** Full current content of every file that was shown to the model. */
  fullContents: Record<string, string>;
}

export interface SelectedFile {
  path: string;
  content: string;
}

const SKIP_PATTERNS = [
  /^node_modules\//,
  /\.git\//,
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar\.gz|gz|bz2|7z|xls|xlsx|doc|docx|ppt|pptx|dylib|so|dll|exe|bin)$/i,
  /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|Gemfile\.lock|pip\.lock|poetry\.lock|composer\.lock)$/,
  /^vendor\//,
  /^(dist|build|out|\.next|\.nuxt|\.astro|\.svelte-kit|__pycache__|\.cache|coverage|\.pytest_cache)/,
];

const MAX_FILE_SIZE = 50_000; // 50 KB per file
const DEFAULT_CHAR_BUDGET = 60_000; // 60 KB total
const DEFAULT_MAX_FILES = 30;
const DEFAULT_PER_FILE_BUDGET = 8_000; // 8 KB per file

const CONTEXT_PROMPT_MARKER =
  "\n\n--- TRUNCATED: file too large, only first portion shown ---\n";

function isSkipPath(path: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(path));
}

async function fetchFileContent(
  githubToken: string,
  repoFullName: string,
  filePath: string,
  branch: string
): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${repoFullName}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: string; encoding?: string; size?: number };
    if (!data.content) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function fetchDefaultBranch(
  githubToken: string,
  repoFullName: string
): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!res.ok) return "main";
    const data = (await res.json()) as { default_branch?: string };
    return data.default_branch || "main";
  } catch {
    return "main";
  }
}

function rankFiles(
  files: string[],
  issueKeywords: string[]
): string[] {
  const keywordScores = new Map<string, number>();

  for (const file of files) {
    let score = 0;
    const lower = file.toLowerCase();

    // Files mentioned in the issue get highest priority
    for (const kw of issueKeywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += 100;
      }
    }

    // README and package files get extra weight
    const basename = file.split("/").pop() ?? "";
    if (/^readme\.md$/i.test(basename)) score += 50;
    if (/^package\.json$/i.test(lower)) score += 40;
    if (/^tsconfig\.json$/i.test(lower)) score += 30;

    keywordScores.set(file, score);
  }

  return [...files].sort((a, b) => (keywordScores.get(b) ?? 0) - (keywordScores.get(a) ?? 0));
}

export async function buildRepoContext(
  githubToken: string,
  repoFullName: string,
  issueTitle: string,
  issueBody: string,
  opts?: {
    charBudget?: number;
    maxFiles?: number;
    perFileBudget?: number;
  }
): Promise<RepoContext> {
  const {
    charBudget = DEFAULT_CHAR_BUDGET,
    maxFiles = DEFAULT_MAX_FILES,
    perFileBudget = DEFAULT_PER_FILE_BUDGET,
  } = opts ?? {};

  const branch = await fetchDefaultBranch(githubToken, repoFullName);

  // Fetch file tree
  let treeUrl = `https://api.github.com/repos/${repoFullName}/git/trees/${branch}?recursive=1`;
  let treeData: { tree?: RepoFile[]; truncated?: boolean } = {};

  try {
    const res = await fetch(treeUrl, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (res.ok) {
      treeData = await res.json();
    }
  } catch {
    // Try main as fallback
    treeUrl = `https://api.github.com/repos/${repoFullName}/git/trees/main?recursive=1`;
    try {
      const res = await fetch(treeUrl, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (res.ok) treeData = await res.json();
    } catch {
      return { promptSection: "", fileCount: 0, truncatedPaths: [], fullContents: {} };
    }
  }

  const allFiles: string[] = (treeData.tree || [])
    .filter((item) => item.type === "blob" && !isSkipPath(item.path))
    .map((item) => item.path);

  // Extract keywords from issue for ranking
  const issueText = `${issueTitle} ${issueBody}`.toLowerCase();
  const issueKeywords = allFiles
    .map((f) => f.toLowerCase().split("/").pop() ?? "")
    .filter((kw) => kw.length > 2 && issueText.includes(kw));

  const ranked = rankFiles(allFiles, issueKeywords);
  const selected = ranked.slice(0, maxFiles);

  // Fetch content for selected files within budget
  const selectedFiles: SelectedFile[] = [];
  const truncatedPaths: string[] = [];
  const fullContents: Record<string, string> = {};
  let totalChars = 0;

  for (const filePath of selected) {
    if (totalChars >= charBudget) break;
    if (selectedFiles.length >= maxFiles) break;

    const content = await fetchFileContent(githubToken, repoFullName, filePath, branch);
    if (!content) continue;

    const truncated =
      content.length > perFileBudget
        ? content.slice(0, perFileBudget) + CONTEXT_PROMPT_MARKER
        : content;

    totalChars += truncated.length;
    fullContents[filePath] = content;
    if (truncated !== content) truncatedPaths.push(filePath);
    selectedFiles.push({ path: filePath, content: truncated });
  }

  if (selectedFiles.length === 0) {
    return { promptSection: "", fileCount: 0, truncatedPaths: [], fullContents: {} };
  }

  let promptSection = "Relevant repository context:\n\n";
  for (const sf of selectedFiles) {
    const note = truncatedPaths.includes(sf.path) ? " (TRUNCATED — change it only with OPERATION: patch)" : "";
    promptSection += `--- FILE: ${sf.path}${note} ---\n${sf.content}\n\n`;
  }

  return { promptSection, fileCount: selectedFiles.length, truncatedPaths, fullContents };
}
