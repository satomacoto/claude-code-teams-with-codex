---
name: team-review-local
description: Team code review for local changes using Claude and Codex. Agents review independently, leader reconciles until consensus.
argument-hint: "[base-branch]"
---

# Team Review (Local)

Review local changes using Claude and Codex agents.

## Input

Determine the base branch from `$ARGUMENTS`:

- **Branch name** (e.g. `develop`): Use `git diff develop...HEAD`.
- **(empty)**: Default to `git diff main...HEAD`.

## Workflow

1. **Leader (you)**: Get the diff and identify changed files. Determine if any test files were added or modified.
2. Follow the shared workflow in [workflow.md](workflow.md).
