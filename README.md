# claude-code-teams-with-codex

A bridge that uses Claude Code Agent Teams to collaborate with Codex CLI.

## Overview

This project is a lightweight integration sandbox for connecting Codex CLI and Claude Code through an inbox-based team messaging flow.

The repository currently includes:

- `src/index.ts` - A TypeScript Codex App Server bridge that communicates with Codex over JSON-RPC and integrates with Claude Code's inbox-based team messaging
- `src/watch-inboxes.ts` - Optional debugging utility for monitoring team inbox activity

## How It Works

The integration is built around a small bridge process that connects Claude Code team messaging with a Codex App Server session.

1. Claude Code creates a team with `TeamCreate` and starts the bridge in a `tmux` pane.
2. The bridge launches the Codex App Server as a child process and communicates with it over JSON-RPC.
3. Team communication uses a file-based inbox protocol at `~/.claude/teams/{team}/inboxes/{name}.json`.
4. The bridge polls its own inbox every 300 ms and detects new messages.
5. When a message arrives, the bridge forwards it to the Codex App Server and streams the result.
6. When the task completes, the bridge writes the result back to the team lead's inbox.
7. Shutdown is handled gracefully through the `shutdown_request` / `shutdown_response` protocol.

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

## Usage

There are two ways to use the bridge: with a Claude Code skill (recommended) or manually.

### Option A: With the `/codex-teammate` skill

Install the skill first (see [Skill Installation](#skill-installation) below), then run in Claude Code:

```
/codex-teammate
```

This automatically creates a team, starts the bridge in a `tmux` pane, and registers it as a teammate. You can then use `SendMessage` to assign tasks.

### Option B: Manual startup

1. **Create a team** in Claude Code using `TeamCreate`.

2. **Start the bridge** in a separate terminal (or tmux pane):

   ```bash
   npx tsx src/index.ts --team <team-name> --name <teammate-name> --cwd "$(pwd)"
   ```

   The bridge automatically registers itself in the team config, so Claude Code can communicate with it via `SendMessage`.

3. **Assign tasks** in Claude Code using `SendMessage`:

   ```
   SendMessage(to: "<teammate-name>", message: "Review this code for bugs")
   ```

4. **Shut down** the bridge by sending a `shutdown_request` via `SendMessage`, or press `Ctrl+C` in the terminal.

### Debugging inbox activity

```bash
npx tsx src/watch-inboxes.ts
```

## Skill Installation

Claude Code skills are installed by placing a `SKILL.md` file under `~/.claude/skills/<skill-name>/SKILL.md`. This step is optional but recommended for convenience.

Create `~/.claude/skills/codex-teammate/SKILL.md` with the following content:

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

> Replace `<path-to-repo>` with the actual absolute path to this repository.

## Directory Structure

```text
.
├── .claude/
│   └── settings.local.json
├── .gitignore
├── src/
│   ├── index.ts
│   └── watch-inboxes.ts
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## Notes

This repository is experimental and intended for prototyping rather than production use. Expect the implementation details and workflow to evolve as the Codex CLI and Claude Code integration model is refined.
