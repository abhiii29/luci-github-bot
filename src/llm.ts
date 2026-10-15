import OpenAI from "openai";
import { getConfig, getAdessoApiKey } from "./config.js";

export interface CodeGenerationResult {
  success: boolean;
  files: Array<{ path: string; content: string; operation: "create" | "update" | "delete" }>;
  branchName: string;
  commitMessage: string;
  error?: string;
}

const SYSTEM_PROMPT = `You are an expert software engineer. You receive a GitHub issue describing a feature, bugfix, or change request.

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

  const openai = new OpenAI({
    baseURL: config.adassoBaseUrl,
    apiKey,
    // Some hubs require this
    defaultHeaders: {
      "anthropic-version": "2023-06-01",
    },
  });

  const fileContext = existingFiles
    ? `\nExisting files in repo:\n${existingFiles.map((f) => `  - ${f}`).join("\n")}\n\nFor each file you need to modify, specify the full path as it appears above.`
    : "";

  const prompt = `${SYSTEM_PROMPT}

REPOSITORY: ${repoContext}

GITHUB ISSUE:
Title: ${issueTitle}
Description: ${issueBody}${fileContext}

Generate the code solution now. Output only the structured response in the exact format specified above.`;

  const response = await openai.chat.completions.create({
    model: config.adassoModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 14000,
    temperature: 0.2,
  });

  const assistantContent = response.choices[0]?.message?.content ?? "";

  return parseLLMResponse(assistantContent);
}

function parseLLMResponse(content: string): CodeGenerationResult {
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

    // Skip duplicates — later definitions override
    if (seenPaths.has(path)) {
      const idx = files.findIndex((f) => f.path === path);
      if (idx !== -1) files.splice(idx, 1);
    }

    files.push({ path, operation, content: fileContent });
    seenPaths.add(path);
  }

  // If no regex matches, fall back to line-by-line parser
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
