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
