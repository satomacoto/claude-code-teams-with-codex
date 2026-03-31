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
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_MAX_QUEUE_SIZE = 25;

interface Config {
  team: string;
  name: string;
  model?: string;
  cwd: string;
  turnTimeout: number;
  maxQueueSize: number;
  brokerEndpoint?: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const cfg: Config = {
    team: "default",
    name: "codex",
    cwd: process.cwd(),
    turnTimeout: 1_800_000,
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--team":             cfg.team            = args[++i]; break;
      case "--name":             cfg.name            = args[++i]; break;
      case "--model":            cfg.model           = args[++i]; break;
      case "--cwd":              cfg.cwd             = args[++i]; break;
      case "--turn-timeout":     cfg.turnTimeout     = Number(args[++i]); break;
      case "--max-queue-size":   cfg.maxQueueSize    = Number(args[++i]); break;
      case "--broker-endpoint":  cfg.brokerEndpoint  = args[++i]; break;
    }
  }
  return cfg;
}

// ── Broker discovery ────────────────────────────────────────────────────────

function resolveStateDir(cwd: string): string {
  const pluginDataDir = process.env["CLAUDE_PLUGIN_DATA"];
  let canonicalCwd = cwd;
  try { canonicalCwd = fs.realpathSync(cwd); } catch { /* use original */ }
  const slug = (path.basename(canonicalCwd) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = crypto.createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 16);
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : path.join(os.tmpdir(), "codex-companion");
  return path.join(stateRoot, `${slug}-${hash}`);
}

function discoverBrokerEndpoint(cwd: string): string | null {
  const stateDir = resolveStateDir(cwd);
  const brokerFile = path.join(stateDir, "broker.json");
  if (!fs.existsSync(brokerFile)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(brokerFile, "utf8")) as Record<string, unknown>;
    return (session["endpoint"] as string) ?? null;
  } catch { return null; }
}

function parseBrokerEndpoint(endpoint: string): string {
  if (endpoint.startsWith("unix:")) return endpoint.slice(5);
  if (endpoint.startsWith("pipe:")) return endpoint.slice(5);
  return endpoint;
}

// ── Codex App Server client ──────────────────────────────────────────────────

abstract class CodexServer extends EventEmitter {
  protected nextId = 0;
  protected pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  protected alive = true;
  public transport: "direct" | "broker" = "direct";

  get isAlive() { return this.alive; }

  protected handleLine(line: string) {
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
  }

  protected handleExit(code: number | null) {
    if (!this.alive) return;
    this.alive = false;
    for (const [, { reject }] of this.pending) {
      reject(new Error(`Codex App Server exited with code ${code}`));
    }
    this.pending.clear();
    this.emit("exit", code);
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("Codex App Server is not running"));
      const id = this.nextId++;
      this.sendMessage({ method, params, id });
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.alive) return;
    this.sendMessage({ method, params });
  }

  protected abstract sendMessage(msg: Record<string, unknown>): void;
  abstract kill(): void;

  async setup(cwd: string, model?: string): Promise<string> {
    await this.request("initialize", {
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

  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimeoutMs = 0;
  private turnTimedOut: (() => void) | null = null;

  resetTurnTimeout() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.turnTimedOut) {
      this.turnTimer = setTimeout(this.turnTimedOut, this.turnTimeoutMs);
    }
  }

  runTurn(threadId: string, text: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;

      this.turnTimeoutMs = timeoutMs;
      this.turnTimedOut = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`Turn timed out after ${timeoutMs / 1000}s`));
        }
      };
      this.turnTimer = setTimeout(this.turnTimedOut, timeoutMs);

      const cleanup = () => {
        if (this.turnTimer) clearTimeout(this.turnTimer);
        this.turnTimer = null;
        this.turnTimedOut = null;
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

  steer(threadId: string, text: string) {
    return this.request("turn/steer", {
      threadId,
      input: [{ type: "text", text }],
    });
  }

  interrupt(threadId: string) {
    return this.request("turn/interrupt", { threadId });
  }
}

// ── Direct (stdin/stdout) client ────────────────────────────────────────────

