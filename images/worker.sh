#!/bin/bash
# luci-github-bot worker: clone -> apply solution -> commit -> push -> open PR.
#
# Inputs (environment): GITHUB_TOKEN, REPO_FULL_NAME, ISSUE_NUMBER, BRANCH_NAME, COMMIT_MESSAGE,
#   SOLUTION_FILE (mounted JSON, read-only), optional BASE_BRANCH, NO_PR=1,
#   GIT_BASE_URL (default https://github.com), API_BASE_URL (default https://api.github.com).
# Output: one machine-readable line `RESULT: {...}` (status: pr_created | pr_exists |
#   branch_pushed | no_changes | error). Exit code is non-zero only for `error`.
#
# Security: every LLM-controlled value (branch, commit message, file paths/contents) is only ever
# used quoted, or read by node from the environment / a JSON file. Nothing is interpolated into
# a shell command string or heredoc.
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${REPO_FULL_NAME:?REPO_FULL_NAME is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${BRANCH_NAME:?BRANCH_NAME is required}"
: "${COMMIT_MESSAGE:?COMMIT_MESSAGE is required}"
SOLUTION_FILE="${SOLUTION_FILE:-/tmp/.luci-solution.json}"
GIT_BASE_URL="${GIT_BASE_URL:-https://github.com}"
API_BASE_URL="${API_BASE_URL:-https://api.github.com}"

# Print the RESULT line using node so values are JSON-escaped correctly.
# usage: emit_result <status> [key value]...
emit_result() {
  node -e '
    const [status, ...kv] = process.argv.slice(1);
    const out = { status };
    for (let i = 0; i < kv.length; i += 2) out[kv[i]] = kv[i + 1];
    console.log("RESULT: " + JSON.stringify(out));
  ' "$@"
}

fail() {
  echo "ERROR: $1" >&2
  emit_result error error "$1"
  exit 1
}
trap 'fail "worker script failed at line $LINENO"' ERR

echo "=== luci-github-bot Worker ==="
echo "Repo: ${REPO_FULL_NAME}"
echo "Issue: #${ISSUE_NUMBER}"
echo "Branch: ${BRANCH_NAME}"
echo "Start time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM=1

# Token handling: GitHub's git-over-HTTPS wants Basic auth (same scheme as actions/checkout).
# It is supplied through git's environment config so it appears neither in URLs, on disk, nor argv.
case "$GIT_BASE_URL" in
  http://*|https://*)
    AUTH_B64=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0="http.extraHeader"
    export GIT_CONFIG_VALUE_0="Authorization: Basic ${AUTH_B64}"
    ;;
esac

git config --global advice.detachedHead false
git config --global user.name "${GIT_AUTHOR_NAME:-luci-github-bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-luci-github-bot@users.noreply.github.com}"

# --- Clone -------------------------------------------------------------------
echo "--- Cloning repository ---"
REPO_NAME=$(basename "$REPO_FULL_NAME")
git clone --quiet "${GIT_BASE_URL}/${REPO_FULL_NAME}.git" "$REPO_NAME"
cd "$REPO_NAME"
echo "Clone complete"

# --- Base branch -------------------------------------------------------------
if [ -n "${BASE_BRANCH:-}" ]; then
  DEFAULT_BRANCH="$BASE_BRANCH"
else
  DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
fi
export DEFAULT_BRANCH
echo "Base branch: ${DEFAULT_BRANCH}"
git rev-parse --verify --quiet "refs/remotes/origin/${DEFAULT_BRANCH}" >/dev/null \
  || fail "base branch '${DEFAULT_BRANCH}' does not exist in ${REPO_FULL_NAME}"

# Never overwrite an existing remote branch (e.g. a retry): pick a unique name instead.
if git ls-remote --exit-code --heads origin "$BRANCH_NAME" >/dev/null 2>&1; then
  BRANCH_NAME="${BRANCH_NAME}-$(date +%s)"
  echo "Branch already exists remotely, using ${BRANCH_NAME}"
fi
export BRANCH_NAME
git checkout --quiet -b "$BRANCH_NAME" "origin/${DEFAULT_BRANCH}"

# --- Apply the solution (mounted as a read-only JSON file) -------------------
echo "--- Applying code changes ---"
SOLUTION_FILE="$SOLUTION_FILE" node -e '
const fs = require("fs");
const path = require("path");

let solution;
try {
  solution = JSON.parse(fs.readFileSync(process.env.SOLUTION_FILE, "utf-8"));
} catch (err) {
  console.error("Failed to parse solution file:", err.message);
  process.exit(1);
}
if (!Array.isArray(solution.files) || solution.files.length === 0) {
  console.error("No files in solution to apply");
  process.exit(1);
}

const root = process.cwd();
for (const file of solution.files) {
  // Defense in depth: the bot validates paths too, but never trust the input here either.
  const target = path.resolve(root, file.path);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep)[0] === ".git") {
    console.error("Refusing path outside repository: " + file.path);
    process.exit(1);
  }
  if (file.operation === "delete") {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      console.log("Deleted: " + rel);
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    console.log((file.operation === "create" ? "Created: " : "Updated: ") + rel);
  }
}
console.log("Applied " + solution.files.length + " file(s)");
'

