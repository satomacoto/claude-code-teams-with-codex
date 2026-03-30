# claude-code-teams-with-codex

A bridge that uses Claude Code Agent Teams to collaborate with Codex CLI — including multi-model team code reviews.

## Overview

This project connects Codex CLI and Claude Code through an inbox-based team messaging flow. It enables:

- **General-purpose collaboration** — assign any task to Codex as a teammate
- **Multi-model team code reviews** — Claude and Codex reviewers independently review code, cross-validate findings, and iterate to consensus

The repository includes:

- `src/index.ts` — Codex App Server bridge (JSON-RPC + inbox-based team messaging)
- `src/watch-inboxes.ts` — Debug utility for monitoring team inbox activity

## How It Works

The integration is built around a bridge process that connects Claude Code team messaging with a Codex App Server session.

1. Claude Code creates a team with `TeamCreate` and starts the bridge in a `tmux` pane.
2. The bridge launches the Codex App Server as a child process and communicates over JSON-RPC.
3. Team communication uses a file-based inbox protocol at `~/.claude/teams/{team}/inboxes/{name}.json`.
4. The bridge polls its own inbox every 300 ms and detects new messages.
5. When a message arrives, the bridge forwards it to Codex and streams the result.
6. When the task completes, the bridge writes the result back to the team lead's inbox.
7. Shutdown is handled gracefully through `shutdown_request` / `shutdown_response`.

```text
+------------------+        writes message         +-------------------------------+
|   Claude Code    | ---------------------------> | inbox JSON file               |
|  (team lead)     |                              | ~/.claude/teams/{team}/...    |
+------------------+                              +-------------------------------+
                                                           |
                                                           | polled by bridge
                                                           v
                                                  +------------------+
                                                  |      bridge      |
                                                  |   (tmux pane)    |
                                                  +------------------+
                                                           |
                                                           | JSON-RPC
                                                           v
                                                  +------------------+
                                                  | Codex App Server |
                                                  +------------------+
                                                           |
                                                           | result
                                                           v
+------------------+        reads result           +-------------------------------+
|   Claude Code    | <--------------------------- | inbox JSON file               |
|  (team lead)     |                              | ~/.claude/teams/{team}/...    |
+------------------+                              +-------------------------------+
```

## Requirements

