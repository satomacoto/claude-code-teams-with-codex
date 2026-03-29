#!/usr/bin/env node
/**
 * Codex App Server bridge for Claude Code Agent Teams.
 *
 * Runs in a tmux pane. Watches its inbox file, forwards tasks to
 * Codex App Server, streams output to the terminal, then writes
 * results back to the team-lead inbox.
 *
 * Usage:
 *   npx tsx src/index.ts --team <team> --name <name> [--model <model>] [--cwd <path>]
 */

import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as os from "node:os";
import { EventEmitter } from "node:events";

// ── Config ───────────────────────────────────────────────────────────────────

interface Config {
  team: string;
  name: string;
  model?: string;
  cwd: string;
  turnTimeout: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const cfg: Config = {
    team: "default",
    name: "codex",
    cwd: process.cwd(),
    turnTimeout: 300_000,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--team":         cfg.team        = args[++i]; break;
      case "--name":         cfg.name        = args[++i]; break;
      case "--model":        cfg.model       = args[++i]; break;
      case "--cwd":          cfg.cwd         = args[++i]; break;
      case "--turn-timeout": cfg.turnTimeout = Number(args[++i]); break;
    }
  }
  return cfg;
}

// ── Codex App Server client ──────────────────────────────────────────────────

class CodexServer extends EventEmitter {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private alive = true;

