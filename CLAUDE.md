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
npx tsx src/index.ts --team <team> --name <name> [--model <model>] [--cwd <path>] [--broker-endpoint <endpoint>]

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
   - Manages Codex session lifecycle: `initialize` -> `thread/start` -> `turn/start` per task (with `turn/steer` and `turn/interrupt` for mid-turn control)
   - Supports two transport modes: direct spawn (`codex app-server` via stdin/stdout) or broker connection (Unix socket via `codex-plugin-cc` broker)
   - Auto-discovers broker via `CODEX_COMPANION_APP_SERVER_ENDPOINT` env var or `broker.json` in the plugin state directory, falls back to direct spawn
   - **Note**: When using broker mode, if the broker is unreachable or busy (`-32001`), the bridge automatically falls back to direct spawn. Multiple bridges sharing one broker must take turns for broker-mediated requests.
   - Supports `steer_request` messages to add context to a running turn (resets the 30-min turn timeout) and `interrupt_request` to cancel
   - Writes results back to `~/.claude/teams/{team}/inboxes/team-lead.json`
   - Handles `shutdown_request` messages for graceful teardown
   - Auto-restarts Codex App Server on crash
3. **Codex App Server** - OpenAI's agent runtime, spawned with `approvalPolicy: "never"` and `sandbox: "workspace-write"`

Key classes in `src/index.ts`:
- `CodexServer` (abstract) - Base JSON-RPC client with shared protocol logic
- `SpawnedCodexServer` - Direct transport, spawns `codex app-server` as child process (stdin/stdout)
- `BrokerCodexServer` - Broker transport, connects to existing app-server via Unix socket (codex-plugin-cc broker)
- `createCodexServer()` - Factory that auto-discovers broker or falls back to direct spawn
- `InboxManager` - File-based message queue using atomic write (tmp + rename) for concurrency safety

`src/watch-inboxes.ts` is a standalone debug utility that polls `~/.claude/teams/*/inboxes/*.json` for changes and logs them.

## Prerequisites

- Claude Code with Agent Teams enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json`)
- Codex CLI installed (`codex` command available)
- `tmux` for running the bridge in a split pane