# --- Anything to commit? -----------------------------------------------------
if [ -z "$(git status --porcelain)" ]; then
  echo "No changes detected."
  emit_result no_changes
  exit 0
fi

# --- Commit and push (never force) -------------------------------------------
echo "--- Committing changes ---"
git add -A
git commit --quiet -m "$COMMIT_MESSAGE"

echo "--- Pushing branch ---"
git push --quiet origin "$BRANCH_NAME"

if [ "${NO_PR:-0}" = "1" ]; then
  echo "NO_PR set: branch pushed, not opening a pull request"
  emit_result branch_pushed branch "$BRANCH_NAME"
  exit 0
fi

# --- Open the PR (JSON built by node from env vars, never by shell interpolation) ---
echo "--- Creating Pull Request ---"
trap - ERR
set +e
node -e '
const http = require("http");
const https = require("https");

const { REPO_FULL_NAME, ISSUE_NUMBER, BRANCH_NAME, COMMIT_MESSAGE, GITHUB_TOKEN, DEFAULT_BRANCH, API_BASE_URL } = process.env;

const payload = JSON.stringify({
  title: COMMIT_MESSAGE,
  body:
    "Automated pull request generated by luci-github-bot.\n\n" +
    "Closes #" + ISSUE_NUMBER + "\n\n" +
    "Please review the changes carefully before merging.",
  head: BRANCH_NAME,
  base: DEFAULT_BRANCH,
});

const url = new URL(API_BASE_URL.replace(/\/$/, "") + "/repos/" + REPO_FULL_NAME + "/pulls");
const lib = url.protocol === "http:" ? http : https;
const result = (obj) => console.log("RESULT: " + JSON.stringify(Object.assign({ branch: BRANCH_NAME }, obj)));

const req = lib.request(
  url,
  {
    method: "POST",
    headers: {
      Authorization: "Bearer " + GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "User-Agent": "luci-github-bot",
    },
  },
  (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      let json = {};
      try { json = JSON.parse(data); } catch {}
      if (res.statusCode === 201) {
        result({ status: "pr_created", url: json.html_url });
      } else if (res.statusCode === 422 && /already exists/i.test(data)) {
        result({ status: "pr_exists" });
      } else {
        console.error("PR creation failed (HTTP " + res.statusCode + "): " + String(json.message || "").slice(0, 300));
        result({ status: "error", error: "PR creation failed (HTTP " + res.statusCode + ")" });
        process.exit(1);
      }
    });
  }
);
req.on("error", (err) => {
  console.error("Request error:", err.message);
  result({ status: "error", error: "PR request failed: " + err.message });
  process.exit(1);
});
req.write(payload);
req.end();
'
PR_RC=$?
set -e
echo "End time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit "$PR_RC"