  constructor(cwd: string) {
    super();
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd,
    });
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg["id"];
        if (typeof id === "number" && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (msg["error"]) {
            const err = msg["error"] as Record<string, unknown>;
            reject(new Error(`Codex RPC error ${err["code"]}: ${err["message"]}`));
          } else {
            resolve(msg);
          }
        } else if (typeof msg["method"] === "string") {
          this.emit("notification", msg);
        }
      } catch { /* ignore parse errors */ }
    });
    this.proc.on("exit", (code) => {
      this.alive = false;
      // Reject all pending requests
      for (const [, { reject }] of this.pending) {
        reject(new Error(`Codex App Server exited with code ${code}`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });
  }

  get isAlive() { return this.alive; }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("Codex App Server is not running"));
      const id = this.nextId++;
      this.proc.stdin!.write(JSON.stringify({ method, params, id }) + "\n");
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.alive) return;
    this.proc.stdin!.write(JSON.stringify({ method, params }) + "\n");
  }

  async setup(cwd: string, model?: string): Promise<string> {
    const initRes = await this.request("initialize", {
      clientInfo: { name: "codex-bridge", version: "0.1.0" },
    });
    this.notify("initialized");

    const threadParams: Record<string, unknown> = {
      cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    };
    if (model) threadParams["model"] = model;

    const res = await this.request("thread/start", threadParams);
    const result = res["result"] as Record<string, unknown> | undefined;
    if (!result) throw new Error(`thread/start returned no result: ${JSON.stringify(res)}`);
    const thread = result["thread"] as Record<string, unknown> | undefined;
    if (!thread?.["id"]) throw new Error(`thread/start returned no thread id: ${JSON.stringify(res)}`);
    return thread["id"] as string;
  }

  runTurn(threadId: string, text: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`Turn timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.off("notification", onNotification);
      };

      const onNotification = (msg: Record<string, unknown>) => {
        if (settled) return;
        const method = msg["method"] as string;
        const params = msg["params"] as Record<string, unknown>;

        if (method === "item/agentMessage/delta") {
          const delta = (params["delta"] as string) ?? "";
          process.stdout.write(delta);
          buffer += delta;
        }

        if (method === "item/commandExecution/outputDelta") {
          process.stdout.write((params["delta"] as string) ?? "");
        }

        if (method === "turn/plan/updated") {
          const plan = params["plan"] as Record<string, string>[];
          if (plan) {
            const current = plan.find((s) => s["status"] === "inProgress");
            if (current) process.stdout.write(`\n  >> ${current["step"]}\n`);
          }
        }

        if (method === "turn/completed") {
          settled = true;
          cleanup();
          const turn = params["turn"] as Record<string, unknown>;
          const status = turn["status"] as string;
          if (status === "completed") {
            const items = (turn["items"] as Record<string, unknown>[]) ?? [];
            const agentMsg = items.find((i) => i["type"] === "agentMessage");
            resolve((agentMsg?.["text"] as string) ?? buffer);
          } else {
            const err = turn["error"] as Record<string, string> | null;
            reject(new Error(`Turn ${status}: ${err?.["message"] ?? ""}`));
          }
        }
      };

      this.on("notification", onNotification);
      this.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        approvalPolicy: "never",
      }).catch((err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
    });
  }

  kill() { this.proc.kill(); }
}

// ── Inbox manager ────────────────────────────────────────────────────────────

interface InboxMsg {
  from: string;
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
  read: boolean;
}

class InboxManager {
  private myPath: string;
  private leadPath: string;
  private knownContent = "";
  private sessionStart: string;

  constructor(team: string, name: string) {
    const dir = path.join(os.homedir(), ".claude", "teams", team, "inboxes");
    fs.mkdirSync(dir, { recursive: true });
    this.myPath   = path.join(dir, `${name}.json`);
    this.leadPath = path.join(dir, "team-lead.json");
    this.sessionStart = new Date().toISOString();
    if (!fs.existsSync(this.myPath)) fs.writeFileSync(this.myPath, "[]");
  }

  pollNew(): InboxMsg[] {
    try {
      const raw = fs.readFileSync(this.myPath, "utf8");
      if (raw === this.knownContent) return [];
      this.knownContent = raw;
      return (JSON.parse(raw) as InboxMsg[]).filter(
        (m) => !m.read && m.timestamp >= this.sessionStart
      );
    } catch { return []; }
  }

  markAllRead() {
    try {
      const msgs = JSON.parse(fs.readFileSync(this.myPath, "utf8")) as InboxMsg[];
      const out = JSON.stringify(msgs.map((m) => ({ ...m, read: true })), null, 2);
      fs.writeFileSync(this.myPath, out);
      this.knownContent = out;
    } catch { /* ignore */ }
  }

  sendText(from: string, text: string, summary?: string) {
    this.appendToLead({
      from,
      text,
      summary: summary ?? text.slice(0, 80),
      timestamp: new Date().toISOString(),
      color: "cyan",
      read: false,
    });
  }

  sendTyped(from: string, payload: Record<string, unknown>) {
    this.appendToLead({
      from,
      text: JSON.stringify({ ...payload, from, timestamp: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
      color: "cyan",
      read: false,
    });
  }

  private appendToLead(msg: InboxMsg) {
    // Atomic write via temp file + rename to prevent race conditions
    // when multiple teammates write to team-lead.json simultaneously
    const tmpPath = this.leadPath + `.tmp.${process.pid}.${Date.now()}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let msgs: InboxMsg[] = [];
        try {
          if (fs.existsSync(this.leadPath))
            msgs = JSON.parse(fs.readFileSync(this.leadPath, "utf8")) as InboxMsg[];
        } catch { /* start fresh */ }
        msgs.push(msg);
        fs.writeFileSync(tmpPath, JSON.stringify(msgs, null, 2));
        fs.renameSync(tmpPath, this.leadPath);
        return;
      } catch {
        // Retry on conflict
      }
    }
    // Last resort: direct write
    try { fs.unlinkSync(tmpPath); } catch {}
    let msgs: InboxMsg[] = [];
    try {
      if (fs.existsSync(this.leadPath))
        msgs = JSON.parse(fs.readFileSync(this.leadPath, "utf8")) as InboxMsg[];
    } catch {}
    msgs.push(msg);
    fs.writeFileSync(this.leadPath, JSON.stringify(msgs, null, 2));
  }
}

// ── Team registration ────────────────────────────────────────────────────────

