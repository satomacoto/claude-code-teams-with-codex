# codex-claude-code

An experimental repository for exploring multi-agent workflows between Codex CLI and Claude Code.

## Overview

This project is a lightweight integration sandbox for connecting Codex CLI and Claude Code through an inbox-based team messaging flow.

The repository currently includes:

- `bridge/` - A TypeScript Codex App Server bridge that communicates with Codex over JSON-RPC and integrates with Claude Code's inbox-based team messaging
- `bridge/src/watch-inboxes.ts` - Optional debugging utility for monitoring team inbox activity

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

- [Claude Code](https://claude.ai/code) (CLI)
- [Codex CLI](https://github.com/openai/codex)
- Node.js and `npx`
- `tmux`

## Setup

```bash
git clone https://github.com/satomacoto/codex-claude-code.git
cd codex-claude-code
cd bridge
npm install
```

## Usage

### As a Claude Code teammate

Use the `/codex-teammate` skill in Claude Code to start the bridge in a `tmux` pane and register it as a team member automatically.

### Manual startup

From the repository root:

```bash
npx --prefix bridge tsx bridge/src/index.ts --team <team-name> --name <teammate-name> --cwd "$(pwd)"
```

### Debugging inbox activity

```bash
npx --prefix bridge tsx bridge/src/watch-inboxes.ts
```

## Claude Code Skills

Claude Code skills can be installed by placing a `SKILL.md` file under:

```text
~/.claude/skills/<skill-name>/SKILL.md
```

Example for `/codex-teammate`:

Path: `~/.claude/skills/codex-teammate/SKILL.md`

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
   CODEX_PANE=$(tmux split-window -h -P -F '#{pane_id}' "npx --prefix <path-to-repo>/bridge tsx <path-to-repo>/bridge/src/index.ts --team {team-name} --name {teammate-name} --cwd $(pwd); echo '[Bridge exited]'; read")
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
├── bridge/
│   ├── src/
│   │   ├── index.ts
│   │   └── watch-inboxes.ts
│   ├── package.json
│   ├── package-lock.json
│   └── tsconfig.json
└── README.md
```

## Notes

This repository is experimental and intended for prototyping rather than production use. Expect the implementation details and workflow to evolve as the Codex CLI and Claude Code integration model is refined.
