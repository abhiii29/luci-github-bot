// ---------------------------------------------------------------------------
// Brief 14/15: Directive parser stub (task 6 implementation lives elsewhere)
// ---------------------------------------------------------------------------
// This module provides interfaces and stubs for the directive parser
// and collaborator check. Actual implementations from task 6 replace these.
// ---------------------------------------------------------------------------

export interface ParsedLabels {
  useLocal: boolean;
  dryRun: boolean;
  noPr: boolean;
  planOnly: boolean;
  noRun: boolean;
}

export interface ParsedDirectives {
  model: "remote" | "local";
  dryRun: boolean;
  noPr: boolean;
  planOnly: boolean;
  noRun: boolean;
  targetFiles?: string[];
}

// Resolve label switches into JobOptions.
// Precedence: .luci-bot.yml limits > label > directive > defaults.
// Nothing can widen deny rules.
export function resolveLabelSwitches(labels: string[]): ParsedLabels {
  const resolved: ParsedLabels = {
    useLocal: false,
    dryRun: false,
    noPr: false,
    planOnly: false,
    noRun: false,
  };

  for (const label of labels) {
    const name = label.toLowerCase();
    if (name === "bot:local") resolved.useLocal = true;
    if (name === "bot:dry-run") resolved.dryRun = true;
    if (name === "bot:no-pr") resolved.noPr = true;
    if (name === "bot:plan-only") resolved.planOnly = true;
    if (name === "bot:no-run") resolved.noRun = true;
  }

  return resolved;
}

// Check if a user is a collaborator with write permission on a repo.
// STUB: Actual implementation checks GitHub API collaborators endpoint.
export async function isCollaborator(
  _owner: string,
  _repo: string,
  _username: string
): Promise<boolean> {
  // Stub: always allow for now; replace with GitHub API check from task 6
  return true;
}

// Parse a .luci-bot.yml body into ParsedDirectives.
// STUB: Actual YAML parser from task 6 replaces this.
export function parseDirectives(_body: string): ParsedDirectives {
  return {
    model: "remote",
    dryRun: false,
    noPr: false,
    planOnly: false,
    noRun: false,
  };
}
