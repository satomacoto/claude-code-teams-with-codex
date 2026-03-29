#!/usr/bin/env python3
"""Watch ~/.claude/teams/ inbox files for changes."""
import json, os, time, sys
from pathlib import Path

TEAMS_DIR = Path.home() / ".claude" / "teams"
LOG_FILE = Path("/tmp/inbox-watch.log")

prev = {}

def scan():
    for inbox in TEAMS_DIR.glob("*/inboxes/*.json"):
        try:
            content = inbox.read_text()
        except Exception:
            continue
        if prev.get(str(inbox)) != content:
            ts = time.strftime("%H:%M:%S")
            label = "NEW" if str(inbox) not in prev else "CHANGED"
            msg = f"[{ts}] {label}: {inbox}\n"
            try:
                parsed = json.dumps(json.loads(content), indent=2, ensure_ascii=False)
            except Exception:
                parsed = content
            msg += parsed + "\n---\n"
            print(msg, flush=True)
            with open(LOG_FILE, "a") as f:
                f.write(msg)
            prev[str(inbox)] = content

print(f"=== Watching {TEAMS_DIR} ===", flush=True)
LOG_FILE.write_text(f"=== Started {time.ctime()} ===\n")

while True:
    scan()
    time.sleep(0.2)
