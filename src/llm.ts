import OpenAI from "openai";
import { getConfig, getAdessoApiKey } from "./config.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CodeGenerationResult {
  success: boolean;
  files: Array<{ path: string; content: string; operation: "create" | "update" | "delete" }>;
  branchName: string;
  commitMessage: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Decomposition types
// ---------------------------------------------------------------------------

export interface Subtask {
  id: string;
  description: string;
  files: string[];
  dependencies: string[];
}

export interface DecompositionResult {
  branchName: string;
  commitMessage: string;
  needsClarification?: string;
  subtasks: Subtask[];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const DECOMPOSITION_SYSTEM_PROMPT = `You are an expert software architect. Your job is to break down GitHub issues into small, focused subtasks that a coding agent can execute independently.

OUTPUT FORMAT (JSON):
{
  "branch_name": "fix/issue-123-description",
  "commit_message": "Fix: concise description of changes",
  "subtasks": [
    {
      "id": "A",
      "description": "What needs to be done in this subtask (be specific). Include exact code patterns to follow from existing code.",
      "files": ["src/path/to/file.ts"],
      "dependencies": []
    }
  ],
  "needs_clarification": null
}

RULES:
- Split complex issues into 2-5 independent subtasks
- Each subtask should modify at most 2-3 files
- Use dependency arrays to express ordering constraints
- Prefer independent subtasks (empty dependencies) for parallel execution
- Prefer splitting changes across multiple files to enable parallel execution
- Split complex files: extract utilities/types to separate files, keep main file focused
- Use kebab-case branch names: fix/issue-123-description
- If the issue needs more information, fill needs_clarification and leave subtasks empty
- Be specific in descriptions: mention the exact functions, types, or patterns involved`;

const DECOMPOSITION_USER_PROMPT_TEMPLATE = `REPOSITORY: %s

GITHUB ISSUE:
Title: %s
Description: %s

Existing files in repo:
%s

Break this issue into subtasks. Output ONLY valid JSON matching the format above. Do not include markdown fences or explanations.`;

const EXECUTION_SYSTEM_PROMPT = `You are an expert software engineer. You receive a specific subtask and the CURRENT CONTENT of the files to modify.

OUTPUT FORMAT:

BRANCH: <branch-name>
COMMIT: <concise commit message>

FILE_START: <relative/path/to/file>
OPERATION: create|update|delete
<THE COMPLETE NEW FILE CONTENT HERE>
FILE_END

RULES:
- Use FILE_START/FILE_END blocks for each file
- OPERATION must be "create", "update", or "delete"
- For "create": provide the full new file content
- For "update": provide the COMPLETE new file content with changes applied (NOT a diff or patch)
- For "delete": leave the content section empty
- BRANCH and COMMIT must be on the first two lines
- Use kebab-case for branch names: fix/issue-123-description
- ONLY output files listed in the subtask — do NOT modify other files
- You MUST provide the complete file content, including all imports, types, functions, and logic not being changed
- Match the EXISTING code style: indentation, naming conventions, patterns, and architecture
- The file content you see is the CURRENT state of the file — apply only the changes described in the subtask`;

const EXECUTION_USER_PROMPT_TEMPLATE = `REPOSITORY: %s

SUBTASK (ID: %s):
%s

FILES TO MODIFY:
%s

%s

Existing files in repo (for reference only):
%s

Generate code for ONLY the files listed above. Output ONLY the structured response in the exact format specified.`;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const THINK_TAG_RE = /<\?xml[^>]*>|<think[^>]*>[\s\S]*?<\/think>|<\/?think>/gi;

export function stripThinkingTags(content: string): string {
  return content.replace(THINK_TAG_RE, "").trim();
}

export function stripMarkdownFences(content: string): string {
  return content.replace(/```(?:json)?\s*\n([\s\S]*?)\n```/g, "$1").trim();
}

async function ollamaChat(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  timeoutMs: number = 300_000
): Promise<string> {
  const url = `${baseUrl}/api/chat`;
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    options: {
      num_predict: maxTokens,
      temperature: 0.3,
    },
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok && res.status >= 500) {
        const bodyText = await res.text();
        lastError = new Error(`Ollama ${res.status}: ${bodyText.slice(0, 500)}`);
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`Ollama ${res.status}: ${bodyText.slice(0, 500)}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const doneReason = data.done_reason as string | undefined;

      if (doneReason === "length") {
        console.warn("[llm] Ollama response truncated (max tokens reached)");
      }

      const msg = data.message as Record<string, unknown> | undefined;
      let content = (msg?.content as string) ?? "";
      content = stripThinkingTags(content);
      content = stripMarkdownFences(content);
      return content;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof Error && (err.name === "AbortError" || err.message.includes("fetch failed"))) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("Ollama chat failed after retries");
}

async function adessoChat(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const openai = new OpenAI({
    baseURL: baseUrl,
    apiKey,
    defaultHeaders: { "anthropic-version": "2023-06-01" },
  });

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  });

  return response.choices[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// @local-model detection
// ---------------------------------------------------------------------------

const LOCAL_MODEL_TRIGGER = /^@local-model\s+(.+)/m;

export function isLocalModelTrigger(issueTitle: string, issueBody?: string): boolean {
  return (
    LOCAL_MODEL_TRIGGER.test(issueTitle) ||
    (issueBody !== undefined && LOCAL_MODEL_TRIGGER.test(issueBody))
  );
}

export function extractLocalPrompt(issueTitle: string, issueBody?: string): string {
  const combined = `[TITLE]\n${issueTitle}\n\n[BODY]\n${issueBody ?? "(no description)"}`;
  const match = combined.match(LOCAL_MODEL_TRIGGER);
  if (match) return match[1].trim();
  return issueBody ?? "(no description)";
}

// ---------------------------------------------------------------------------
// GitHub file fetching
// ---------------------------------------------------------------------------

export async function fetchFileContent(
  githubToken: string,
  repoFullName: string,
  filePath: string
): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single-shot generation for remote models (unchanged)
// ---------------------------------------------------------------------------

const SINGLE_SHOT_SYSTEM_PROMPT = `You are an expert software engineer. You receive a GitHub issue describing a feature, bugfix, or change request.

Your task:
1. Analyze the issue description and identify what changes are needed.
2. Determine which files need to be created, modified, or deleted.
3. Output a structured response with the exact file contents.

OUTPUT FORMAT (strictly follow this format):

BRANCH: <branch-name>
COMMIT: <concise commit message>

FILE_START: <relative/path/to/file>
OPERATION: create|update|delete
<file content here>
FILE_END

FILE_START: <relative/path/to/another-file>
OPERATION: update
<new file content here>
FILE_END

RULES:
- Use FILE_START/FILE_END blocks for each file
- OPERATION must be "create", "update", or "delete"
- For "create": provide the full new file content
- For "update": provide the complete new file content (not a diff)
- For "delete": leave the content section empty
- Each FILE_START/FILE_END block must be on its own line pair
- BRANCH and COMMIT must be on the first two lines
- Use kebab-case for branch names: fix/issue-123-description
- If the issue is unclear or cannot be implemented as described, output:
  NEEDS_CLARIFICATION: <specific questions>
- Keep changes minimal and focused on what the issue asks for
- Do not modify files not mentioned in the issue
- Follow existing code conventions in the repository`;

export async function generateSolution(
  issueTitle: string,
  issueBody: string,
  repoContext: string,
  existingFiles?: string[]
): Promise<CodeGenerationResult> {
  const config = getConfig();
  const apiKey = await getAdessoApiKey();

  const fileContext = existingFiles
    ? `\nExisting files in repo:\n${existingFiles.map((f) => `  - ${f}`).join("\n")}\n\nFor each file you need to modify, specify the full path as it appears above.`
    : "";

  const prompt = `${SINGLE_SHOT_SYSTEM_PROMPT}

REPOSITORY: ${repoContext}

GITHUB ISSUE:
Title: ${issueTitle}
Description: ${issueBody}${fileContext}

Generate the code solution now. Output only the structured response in the exact format specified above.`;

  const response = await adessoChat(
    apiKey,
    config.adassoBaseUrl,
    config.adassoModel,
    SINGLE_SHOT_SYSTEM_PROMPT,
    prompt,
    14000
  );

  return parseLLMResponse(response);
}

// ---------------------------------------------------------------------------
// Phase 1: Decomposition (local model)
// ---------------------------------------------------------------------------

/** Validate decomposition subtasks. Returns errors and warnings. */
export function validateDecomposition(subtasks: Subtask[], maxSubtasks: number, maxFiles: number): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();

  if (subtasks.length > maxSubtasks) {
    errors.push(`Too many subtasks (${subtasks.length}, max ${maxSubtasks})`);
  }

  for (const st of subtasks) {
    if (ids.has(st.id)) {
      errors.push(`Duplicate subtask id: ${st.id}`);
    }
    ids.add(st.id);

    if (st.files.length > maxFiles) {
      errors.push(`Subtask ${st.id} has ${st.files.length} files (max ${maxFiles})`);
    }

    for (const dep of st.dependencies) {
      if (!ids.has(dep) && !subtasks.find((s) => s.id === dep)) {
        errors.push(`Subtask ${st.id} depends on unknown id: ${dep}`);
      }
      if (dep === st.id) {
        errors.push(`Subtask ${st.id} has self-dependency`);
      }
    }

    for (const f of st.files) {
      if (!/^[a-zA-Z0-9_./\-]+$/ .test(f)) {
        warnings.push(`Subtask ${st.id} has non-normalized file path: ${f}`);
      }
    }
  }

  // Cycle detection (simple DFS)
  const adj = new Map<string, string[]>();
  for (const st of subtasks) adj.set(st.id, st.dependencies.filter((d) => ids.has(d)));
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of adj.get(node) ?? []) {
      if (hasCycle(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const id of ids) {
    if (hasCycle(id)) {
      errors.push("Subtask dependency cycle detected");
      break;
    }
  }

  return { errors, warnings };
}

/** Repair a subtask result that has no FILE blocks or appears truncated. */
async function repairSubtask(
  subtask: Subtask,
  repoContext: string,
  existingFiles: string[],
  branchName: string,
  githubToken: string | undefined,
  fileContents: Record<string, string>,
  config: ReturnType<typeof import("./config.js").getConfig>,
  executionMaxTokens: number
): Promise<CodeGenerationResult> {
  const filesList = subtask.files.map((f) => `  - ${f}`).join("\n") || "  (none specified)";
  const fileContexts: string[] = [];
  for (const filePath of subtask.files) {
    const content = fileContents[filePath];
    if (content) {
      fileContexts.push(`\n--- CURRENT CONTENT OF ${filePath} ---\n${content}`);
    }
  }
  const fileContextBlock = fileContexts.length > 0 ? fileContexts.join("\n\n") : "(No existing content available)";

  const prompt = `REPOSITORY: ${repoContext}\n\nSUBTASK (ID: ${subtask.id}): ${subtask.description}\n\nFILES: ${filesList}\n\n${fileContextBlock}\n\nPrevious output had no valid FILE blocks or was truncated. Please provide the COMPLETE file content for each file listed above. Output only the structured response.`;

  const content = await ollamaChat(
    config.ollamaBaseUrl,
    config.ollamaModel,
    EXECUTION_SYSTEM_PROMPT,
    prompt,
    executionMaxTokens
  );

  return parseLLMResponse(content);
}

async function decomposeIssue(
  issueTitle: string,
  issueBody: string,
  repoContext: string,
  existingFiles: string[]
): Promise<DecompositionResult> {
  const config = getConfig();
  const fileContextList = existingFiles.map((f) => `  - ${f}`).join("\n");

  const prompt = DECOMPOSITION_USER_PROMPT_TEMPLATE.replace("%s", repoContext)
    .replace("%s", issueTitle)
    .replace("%s", issueBody)
    .replace("%s", fileContextList || "  (none listed)");

  const content = await ollamaChat(
    config.ollamaBaseUrl,
    config.ollamaModel,
    DECOMPOSITION_SYSTEM_PROMPT,
    prompt,
    4000,
    config.ollamaDecompositionTimeoutMs
  );

  return parseDecompositionResponse(content);
}

// ---------------------------------------------------------------------------
// Phase 2: Execute subtasks (local model)
// ---------------------------------------------------------------------------

async function executeSubtask(
  subtask: Subtask,
  repoContext: string,
  existingFiles: string[],
  branchName: string,
  _githubToken: string | undefined,
  fileContents: Record<string, string>,
  config: ReturnType<typeof import("./config.js").getConfig>
): Promise<CodeGenerationResult> {
  const filesList = subtask.files.map((f) => `  - ${f}`).join("\n") || "  (none specified)";

  const fileContexts: string[] = [];
  for (const filePath of subtask.files) {
    const content = fileContents[filePath];
    if (content) {
      const maxLen = 5000;
      const truncated = content.length > maxLen
        ? content.slice(0, maxLen) + `\n// ... (${content.length - maxLen} more chars, truncated to save context)`
        : content;
      fileContexts.push(`\n--- CURRENT CONTENT OF ${filePath} ---\n${truncated}`);
    }
  }
  const fileContextBlock = fileContexts.length > 0 ? fileContexts.join("\n\n") : "(No existing content available for these files — treat as new files)";

  const fileContextList = existingFiles.map((f) => `  - ${f}`).join("\n");

  const prompt = EXECUTION_USER_PROMPT_TEMPLATE.replace("%s", repoContext)
    .replace("%s", subtask.id)
    .replace("%s", subtask.description)
    .replace("%s", filesList)
    .replace("%s", fileContextBlock)
    .replace("%s", fileContextList || "  (none listed)");

  const content = await ollamaChat(
    config.ollamaBaseUrl,
    config.ollamaModel,
    EXECUTION_SYSTEM_PROMPT,
    prompt,
    12000,
    config.ollamaSubtaskTimeoutMs
  );

  let result = parseLLMResponse(content);

  if (!result.success) {
    console.warn(`[llm] Subtask ${subtask.id} failed, retrying with repair prompt...`);
    const repairPrompt = `REPOSITORY: ${repoContext}

SUBTASK (ID: ${subtask.id}): ${subtask.description}

FILES: ${filesList}

${fileContextBlock}

Previous output had no valid FILE blocks or was truncated. Please provide the COMPLETE file content for each file listed above. Output only the structured response with BRANCH, COMMIT, and FILE_START/FILE_END blocks.`;

    const repaired = await ollamaChat(
      config.ollamaBaseUrl,
      config.ollamaModel,
      EXECUTION_SYSTEM_PROMPT,
      repairPrompt,
      12000,
      config.ollamaSubtaskTimeoutMs
    );

    result = parseLLMResponse(repaired);
  }

  if (!result.success) {
    return {
      ...result,
      branchName,
      error: `Subtask ${subtask.id} failed after retry: ${result.error}`,
    };
  }

  return {
    ...result,
    branchName,
  };
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

