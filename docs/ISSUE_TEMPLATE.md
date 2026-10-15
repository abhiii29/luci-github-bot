# Issue Templates

## bot-task.yml

A GitHub issue form for submitting tasks to the luci-github-bot. It provides structured input with fields for summary, acceptance criteria, target files, constraints, model selection, and plan-first mode.

### How to Install

Copy the template into any monitored repository:

```bash
mkdir -p .github/ISSUE_TEMPLATE
cp .github/ISSUE_TEMPLATE/bot-task.yml /path/to/monitored-repo/.github/ISSUE_TEMPLATE/
```

Or add it directly via the GitHub UI at `Settings > General > Issues > Issue templates`.

### Form Fields

| Field | Type | Required | Description |
|---|---|---|---|
| Summary | Textarea | Yes | One-sentence description of the task |
| Acceptance Criteria | Textarea | Yes | Bullet list of completion criteria |
| Target Files | Textarea | No | One file path per line; bot determines if empty |
| Constraints | Textarea | No | Special requirements or limitations |
| Model | Dropdown | Yes | `remote` (default 35B cloud) or `local` (7B Ollama) |
| Plan First | Checkbox | No | Generates a plan first, executes with `/luci go` |

### Directive Parser Compatibility

The form output is compatible with the directive parser from task 6. The `model` dropdown maps to the `model` directive, and the `plan_first` checkbox maps to the `plan-only` label (`bot:plan-only`).

### Command Reference

After a plan is generated, use `/luci` commands to control execution:

| Command | Description |
|---|---|
| `/luci retry` | Re-process the issue |
| `/luci cancel` | Cancel processing |
| `/luci status` | Show current status |
| `/luci explain` | Show parsed options |
| `/luci plan` | Generate a plan |
| `/luci go` | Execute from approved plan |

Only repo collaborators can issue commands.
