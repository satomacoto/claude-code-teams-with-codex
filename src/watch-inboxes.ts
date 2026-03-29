import fs from "fs";
import path from "path";
import os from "os";

const TEAMS_DIR = path.join(os.homedir(), ".claude", "teams");
const LOG_FILE = "/tmp/inbox-watch.log";
const POLL_INTERVAL_MS = 200;

type FileState = {
  mtimeMs: number;
};

function timestamp(): string {
  return new Date().toISOString();
}

function logLine(line: string): void {
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
}

function logEvent(kind: "NEW" | "CHANGED", filePath: string, content: string): void {
  const header = `[${timestamp()}] ${kind} ${filePath}`;
  logLine(header);
  logLine(content);
  logLine("");
}

function readJsonPretty(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<< failed to read/parse JSON: ${message} >>`;
  }
}

function listInboxJsonFiles(): string[] {
  const results: string[] = [];

  if (!fs.existsSync(TEAMS_DIR)) {
    return results;
  }

  const teamEntries = fs.readdirSync(TEAMS_DIR, { withFileTypes: true });
  for (const teamEntry of teamEntries) {
    if (!teamEntry.isDirectory()) {
      continue;
    }

    const inboxesDir = path.join(TEAMS_DIR, teamEntry.name, "inboxes");
    if (!fs.existsSync(inboxesDir)) {
      continue;
    }

    const inboxEntries = fs.readdirSync(inboxesDir, { withFileTypes: true });
    for (const inboxEntry of inboxEntries) {
      if (!inboxEntry.isFile() || !inboxEntry.name.endsWith(".json")) {
        continue;
      }
      results.push(path.join(inboxesDir, inboxEntry.name));
    }
  }

  results.sort();
  return results;
}

function main(): void {
  const knownFiles = new Map<string, FileState>();

  logLine(`[${timestamp()}] Watching ${TEAMS_DIR}`);
  logLine(`[${timestamp()}] Logging to ${LOG_FILE}`);
  logLine("");

  const poll = () => {
    let currentFiles: string[] = [];
    try {
      currentFiles = listInboxJsonFiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(`[${timestamp()}] ERROR listing inboxes: ${message}`);
      return;
    }

    const seen = new Set(currentFiles);

    for (const filePath of currentFiles) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      const prev = knownFiles.get(filePath);
      if (!prev) {
        knownFiles.set(filePath, { mtimeMs: stat.mtimeMs });
        logEvent("NEW", filePath, readJsonPretty(filePath));
        continue;
      }

      if (stat.mtimeMs !== prev.mtimeMs) {
        knownFiles.set(filePath, { mtimeMs: stat.mtimeMs });
        logEvent("CHANGED", filePath, readJsonPretty(filePath));
      }
    }

    for (const filePath of Array.from(knownFiles.keys())) {
      if (!seen.has(filePath)) {
        knownFiles.delete(filePath);
      }
    }
  };

  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main();