function registerInTeam(team: string, name: string, cwd: string) {
  const configPath = path.join(os.homedir(), ".claude", "teams", team, "config.json");
  if (!fs.existsSync(configPath)) return;

  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const members = (config["members"] ?? []) as Record<string, unknown>[];

  // Remove stale entry if exists, then re-add
  const filtered = members.filter((m) => m["name"] !== name);
  filtered.push({
    agentId: `${name}@${team}`,
    name,
    agentType: "codex-bridge",
    model: "codex",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd,
    subscriptions: [],
  });
  config["members"] = filtered;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function unregisterFromTeam(team: string, name: string) {
  const configPath = path.join(os.homedir(), ".claude", "teams", team, "config.json");
  if (!fs.existsSync(configPath)) return;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const members = (config["members"] ?? []) as Record<string, unknown>[];
    config["members"] = members.filter((m) => m["name"] !== name);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch { /* ignore */ }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs();
  const log = (msg: string) => console.log(`[${cfg.name}] ${msg}`);

  log(`team=${cfg.team}  cwd=${cfg.cwd}`);
  log(`inbox: ~/.claude/teams/${cfg.team}/inboxes/${cfg.name}.json`);

  const inbox = new InboxManager(cfg.team, cfg.name);

  // Register as a team member so SendMessage can reach us
  registerInTeam(cfg.team, cfg.name, cfg.cwd);
  log("Registered in team config");

  // Start Codex App Server (with restart support)
  let codex: CodexServer;
  let threadId: string;

  const startCodex = async (): Promise<void> => {
    log("Starting Codex App Server...");
    codex = new CodexServer(cfg.cwd);
    codex.on("exit", (code) => {
      log(`Codex App Server exited (code=${code}). Restarting in 2s...`);
      setTimeout(async () => {
        try {
          await startCodex();
          log(`Reconnected. thread: ${threadId}`);
        } catch (err) {
          log(`Failed to restart: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      }, 2000);
    });
    threadId = await codex.setup(cfg.cwd, cfg.model);
    log(`thread: ${threadId}  ✓ ready\n`);
  };

  await startCodex();

  const gracefulExit = () => {
    unregisterFromTeam(cfg.team, cfg.name);
    codex.kill();
    process.exit(0);
  };
  process.on("SIGINT",  gracefulExit);
  process.on("SIGTERM", gracefulExit);

  // Poll loop
  while (true) {
    const msgs = inbox.pollNew();

    if (msgs.length > 0) {
      inbox.markAllRead();
    }

    for (const msg of msgs) {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(msg.text) as Record<string, unknown>; } catch { /* plain text */ }

      // shutdown_request
      if (parsed?.["type"] === "shutdown_request") {
        log(`Shutdown requested (reason: ${parsed["reason"] ?? "n/a"})`);
        inbox.sendTyped(cfg.name, {
          type: "shutdown_approved",
          requestId: parsed["requestId"],
          paneId: "tmux",
          backendType: "codex-app-server",
        });
        unregisterFromTeam(cfg.team, cfg.name);
        codex.kill();
        process.exit(0);
      }

      // regular task
      log(`← ${msg.from}: ${msg.text.slice(0, 120)}`);
      process.stdout.write("\n");

      if (!codex.isAlive) {
        log("Codex is not running, skipping task");
        inbox.sendText(cfg.name, "Error: Codex App Server is not running");
        inbox.sendTyped(cfg.name, { type: "idle_notification", idleReason: "error" });
        continue;
      }

      try {
        const result = await codex.runTurn(threadId, msg.text, cfg.turnTimeout);
        process.stdout.write("\n");
        log(`→ sending result to team-lead`);
        inbox.sendText(cfg.name, result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log(`Error: ${message}`);
        inbox.sendText(cfg.name, `Error: ${message}`);
      }

      inbox.sendTyped(cfg.name, { type: "idle_notification", idleReason: "available" });
    }

    await new Promise<void>((r) => setTimeout(r, 300));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