class SpawnedCodexServer extends CodexServer {
  private proc: ChildProcess;
  private rl: readline.Interface;

  constructor(cwd: string) {
    super();
    this.transport = "direct";
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd,
    });
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));
    this.proc.on("exit", (code) => this.handleExit(code));
  }

  protected sendMessage(msg: Record<string, unknown>) {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  kill() { this.proc.kill(); }
}

// ── Broker (Unix socket) client ─────────────────────────────────────────────

class BrokerCodexServer extends CodexServer {
  private socket: net.Socket;
  private lineBuffer = "";

  constructor(socketPath: string) {
    super();
    this.transport = "broker";
    this.socket = net.createConnection({ path: socketPath });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.lineBuffer += chunk;
      let idx = this.lineBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.lineBuffer.slice(0, idx);
        this.lineBuffer = this.lineBuffer.slice(idx + 1);
        this.handleLine(line);
        idx = this.lineBuffer.indexOf("\n");
      }
    });
    this.socket.on("close", () => this.handleExit(null));
    this.socket.on("error", (err) => {
      console.error(`[broker] Socket error: ${err instanceof Error ? err.message : err}`);
      this.handleExit(null);
    });
  }

  protected sendMessage(msg: Record<string, unknown>) {
    if (this.socket.destroyed) return;
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  kill() { this.socket.end(); }
}

// ── Factory ─────────────────────────────────────────────────────────────────

