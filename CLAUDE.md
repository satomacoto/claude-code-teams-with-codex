# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A bridge that connects Claude Code Agent Teams with OpenAI Codex CLI via the Codex App Server. The bridge runs in a tmux pane, polls a file-based inbox for messages from Claude Code, forwards them to Codex over JSON-RPC, and writes results back.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc -> dist/)
npm run dev          # Run bridge with tsx (development)
npm run start        # Run compiled bridge (node dist/index.js)

# Run the bridge manually
npx tsx src/index.ts --team <team> --name <name> [--model <model>] [--cwd <path>]

# Debug inbox activity
npx tsx src/watch-inboxes.ts
```

There are no tests or linter configured in this project.

## Architecture

The system has three layers:

1. **Claude Code (team lead)** - Creates a team via `TeamCreate`, sends tasks via `SendMessage` to the bridge's inbox file.
2. **Bridge (`src/index.ts`)** - A long-running Node.js process that:
   - Registers itself in the team config at `~/.claude/teams/{team}/config.json`
   - Polls its inbox file (`~/.claude/teams/{team}/inboxes/{name}.json`) every 300ms
   - Spawns `codex app-server` as a child process and communicates over JSON-RPC (stdin/stdout)
   - Manages Codex session lifecycle: `initialize` -> `thread/start` -> `turn/start` per task
   - Writes results back to `~/.claude/teams/{team}/inboxes/team-lead.json`
   - Handles `shutdown_request` messages for graceful teardown
   - Auto-restarts Codex App Server on crash
3. **Codex App Server** - OpenAI's agent runtime, spawned with `approvalPolicy: "never"` and `sandbox: "workspace-write"`

Key classes in `src/index.ts`:
- `CodexServer` - JSON-RPC client wrapping the `codex app-server` child process
- `InboxManager` - File-based message queue using atomic write (tmp + rename) for concurrency safety

`src/watch-inboxes.ts` is a standalone debug utility that polls `~/.claude/teams/*/inboxes/*.json` for changes and logs them.

## Prerequisites

- Claude Code with Agent Teams enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json`)
- Codex CLI installed (`codex` command available)
- `tmux` for running the bridge in a split pane
