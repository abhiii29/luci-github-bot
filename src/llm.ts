import OpenAI from "openai";
import { getConfig, getAdessoApiKey } from "./config.js";
import {
  buildSingleShotPrompt,
  buildDecompositionPrompt,
  buildExecutionPrompt,
  buildRepairPrompt,
  estimateTokenCount,
  formatPromptSample,
} from "./prompts.js";

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
// HTTP helpers
// ---------------------------------------------------------------------------

async function ollamaChat(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const url = `${baseUrl}/api/chat`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300_000);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    }),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const msg = data.message as Record<string, unknown> | undefined;
  return (msg?.content as string) ?? "";
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

const LOCAL_MODEL_TRIGGER = /^@local-model\s+/m;

export function isLocalModelTrigger(issueTitle: string, issueBody?: string): boolean {
  return (
    /^(?=@local-model\s)/m.test(issueTitle) ||
    (issueBody !== undefined && /^(?=@local-model\s)/m.test(issueBody))
  );
}

export function extractLocalPrompt(issueTitle: string, issueBody?: string): string {
  const combined = `${issueTitle}\n${issueBody ?? "(no description)"}`;
  const match = combined.match(LOCAL_MODEL_TRIGGER);
  if (match) return combined.slice(match.index! + match[0].length).trim();
  return issueBody ?? "(no description)";
}

// ---------------------------------------------------------------------------
// GitHub file fetching
// ---------------------------------------------------------------------------

export async function fetchFileContent(
  githubToken: string,
  repoFullName: string,
  filePath: string,
  ref?: string
): Promise<string | null> {
  try {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : "";
    const url = `https://api.github.com/repos/${repoFullName}/contents/${encodedPath}${refParam}`;
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
// Single-shot generation for remote models (uses prompts.ts builder)
// ---------------------------------------------------------------------------

export async function generateSolution(
  issueTitle: string,
  issueBody: string,
  repoContext: string,
  existingFiles?: string[]
): Promise<CodeGenerationResult> {
  const config = getConfig();
  const apiKey = await getAdessoApiKey();

  const prompt = buildSingleShotPrompt(issueTitle, issueBody, repoContext);

  // Add file context to user prompt
  const fileContext = existingFiles
    ? `\nExisting files in repo:\n${existingFiles.map((f) => `  - ${f}`).join("\n")}\n\nFor each file you need to modify, specify the full path as it appears above.`
    : "";

  const response = await adessoChat(
    apiKey,
    config.adassoBaseUrl,
    config.adassoModel,
    prompt.system,
    prompt.user + fileContext,
    14000
  );

  return parseLLMResponse(response);
}

// ---------------------------------------------------------------------------
// Phase 1: Decomposition (local model)
// ---------------------------------------------------------------------------

async function decomposeIssue(
  issueTitle: string,
  issueBody: string,
  repoContext: string,
  existingFiles: string[],
  retryCount: number = 0
): Promise<DecompositionResult> {
  const config = getConfig();
  const prompt = buildDecompositionPrompt(
    issueTitle,
    issueBody,
    repoContext,
    existingFiles
  );

  const content = await ollamaChat(
    config.ollamaBaseUrl,
    config.ollamaModel,
    prompt.system,
    prompt.user,
    4000
  );

  const result = parseDecompositionResponse(content);
  if (!result.needsClarification || retryCount >= 1) return result;

  const retryPrompt = prompt.user + "\n\nPrevious attempt failed to produce valid JSON. " +
    "Ensure your output is a single valid JSON object with keys: branch_name, commit_message, subtasks (array), needs_clarification.";
  const retryContent = await ollamaChat(
    config.ollamaBaseUrl,
    config.ollamaModel,
    prompt.system,
    retryPrompt,
    4000
  );
  return parseDecompositionResponse(retryContent);
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
  retryCount: number = 0
): Promise<CodeGenerationResult> {
  const config = getConfig();

  const prompt = buildExecutionPrompt(subtask, repoContext, existingFiles, fileContents);

  const content = await ollamaChat(
    config.ollamaBaseUrl,
    config.ollamaModel,
    prompt.system,
    prompt.user,
    12000
  );

  let result = parseLLMResponse(content);

  if (!result.success && retryCount < 1) {
    const repairPrompt = buildRepairPrompt(
      content,
      "Could not parse LLM response (missing BRANCH/COMMIT or FILE blocks)",
      subtask,
      repoContext,
      existingFiles,
      fileContents
    );
    const retryContent = await ollamaChat(
      config.ollamaBaseUrl,
      config.ollamaModel,
      repairPrompt.system,
      repairPrompt.user,
      12000
    );
    result = parseLLMResponse(retryContent);
  }

  if (!result.success) {
    return {
      ...result,
      branchName,
      error: `Subtask ${subtask.id} failed: ${result.error}`,
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
        const result = await executeSubtask(st, repoContext, existingFiles, decomposition.branchName, githubToken, fileContents, 0);
        executed.push(result);
        resolved.add(st.id);
      }
      break;
    }

    console.log(`[llm] Phase 2: Executing ${ready.length} subtask(s) in parallel...`);
    const tasks = ready.map((st) => executeSubtask(st, repoContext, existingFiles, decomposition.branchName, githubToken, fileContents, 0));
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