- [Claude Code](https://claude.ai/code) (CLI) with Agent Teams enabled (see below)
- [Codex CLI](https://github.com/openai/codex)
- Node.js and `npx`
- `tmux`

## Setup

### 1. Enable Agent Teams in Claude Code

Agent Teams is an [experimental feature](https://docs.anthropic.com/en/docs/claude-code/agent-teams) that is disabled by default. Add the following to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### 2. Clone and install dependencies

```bash
git clone https://github.com/satomacoto/claude-code-teams-with-codex.git
cd claude-code-teams-with-codex
npm install
```

### 3. Install skills (recommended)

Copy the skill definitions into `~/.claude/skills/`:

```bash
# codex-teammate skill
cp -r skills/codex-teammate ~/.claude/skills/

# Team review skills
cp -r skills/team-review-local ~/.claude/skills/
cp -r skills/team-review-pr ~/.claude/skills/
```

Or see [Skill Installation](#skill-installation) below for manual setup.

## Usage

### Basic: Add Codex as a teammate

```
/codex-teammate
```

This creates a team, starts the bridge in a `tmux` pane, and registers Codex as a teammate. Use `SendMessage` to assign tasks.

### Team Code Review

Review local changes or a GitHub PR with a multi-model team of Claude and Codex reviewers:

```
/team-review-local              # review local changes vs main
/team-review-local develop      # review local changes vs develop
/team-review-pr                 # review current branch's PR
/team-review-pr #123            # review PR #123
```

#### How team review works

The review follows a 4-phase pipeline:

1. **Preparation** — The leader analyzes the diff, identifies changed files, finds relevant CLAUDE.md files, and plans the review team.

2. **Parallel review** — All reviewers run simultaneously. Each reviewer focuses on one of 5 core perspectives (always included) plus additional perspectives as needed:

   | Core perspective | Focus |
   |---|---|
   | Conventions | CLAUDE.md compliance |
   | Bug scan | Obvious bugs in changed lines |
   | History context | Git blame, regressions, past patterns |
   | Prior feedback | Comments from previous PRs on these files |
   | Code comments | Compliance with guidance in code comments |

   Additional perspectives (security, error handling, test quality, type design, domain-specific) are added based on the nature of the change. Reviewer count scales with complexity — no artificial cap. At least one Codex reviewer is always included; more are added for larger changes.

3. **Cross-validation** — Each finding is independently scored by at least 2 other reviewers (preferring mixed Claude + Codex). Findings are kept (confidence ≥ 80), dropped (< 50), or marked as contested.

4. **Iterative consensus** — Contested findings go through additional rounds of review until all are resolved or marked as disputed (max 5 rounds).

The final report categorizes issues as Critical / Warning / Disputed with confidence scores, reporter/validator attribution, and concrete fix suggestions.

### Manual startup

1. **Create a team** in Claude Code using `TeamCreate`.

2. **Start the bridge** in a separate terminal (or tmux pane):

   ```bash
   npx tsx src/index.ts --team <team-name> --name <teammate-name> --cwd "$(pwd)"
   ```

3. **Assign tasks** using `SendMessage`:

   ```
   SendMessage(to: "<teammate-name>", message: "Review this code for bugs")
   ```

4. **Shut down** by sending a `shutdown_request` via `SendMessage`, or press `Ctrl+C`.

### Debugging inbox activity

```bash
npx tsx src/watch-inboxes.ts
```

## Skill Installation

Claude Code skills are installed by placing a `SKILL.md` file under `~/.claude/skills/<skill-name>/SKILL.md`.

### codex-teammate

Create `~/.claude/skills/codex-teammate/SKILL.md`:

````markdown
---
name: codex-teammate
description: Add Codex CLI as a teammate to an agent team. Creates the team if needed. Runs App Server bridge in a tmux pane with inbox communication.
argument-hint: "[teammate-name]"
---

Add a Codex CLI teammate via the App Server bridge.

## Parse arguments

- arg1: teammate name (default: `codex-teammate`)

## Steps

1. **Ensure a team exists**:
   - If you already have a team, use that team name.
   - If not, create one with TeamCreate first. Use the returned team name.

2. **Start the bridge** using Bash. Pass the team name:
   ```bash
   CODEX_PANE=$(tmux split-window -h -P -F '#{pane_id}' "npx --prefix <path-to-repo> tsx <path-to-repo>/src/index.ts --team {team-name} --name {teammate-name} --cwd $(pwd); echo '[Bridge exited]'; read")
   echo "$CODEX_PANE"
   ```

3. **Wait 5 seconds** for initialization.

4. **Confirm**: `{teammate-name}` is ready. Use SendMessage to assign tasks.

## Shutdown

1. Send `shutdown_request` via inbox protocol.
2. After `shutdown_approved`, close the pane:
   ```bash
   tmux kill-pane -t {saved-pane-id}
   ```
````

### team-review-local / team-review-pr

See `skills/team-review-local/` and `skills/team-review-pr/` in this repository. Copy them to `~/.claude/skills/`.

> Replace `<path-to-repo>` with the actual absolute path to this repository.

## Directory Structure

```text
.
├── src/
│   ├── index.ts          # Codex App Server bridge
│   └── watch-inboxes.ts  # Inbox debug utility
├── skills/
│   ├── codex-teammate/   # Skill: add Codex as teammate
│   ├── team-review-local/# Skill: team review for local changes
│   └── team-review-pr/   # Skill: team review for GitHub PRs
├── package.json
├── tsconfig.json
└── README.md
```

## Notes

This repository is experimental and intended for prototyping rather than production use. Expect the implementation details and workflow to evolve as the Codex CLI and Claude Code integration model is refined.