function createCodexServer(cfg: Config): CodexServer {
  const endpoint = cfg.brokerEndpoint
    ?? process.env["CODEX_COMPANION_APP_SERVER_ENDPOINT"]
    ?? discoverBrokerEndpoint(cfg.cwd);

  if (endpoint) {
    const socketPath = parseBrokerEndpoint(endpoint);
    return new BrokerCodexServer(socketPath);
  }
  return new SpawnedCodexServer(cfg.cwd);
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
  // Track acked messages in memory to avoid writing back to the inbox file,
  // which eliminates read-modify-write races with concurrent inbox writers.
  private ackedTuples = new Map<string, number>();

  constructor(team: string, name: string) {
    const dir = path.join(os.homedir(), ".claude", "teams", team, "inboxes");
    fs.mkdirSync(dir, { recursive: true });
    this.myPath   = path.join(dir, `${name}.json`);
    this.leadPath = path.join(dir, "team-lead.json");
    this.sessionStart = new Date().toISOString();
    if (!fs.existsSync(this.myPath)) fs.writeFileSync(this.myPath, "[]");
  }

  private static tupleKey(m: InboxMsg): string {
    return `${m.from}|${m.timestamp}|${m.text}`;
  }

  pollNew(): InboxMsg[] {
    try {
      const raw = fs.readFileSync(this.myPath, "utf8");
      if (raw === this.knownContent) return [];
      this.knownContent = raw;
      const all = (JSON.parse(raw) as InboxMsg[]).filter(
        (m) => !m.read && m.timestamp >= this.sessionStart
      );
      // Filter out messages already acked in memory
      const result: InboxMsg[] = [];
      const tempCounts = new Map(this.ackedTuples);
      for (const m of all) {
        const key = InboxManager.tupleKey(m);
        const remaining = tempCounts.get(key) ?? 0;
        if (remaining > 0) {
          tempCounts.set(key, remaining - 1);
        } else {
          result.push(m);
        }
      }
      return result;
    } catch { return []; }
  }

  ackMessages(msgs: InboxMsg[]) {
    for (const m of msgs) {
      const key = InboxManager.tupleKey(m);
      this.ackedTuples.set(key, (this.ackedTuples.get(key) ?? 0) + 1);
    }
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

// ── Task queue ───────────────────────────────────────────────────────────────

interface QueueItem {
  taskId: string;
  msg: InboxMsg;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs();
  const log = (msg: string) => console.log(`[${cfg.name}] ${msg}`);
  const isBrokerBusyError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes("Codex RPC error -32001:");
  };
  const isBrokerDisconnectError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith("Codex App Server exited with code");
  };

  log(`team=${cfg.team}  cwd=${cfg.cwd}  maxQueue=${cfg.maxQueueSize}`);
  log(`inbox: ~/.claude/teams/${cfg.team}/inboxes/${cfg.name}.json`);

  const inbox = new InboxManager(cfg.team, cfg.name);

  // Register as a team member so SendMessage can reach us
  registerInTeam(cfg.team, cfg.name, cfg.cwd);
  log("Registered in team config");

  // Start Codex App Server (with restart support)
  let codex: CodexServer;
  let threadId: string;

  let brokerFailed = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const intentionallyStoppedServers = new WeakSet<CodexServer>();

  const clearRestartTimer = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const startCodex = async (): Promise<void> => {
    log("Starting Codex App Server...");
    if (brokerFailed) {
      // Force direct spawn after broker failure
      codex = new SpawnedCodexServer(cfg.cwd);
    } else {
      codex = createCodexServer(cfg);
    }
    const server = codex;
    const currentTransport = server.transport;
    server.on("exit", (code) => {
      isTurnRunning = false;
      if (intentionallyStoppedServers.has(server)) return;
      if (currentTransport === "broker") {
        log(`Broker disconnected (code=${code}). Falling back to direct spawn in 2s...`);
        brokerFailed = true;
      } else {
        log(`Codex App Server exited (code=${code}). Restarting in 2s...`);
      }
      clearRestartTimer();
      restartTimer = setTimeout(async () => {
        restartTimer = null;
        try {
          await startCodex();
          log(`Reconnected. thread: ${threadId}  transport: ${codex.transport}`);
        } catch (err) {
          log(`Failed to restart: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      }, 2000);
    });
    threadId = await server.setup(cfg.cwd, cfg.model);
    log(`thread: ${threadId}  transport: ${server.transport}  ✓ ready\n`);
  };

  const fallbackToDirectSpawn = async (reason: string) => {
    log(`${reason}. Falling back to direct spawn...`);
    brokerFailed = true;
    clearRestartTimer();
    intentionallyStoppedServers.add(codex);
    codex.kill();
    await startCodex();
  };

  const withBrokerBusyFallback = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (codex.transport !== "broker" || (!isBrokerBusyError(err) && !isBrokerDisconnectError(err))) throw err;
      const message = err instanceof Error ? err.message : String(err);
      await fallbackToDirectSpawn(`Broker unavailable at runtime (${message})`);
      return action();
    }
  };

  try {
    await startCodex();
  } catch (err) {
    if (codex!.transport === "broker") {
      clearRestartTimer();
      const message = err instanceof Error ? err.message : String(err);
      await fallbackToDirectSpawn(`Broker setup failed: ${message}`);
    } else {
      throw err;
    }
  }

  const gracefulExit = () => {
    unregisterFromTeam(cfg.team, cfg.name);
    codex.kill();
    process.exit(0);
  };
  process.on("SIGINT",  gracefulExit);
  process.on("SIGTERM", gracefulExit);

  // ── Queue state ──────────────────────────────────────────────────────────

  const queue: QueueItem[] = [];
  let nextTaskId = 1;
  let isProcessing = false;
  let currentTaskId: string | null = null;
  let isTurnRunning = false;

  function genTaskId(): string {
    return `task-${nextTaskId++}`;
  }

  // ── Processor ────────────────────────────────────────────────────────────

  async function maybeStartProcessing(): Promise<void> {
    if (isProcessing) return;
    isProcessing = true;

    try {
      while (queue.length > 0) {
        const item = queue.shift()!;
        const { taskId, msg } = item;
        currentTaskId = taskId;

        log(`← ${msg.from}: ${msg.text.slice(0, 120)}`);
        process.stdout.write("\n");

        inbox.sendTyped(cfg.name, {
          type: "processing_notification",
          taskId,
        });

        if (!codex.isAlive) {
          log("Codex is not running, skipping task");
          inbox.sendText(cfg.name, `Error: Codex App Server is not running (${taskId})`);
          continue;
        }

        try {
          isTurnRunning = true;
          const result = await withBrokerBusyFallback(() => codex.runTurn(threadId, msg.text, cfg.turnTimeout));
          isTurnRunning = false;
          process.stdout.write("\n");
          log(`→ sending result to team-lead (${taskId})`);
          inbox.sendText(cfg.name, result);
        } catch (err: unknown) {
          isTurnRunning = false;
          const message = err instanceof Error ? err.message : String(err);
          log(`Error (${taskId}): ${message}`);
          inbox.sendText(cfg.name, `Error: ${message}`);
        }
      }
    } finally {
      currentTaskId = null;
      isProcessing = false;
      const idleReason = codex.isAlive ? "available" : "error";
      inbox.sendTyped(cfg.name, { type: "idle_notification", idleReason });
    }
  }

  // ── Intake (poll loop) ───────────────────────────────────────────────────

  function pollAndEnqueue(): void {
    const msgs = inbox.pollNew();
    if (msgs.length === 0) return;

    const toAck: InboxMsg[] = [];

    for (const msg of msgs) {
      // Check for shutdown_request — handle out-of-band, bypass queue
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(msg.text) as Record<string, unknown>; } catch { /* plain text */ }

      if (parsed?.["type"] === "shutdown_request") {
        log(`Shutdown requested (reason: ${parsed["reason"] ?? "n/a"})`);
        // Notify team-lead about the currently processing task and any queued tasks
        if (currentTaskId) {
          inbox.sendText(cfg.name, `Error: task ${currentTaskId} interrupted by shutdown`);
        }
        for (const item of queue) {
          inbox.sendText(cfg.name, `Error: task ${item.taskId} interrupted by shutdown`);
        }
        toAck.push(msg);
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

      // If a turn is currently running, handle control messages (steer/interrupt)
      if (isTurnRunning && codex.isAlive && parsed?.["type"]) {
        if (parsed["type"] === "interrupt_request") {
          log(`⚡ Interrupt requested by ${msg.from} during ${currentTaskId}`);
          codex.interrupt(threadId).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log(`Interrupt error: ${message}`);
            inbox.sendText(cfg.name, `Error: interrupt failed for ${currentTaskId}: ${message}`);
          });
          toAck.push(msg);
          continue;
        }

        if (parsed["type"] === "steer_request") {
          const steerText = (parsed["text"] as string) ?? msg.text;
          log(`↪ Steering active turn (${currentTaskId}) with message from ${msg.from}`);
          codex.steer(threadId, steerText).then(() => {
            codex.resetTurnTimeout();
            log(`⏱ Turn timeout reset (${cfg.turnTimeout / 1000}s)`);
          }).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log(`Steer error: ${message}`);
            inbox.sendText(cfg.name, `Error: steer failed for ${currentTaskId}: ${message}`);
          });
          toAck.push(msg);
          continue;
        }
      }

      // Check queue capacity (count active task + queued items)
      const totalInFlight = queue.length + (isProcessing ? 1 : 0);
      if (totalInFlight >= cfg.maxQueueSize) {
        log(`Queue full (${totalInFlight}/${cfg.maxQueueSize}), rejecting message`);
        inbox.sendText(cfg.name, `Error: queue full (${totalInFlight}/${cfg.maxQueueSize}), task rejected`);
        inbox.sendTyped(cfg.name, {
          type: "queue_full_notification",
          totalInFlight,
          maxQueueSize: cfg.maxQueueSize,
        });
        toAck.push(msg);
        continue;
      }

      // Enqueue task
      const taskId = genTaskId();
      queue.push({ taskId, msg });
      toAck.push(msg);

      inbox.sendTyped(cfg.name, {
        type: "queued_notification",
        taskId,
        queuePosition: queue.length, // 1-based
        queueLength: queue.length,
        summary: msg.text.slice(0, 80),
      });

      log(`Queued ${taskId} (position ${queue.length}/${cfg.maxQueueSize})`);
    }

    inbox.ackMessages(toAck);

    // Kick processor if not already running
    maybeStartProcessing().catch((err) => {
      log(`Processor error: ${err instanceof Error ? err.message : err}`);
    });
  }

  // Start intake timer
  setInterval(pollAndEnqueue, 300);
  log("Intake loop started (300ms interval)");
}

main().catch((err) => { console.error(err); process.exit(1); });
