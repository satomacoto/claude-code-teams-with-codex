# codex-claude-code

An experimental repository for exploring multi-agent workflows between Codex CLI and Claude Code.

## Overview

This project is a lightweight integration sandbox for connecting Codex CLI and Claude Code through an inbox-based team messaging flow.

The repository currently includes:

- `bridge/` - A TypeScript Codex App Server bridge that communicates with Codex over JSON-RPC and integrates with Claude Code's inbox-based team messaging
- `watch-inboxes.py` - Optional debugging utility for monitoring team inbox activity

## Requirements

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
python3 watch-inboxes.py
```

## Directory Structure

```text
.
├── .claude/
│   └── settings.local.json
├── .gitignore
├── bridge/
│   ├── src/
│   │   └── index.ts
│   ├── package.json
│   ├── package-lock.json
│   └── tsconfig.json
├── watch-inboxes.py
└── README.md
```

## Notes

This repository is experimental and intended for prototyping rather than production use. Expect the implementation details and workflow to evolve as the Codex CLI and Claude Code integration model is refined.
