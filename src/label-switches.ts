// Label switches: bot:local, bot:dry-run, bot:no-pr, bot:plan-only, bot:no-run.
// Precedence: .luci-bot.yml limits > label > directive > defaults.
// Nothing can widen deny rules.

export interface ParsedLabels {
  useLocal: boolean;
  dryRun: boolean;
  noPr: boolean;
  planOnly: boolean;
  noRun: boolean;
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

