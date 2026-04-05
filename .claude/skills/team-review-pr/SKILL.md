---
name: team-review-pr
description: Team code review for a GitHub PR using Claude and Codex. Agents review independently, leader reconciles until consensus.
argument-hint: "[#PR-number | branch-name]"
---

# Team Review PR

Review a GitHub PR using Claude and Codex agents.

## Input

Determine the target from `$ARGUMENTS`:

- **`#123`** (starts with `#`): Use `gh pr diff 123` and `gh pr view 123`.
- **Branch name** (e.g. `feature/login`): Use `gh pr diff <branch>` and `gh pr view <branch>`.
- **(empty)**: Use `gh pr diff` and `gh pr view` (current branch's PR).

## Workflow

1. **Leader (you)**: Fetch the diff and PR context. Identify changed files. Determine if any test files were added or modified.
2. Follow the shared workflow in [workflow.md](../team-review-local/workflow.md).
