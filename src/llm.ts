import OpenAI from "openai";
import { applyPatch } from "./patch.js";
import { getConfig, getAdessoApiKey } from "./config.js";
import {
  buildSingleShotPrompt,
  buildPlanPrompt,
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
  files: Array<{ path: string; content: string; operation: "create" | "update" | "delete" | "patch" }>;
  branchName: string;
  commitMessage: string;
  error?: string;
  /** The model declined (REFUSE: ...). Not retryable. */
  refused?: string;
  /** The model asked for more information (NEEDS_CLARIFICATION: ...). Not retryable. */
  clarification?: string;
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

export function substituteTemplate(template: string, values: string[]): string {
  return template.replace(/%s/g, () => values.shift() ?? "");
}

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

export class TruncatedResponseError extends Error {
  constructor(maxTokens: number) {
    super(`Model response truncated at max_tokens=${maxTokens}`);
    this.name = "TruncatedResponseError";
  }
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

  // Stream: the gateway drops non-streamed requests that generate for more than ~80s (502).
  const stream = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
    stream: true,
  });

  let content = "";
  let finishReason: string | null | undefined;
  for await (const chunk of stream) {
    content += chunk.choices[0]?.delta?.content ?? "";
    finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
  }
  if (finishReason === "length") {
    throw new TruncatedResponseError(maxTokens);
  }
  return stripThinkingTags(content);
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

  let response: string;
  try {
    response = await adessoChat(
      apiKey,
      config.adassoBaseUrl,
      config.adassoModel,
      prompt.system,
      prompt.user + fileContext,
      14000
    );
  } catch (err) {
    // A cut-off answer yields half-written files; never turn it into a PR.
    if (err instanceof TruncatedResponseError) {
      return { success: false, files: [], branchName: "", commitMessage: "", error: `${err.message}. Narrow the issue scope or split it.` };
    }
    throw err;
  }

  return parseLLMResponse(response);
}

/**
 * Ask the model for a change PLAN (no code). Used by the plan-only / approval flow.
 */
export async function generatePlanText(
  issueTitle: string,
  issueBody: string,
  repoContext: string,
  useLocal: boolean
): Promise<string> {
  const config = getConfig();
  const prompt = buildPlanPrompt(issueTitle, issueBody, repoContext);
  if (useLocal) {
    return stripMarkdownFences(
      await ollamaChat(config.ollamaBaseUrl, config.ollamaModel, prompt.system, prompt.user, 3000, config.ollamaDecompositionTimeoutMs)
    );
  }
  const apiKey = await getAdessoApiKey();
  return adessoChat(apiKey, config.adassoBaseUrl, config.adassoModel, prompt.system, prompt.user, 8000);
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
    4000,
    config.ollamaDecompositionTimeoutMs
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
  config: ReturnType<typeof import("./config.js").getConfig>,
  retryCount: number = 0
): Promise<CodeGenerationResult> {
  const prompt = buildExecutionPrompt(subtask, repoContext, existingFiles, fileContents);

  const content = await ollamaChat(
    config.ollamaBaseUrl,
    config.ollamaModel,
    prompt.system,
    prompt.user,
    12000,
    config.ollamaSubtaskTimeoutMs
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

/** A single local Ollama instance is the bottleneck; more parallel requests just queue up there. */
const LOCAL_SUBTASK_PARALLELISM = 2;

export async function generateSolutionWithDecomposition(
  issueTitle: string,
  issueBody: string,
  repoContext: string,
  existingFiles: string[],
  githubToken?: string,
  /** "owner/repo" — used to fetch current file contents (repoContext is prompt text, not a name). */
  repoFullName?: string
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
  // Matches what the decomposition prompt asks for (2-5 subtasks, 2-3 files each), with a little slack
  const MAX_SUBTASKS = 6;
  const MAX_FILES_PER_SUBTASK = 3;
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
  if (githubToken && repoFullName) {
    const allFiles = new Set(decomposition.subtasks.flatMap((st) => st.files));
    const fetchPromises = Array.from(allFiles).map(async (f) => {
      const content = await fetchFileContent(githubToken, repoFullName, f);
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
        const result = await executeSubtask(st, repoContext, existingFiles, decomposition.branchName, githubToken, fileContents, config, 0);
        executed.push(result);
        resolved.add(st.id);
      }
      break;
    }

    // Subtasks that touch the same file must not run side by side (the later write would drop the
    // earlier one's changes): defer them to a later round, where they see the updated content.
    const claimed = new Set<string>();
    const batch = ready.filter((st) => {
      if (st.files.some((f) => claimed.has(f))) return false;
      st.files.forEach((f) => claimed.add(f));
      return true;
    });

    console.log(`[llm] Phase 2: Executing ${batch.length} subtask(s), at most ${LOCAL_SUBTASK_PARALLELISM} at a time...`);
    for (let i = 0; i < batch.length; i += LOCAL_SUBTASK_PARALLELISM) {
      const chunk = batch.slice(i, i + LOCAL_SUBTASK_PARALLELISM);
      const results = await Promise.all(
        chunk.map((st) => executeSubtask(st, repoContext, existingFiles, decomposition.branchName, githubToken, fileContents, config, 0))
      );
      executed.push(...results);
      // Later subtasks build on what earlier ones wrote
      for (const r of results) {
        for (const f of r.files) {
          if (f.operation === "patch") {
            // Apply against the full content we hold, so later subtasks (and the bot) see a whole file
            const current = fileContents[f.path];
            const applied = current !== undefined ? applyPatch(current, f.content) : null;
            if (applied?.ok) {
              f.operation = "update";
              f.content = applied.content;
            } else {
              r.success = false;
              r.error = `patch for ${f.path} failed: ${applied ? applied.error : "file content unavailable"}`;
              continue;
            }
          }
          if (f.operation === "delete") delete fileContents[f.path];
          else fileContents[f.path] = f.content;
        }
      }
    }

    for (const st of batch) resolved.add(st.id);
    const doneIds = new Set(batch.map((st) => st.id));
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (doneIds.has(remaining[i].id)) remaining.splice(i, 1);
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

  const refuseMatch = content.match(/^REFUSE:\s*(.+)$/m);
  if (refuseMatch && !/^FILE_START:/m.test(content)) {
    return {
      success: false,
      files: [],
      branchName: "",
      commitMessage: "",
      error: `Model refused: ${refuseMatch[1].trim()}`,
      refused: refuseMatch[1].trim(),
    };
  }

  const clarificationMatch = content.match(/^NEEDS_CLARIFICATION:\s*(.+)$/m);
  if (clarificationMatch) {
    return {
      success: false,
      files: [],
      branchName: "",
      commitMessage: "",
      error: clarificationMatch[1].trim(),
      clarification: clarificationMatch[1].trim(),
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
    /FILE_START:\s*(.+?)\s*\n(OPERATION:\s*(create|update|delete|patch)\s*\n)?([\s\S]*?)(?=\nFILE_START:|\nFILE_END|\n\nFILE_END|$)/g;

  const files: CodeGenerationResult["files"] = [];
  const seenPaths = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(content)) !== null) {
    const path = match[1].trim();
    const operation = (match[3]?.trim() ?? "create") as "create" | "update" | "delete" | "patch";
    const fileContent = match[4]?.trimEnd() ?? "";

    if (operation !== "create" && operation !== "update" && operation !== "delete" && operation !== "patch") {
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
    operation: "create" | "update" | "delete" | "patch";
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
      const op = line.slice(11).trim() as "create" | "update" | "delete" | "patch";
      if (op === "create" || op === "update" || op === "delete" || op === "patch") {
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