function resolveConflicts(results: CodeGenerationResult[]): CodeGenerationResult {
  let branchName = "";
  let commitMessage = "";
  for (const r of results) {
    if (r.branchName) branchName = r.branchName;
    if (r.commitMessage) commitMessage = r.commitMessage;
  }

  const fileMap = new Map<string, CodeGenerationResult["files"][number]>();
  for (const r of results) {
    for (const f of r.files) {
      fileMap.set(f.path, f);
    }
  }

  const errors: string[] = [];
  for (const r of results) {
    if (r.error) errors.push(r.error);
  }

  return {
    success: errors.length === 0 && fileMap.size > 0,
    branchName,
    commitMessage,
    files: Array.from(fileMap.values()),
    ...(errors.length > 0 && errors.length < results.length
      ? { error: `${errors.length}/${results.length} subtasks had errors: ${errors.slice(0, 3).join("; ")}` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Top-level decomposition pipeline
// ---------------------------------------------------------------------------

export async function generateSolutionWithDecomposition(
  issueTitle: string,
  issueBody: string,
  repoContext: string,
  existingFiles: string[],
  githubToken?: string
): Promise<CodeGenerationResult> {
  console.log("[llm] Phase 1: Decomposing issue...");
  const decomposition = await decomposeIssue(issueTitle, issueBody, repoContext, existingFiles);

  if (decomposition.needsClarification) {
    return {
      success: false,
      files: [],
      branchName: "",
      commitMessage: "",
      error: `Clarification needed: ${decomposition.needsClarification}`,
    };
  }

  if (decomposition.subtasks.length === 0) {
    return {
      success: false,
      files: [],
      branchName: "",
      commitMessage: "",
      error: "LLM produced no subtasks for this issue.",
    };
  }

  console.log(`[llm] Phase 1: ${decomposition.subtasks.length} subtask(s) identified`);

  // Validate decomposition structure
  const config = getConfig();
  const MAX_SUBTASKS = 12;
  const MAX_FILES_PER_SUBTASK = 20;
  const validation = validateDecomposition(
    decomposition.subtasks,
    MAX_SUBTASKS,
    MAX_FILES_PER_SUBTASK
  );

  if (validation.errors.length > 0) {
    const msg = `Invalid decomposition: ${validation.errors.join("; ")}`;
    console.error(`[llm] ${msg}`);
    return {
      success: false,
      files: [],
      branchName: "",
      commitMessage: "",
      error: msg,
    };
  }

  if (validation.warnings.length > 0) {
    console.warn(`[llm] Decomposition warnings: ${validation.warnings.join("; ")}`);
  }

  let fileContents: Record<string, string> = {};
  if (githubToken) {
    const allFiles = new Set(decomposition.subtasks.flatMap((st) => st.files));
    const fetchPromises = Array.from(allFiles).map(async (f) => {
      const content = await fetchFileContent(githubToken, repoContext, f);
      if (content) fileContents[f] = content;
    });
    await Promise.all(fetchPromises);
    console.log(`[llm] Fetched ${Object.keys(fileContents).length}/${allFiles.size} file contents for subtasks`);
  }

  const executed: CodeGenerationResult[] = [];
  const resolved = new Set<string>();
  const remaining = [...decomposition.subtasks];

  while (remaining.length > 0) {
    const ready = remaining.filter(
      (st) => st.dependencies.every((d) => resolved.has(d))
    );

    if (ready.length === 0) {
      for (const st of remaining) {
        const result = await executeSubtask(st, repoContext, existingFiles, decomposition.branchName, githubToken, fileContents, config);
        executed.push(result);
        resolved.add(st.id);
      }
      break;
    }

    console.log(`[llm] Phase 2: Executing ${ready.length} subtask(s) in parallel...`);
    const tasks = ready.map((st) => executeSubtask(st, repoContext, existingFiles, decomposition.branchName, githubToken, fileContents, config));
    const batchResults = await Promise.all(tasks);
    executed.push(...batchResults);

    for (const st of ready) resolved.add(st.id);
    const readyIds = new Set(ready.map((st) => st.id));
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (readyIds.has(remaining[i].id)) remaining.splice(i, 1);
    }
  }

  console.log(`[llm] Phase 2: ${executed.length} subtask(s) completed, resolving conflicts...`);
  return resolveConflicts(executed);
}

// ---------------------------------------------------------------------------
// Existing single-shot parser (unchanged)
// ---------------------------------------------------------------------------

export function parseLLMResponse(content: string): CodeGenerationResult {
  const normalized = content
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .join("\n");

  const clarificationMatch = content.match(/^NEEDS_CLARIFICATION:\s*(.+)$/m);
  if (clarificationMatch) {
    return {
      success: false,
      files: [],
      branchName: "",
      commitMessage: "",
      error: clarificationMatch[1].trim(),
    };
  }

  const branchMatch = content.match(/^BRANCH:\s*(.+)$/m);
  const commitMatch = content.match(/^COMMIT:\s*(.+)$/m);
  let branchName = branchMatch ? branchMatch[1].trim() : "";
  let commitMessage = commitMatch ? commitMatch[1].trim() : "";

  if (branchName && !commitMessage) {
    commitMessage = `Apply ${branchName.replace(/[\s/]+/g, " ")} changes`;
  }

  const fileRegex =
    /FILE_START:\s*(.+?)\s*\n(OPERATION:\s*(create|update|delete)\s*\n)?([\s\S]*?)(?=\nFILE_START:|\nFILE_END|\n\nFILE_END|$)/g;

  const files: CodeGenerationResult["files"] = [];
  const seenPaths = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(content)) !== null) {
    const path = match[1].trim();
    const operation = (match[3]?.trim() ?? "create") as "create" | "update" | "delete";
    const fileContent = match[4]?.trimEnd() ?? "";

    if (operation !== "create" && operation !== "update" && operation !== "delete") {
      continue;
    }

    if (seenPaths.has(path)) {
      const idx = files.findIndex((f) => f.path === path);
      if (idx !== -1) files.splice(idx, 1);
    }

    files.push({ path, operation, content: fileContent });
    seenPaths.add(path);
  }

  if (files.length === 0) {
    const result = parseLLMResponseFallback(content);
    if (result.files.length === 0 && (!branchName || !commitMessage)) {
      return {
        success: false,
        files: [],
        branchName: "",
        commitMessage: "",
        error: `Could not parse BRANCH/COMMIT or any FILE blocks from LLM response. Response length: ${content.length} chars`,
      };
    }
    if (!branchName || !commitMessage) {
      branchName = branchName || "bot/issue-unknown";
      commitMessage = commitMessage || "Apply generated changes";
    }
    return {
      success: result.files.length > 0,
      files: result.files,
      branchName,
      commitMessage,
    };
  }

  if (!branchName || !commitMessage) {
    return {
      success: false,
      files: [],
      branchName: "",
      commitMessage: "",
      error: `Parsed ${files.length} file(s) but could not extract BRANCH and COMMIT from response`,
    };
  }

  return {
    success: files.length > 0,
    files,
    branchName,
    commitMessage,
  };
}

function parseLLMResponseFallback(content: string): CodeGenerationResult {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  let branchName = "";
  let commitMessage = "";
  const files: CodeGenerationResult["files"] = [];
  let currentFile: {
    path: string;
    operation: "create" | "update" | "delete";
    content: string;
  } | null = null;

  for (const line of lines) {
    if (!branchName && line.startsWith("BRANCH: ")) {
      branchName = line.slice(8).trim();
      continue;
    }
    if (!commitMessage && line.startsWith("COMMIT: ") && branchName) {
      commitMessage = line.slice(8).trim();
      continue;
    }
    if (line.startsWith("FILE_START: ")) {
      if (currentFile) {
        files.push({ path: currentFile.path, content: currentFile.content.trimEnd(), operation: currentFile.operation });
      }
      currentFile = { path: line.slice(12).trim(), operation: "create", content: "" };
      continue;
    }
    if (currentFile && line.startsWith("OPERATION: ")) {
      const op = line.slice(11).trim() as "create" | "update" | "delete";
      if (op === "create" || op === "update" || op === "delete") {
        currentFile.operation = op;
      }
      continue;
    }
    if (currentFile && line.startsWith("FILE_END")) {
      files.push({ path: currentFile.path, content: currentFile.content.trimEnd(), operation: currentFile.operation });
      currentFile = null;
      continue;
    }
    if (currentFile) {
      currentFile.content += line + "\n";
    }
  }

  if (currentFile) {
    files.push({ path: currentFile.path, content: currentFile.content.trimEnd(), operation: currentFile.operation });
  }

  return { success: files.length > 0, files, branchName, commitMessage };
}

export function parseDecompositionResponse(content: string): DecompositionResult {
  let cleaned = content.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      branchName: "",
      commitMessage: "",
      subtasks: [],
      needsClarification: "Failed to parse LLM JSON output for decomposition.",
    };
  }

  const branchName = (parsed.branch_name as string) ?? "";
  const commitMessage = (parsed.commit_message as string) ?? "";
  const needsClarification = (parsed.needs_clarification as string | null) ?? undefined;
  const subtaskRaw = parsed.subtasks as unknown[];

  if (!Array.isArray(subtaskRaw)) {
    return { branchName, commitMessage, subtasks: [], needsClarification: "Missing subtasks array in decomposition output." };
  }

  const subtasks: Subtask[] = [];
  for (const st of subtaskRaw) {
    if (typeof st !== "object" || st === null) continue;
    const s = st as Record<string, unknown>;
    subtasks.push({
      id: (s.id as string) ?? `sub-${subtasks.length}`,
      description: (s.description as string) ?? "",
      files: Array.isArray(s.files)
        ? (s.files as string[]).filter(Boolean)
        : [],
      dependencies: Array.isArray(s.dependencies)
        ? (s.dependencies as string[]).filter(Boolean)
        : [],
    });
  }

  return { branchName, commitMessage, needsClarification, subtasks };
}
