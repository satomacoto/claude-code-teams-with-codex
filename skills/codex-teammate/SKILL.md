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

2. **Start the bridge** using Bash. Pass the team name. Replace `{cwd}` with the actual working directory path:
   ```bash
   tmux split-window -h -P -F '#{pane_id}' "npx --prefix <path-to-repo> tsx <path-to-repo>/src/index.ts --team {team-name} --name {teammate-name} --cwd {cwd}; echo '[Bridge exited]'; read" > /tmp/codex-pane-{teammate-name} && sleep 5 && cat /tmp/codex-pane-{teammate-name}
   ```

4. **Confirm**: `{teammate-name}` is ready. Use SendMessage to assign tasks.

## Mid-turn control

While a task is running, you can send control messages via SendMessage:

- **Steer** (add context / follow-up to the active turn):
  ```json
  { "type": "steer_request", "text": "Also check the error handling path" }
  ```
- **Interrupt** (cancel the active turn):
  ```json
  { "type": "interrupt_request" }
  ```

Steer resets the turn timeout (default 30 min). Regular messages are queued as new tasks.

## Shutdown

1. Send `shutdown_request` via inbox protocol.
2. After `shutdown_approved`, close the pane (pane id is in `/tmp/codex-pane-{teammate-name}`):
   ```bash
   tmux kill-pane -t $(cat /tmp/codex-pane-{teammate-name})
   ```
