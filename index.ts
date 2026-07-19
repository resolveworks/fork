/**
 * fork — Spawn pi subagents in separate tmux windows.
 *
 * The parent registers `spawn_agent`, `message_agent`, and `close_agent`
 * tools. Calling spawn_agent opens a new tmux window running pi with the
 * given task and returns immediately. The child reports results through `report_result`;
 * each report is delivered over a Unix socket as a notification that triggers
 * a new parent turn. The child stays alive after reporting: the parent
 * reviews the report, sends revision requests with message_agent, and closes
 * the child with close_agent.
 *
 * Configure the subagent model via ~/.pi/agent/fork.json (global) or
 * .pi/fork.json (project, overrides global). Any field is optional:
 *   { "model": "glm-5.2", "provider": "zai", "thinking": "high" }
 * Fork passes these settings to the child pi process as CLI flags, so pi
 * resolves them using its normal startup rules.
 *
 * Requires: run pi inside tmux.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── tmux ────────────────────────────────────────────────────────────

function inTmux(): boolean {
  return !!process.env.TMUX;
}

/** Run tmux synchronously with argv passed directly (no shell), so paths and
 * arguments with spaces/metacharacters are never shell-interpreted. */
function tmuxSync(args: string[], timeout = 3000): string {
  const result = spawnSync("tmux", args, { encoding: "utf-8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    const detail = [result.stderr.trim(), result.stdout.trim()]
      .filter(Boolean)
      .join(" / ");
    const where =
      result.signal !== null
        ? `signal ${result.signal}`
        : `exit ${result.status ?? "?"}`;
    throw new Error(
      `fork: tmux ${args[0]} failed (${where})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function tmuxSession(): string {
  return tmuxSync(["display-message", "-p", "#S"]).trim();
}

// ── paths ───────────────────────────────────────────────────────────

const ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "fork");
const SOCKETS_DIR = path.join(ROOT, "sockets");
const AGENTS_DIR = path.join(ROOT, "agents");
const TASKS_DIR = path.join(ROOT, "tasks");
const RESULT_TYPE = "fork-result";
const MESSAGE_TYPE = "fork-message";

function socketPathFor(sessionId: string): string {
  return path.join(SOCKETS_DIR, `${sessionId}.sock`);
}

function agentSocketPathFor(id: string): string {
  return path.join(AGENTS_DIR, `${id}.sock`);
}

function taskPathFor(id: string): string {
  return path.join(TASKS_DIR, `${id}.md`);
}

/** Exact lowercase format emitted by randomUUID(); also blocks path traversal. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── wire protocol (newline-delimited JSON) ──────────────────────────

/** Child → parent, over the parent's session socket. */
interface ResultPayload {
  id: string;
  summary: string;
}

/** Parent → child, over the child's agent socket. */
type AgentMessage = { type: "message"; text: string } | { type: "close" };

// ── config (~/.pi/agent/fork.json, .pi/fork.json) ───────────────────

interface ForkConfig {
  /** Model id or pattern (supports `provider/id` and `:thinking`). */
  model?: string;
  provider?: string;
  /** Thinking level passed to the child via `--thinking`. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

function readConfig(file: string): ForkConfig {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ForkConfig;
  } catch (err) {
    console.error(`fork: failed to load ${file}: ${err}`);
    return {};
  }
}

/** Merge global + project config. Project wins; only read if trusted. */
function loadConfig(cwd: string, projectTrusted: boolean): ForkConfig {
  const globalCfg = readConfig(path.join(getAgentDir(), "fork.json"));
  const projectCfg = projectTrusted
    ? readConfig(path.join(cwd, CONFIG_DIR_NAME, "fork.json"))
    : {};
  return { ...globalCfg, ...projectCfg };
}

// ── spawn (fire-and-forget) ─────────────────────────────────────────

function spawn(
  session: string,
  sessionId: string,
  id: string,
  taskPath: string,
  cwd: string,
  config: ForkConfig,
): void {
  // argv passed directly; tmux runs a multi-arg command without `sh -c`, so
  // no shell quoting is needed. Let pi resolve model settings itself.
  const cmdArgs = [
    "pi",
    "--subagent-socket",
    socketPathFor(sessionId),
    "--subagent-id",
    id,
  ];
  if (config.provider) cmdArgs.push("--provider", config.provider);
  if (config.model) cmdArgs.push("--model", config.model);
  if (config.thinking) cmdArgs.push("--thinking", config.thinking);
  cmdArgs.push(`@${taskPath}`);

  tmuxSync([
    "new-window",
    "-t",
    `${session}:`,
    "-n",
    id,
    "-c",
    cwd,
    ...cmdArgs,
  ]);
}

// ── line servers and socket writes ──────────────────────────────────

/** Remove a file, tolerating an already-missing path. Never throws —
 * callers (spawn rollback, socket teardown) must keep working. */
function safeUnlink(filePath: string, what: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error(`fork: could not remove ${what} ${filePath}: ${err}`);
  }
}

/**
 * Listen on sockPath and invoke onLine per newline-delimited payload. A
 * stale socket file from a previous run is removed first. Server errors
 * (e.g. unable to bind) are logged, not thrown: the session keeps running
 * and the peer reports connection failures on its side. Mode 0o600 is
 * enforced once listening starts.
 */
function serveLines(
  sockPath: string,
  what: string,
  onLine: (line: string) => void,
): net.Server {
  safeUnlink(sockPath, `stale ${what}`);
  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf-8");
    socket.on("error", (err) => {
      console.error(`fork: ${what} connection error: ${err}`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        onLine(line);
      }
    });
  });
  server.on("error", (err) => {
    console.error(`fork: ${what} error: ${err}`);
  });
  server.listen(sockPath, () => {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch (err) {
      console.error(`fork: could not chmod ${what} ${sockPath}: ${err}`);
    }
  });
  return server;
}

function teardownServer(server: net.Server, sockPath: string, what: string) {
  // close() with a callback absorbs ERR_SERVER_NOT_RUNNING instead of
  // emitting an unhandled 'error'.
  server.close((err) => {
    if (
      err &&
      (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
    ) {
      console.error(`fork: error closing ${what}: ${err}`);
    }
  });
  safeUnlink(sockPath, what);
}

/** Deliver one message to a live agent. Throws when the agent is unreachable
 * or the write does not flush; callers report failure and keep their state. */
function sendToAgent(id: string, message: AgentMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = net.connect(agentSocketPathFor(id));
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve();
      }
    };
    socket.setTimeout(5000);
    socket.once("error", (err) => finish(err));
    socket.once("timeout", () =>
      finish(new Error("timed out after 5 seconds")),
    );
    socket.end(`${JSON.stringify(message)}\n`, () => finish());
  });
}

// ── result delivery ─────────────────────────────────────────────────

function deliverResult(pi: ExtensionAPI, payload: ResultPayload): void {
  const summary = payload.summary.trim() || "(no output)";
  pi.sendMessage(
    {
      customType: RESULT_TYPE,
      content: `Subagent ${payload.id} reported:\n\n${summary}`,
      display: true,
    },
    { triggerTurn: true },
  );
}

/**
 * Parse and act on one newline-delimited result line. Malformed JSON or shape
 * is logged and ignored without aborting the handler or dropping later lines.
 * A result is delivered only while its agent is still open (task file present).
 */
function processResultLine(pi: ExtensionAPI, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    console.error(
      `fork: ignoring malformed result line (invalid JSON): ${err}`,
    );
    return;
  }

  const candidate = parsed as Partial<ResultPayload>;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.summary !== "string"
  ) {
    console.error(`fork: ignoring malformed result payload: ${line}`);
    return;
  }

  const { id, summary } = candidate as ResultPayload;
  if (!UUID_V4.test(id)) {
    console.error(
      `fork: ignoring result with invalid subagent id (not a UUID v4): ${id}`,
    );
    return;
  }

  if (!fs.existsSync(taskPathFor(id))) {
    console.error(`fork: ignoring result for unknown or closed id ${id}`);
    return;
  }

  deliverResult(pi, { id, summary });
}

// ── parent setup ────────────────────────────────────────────────────

/** Validate an agent id and that the agent is still open (task file present). */
function assertOpenAgent(id: string): void {
  if (!UUID_V4.test(id)) {
    throw new Error(`Invalid subagent id (not a UUID v4): ${id}`);
  }
  if (!fs.existsSync(taskPathFor(id))) {
    throw new Error(`Unknown or already closed subagent ${id}`);
  }
}

function setupParent(
  pi: ExtensionAPI,
  ctx: { sessionManager: { getSessionId: () => string } },
): void {
  fs.mkdirSync(SOCKETS_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  const session = tmuxSession();
  const sessionId = ctx.sessionManager.getSessionId();
  const sockPath = socketPathFor(sessionId);

  // Task files are authoritative, so running children survive extension reloads.
  const server = serveLines(sockPath, "result socket", (line) =>
    processResultLine(pi, line),
  );

  pi.on("session_shutdown", () => {
    teardownServer(server, sockPath, "result socket");
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Delegate a self-contained task to a subagent: a fresh pi session in a " +
      "new tmux window, sharing your working tree. Use for independent work " +
      "that benefits from isolated context; do simple, sequential, or " +
      "context-dependent work yourself. The subagent sees the task plus " +
      "normal project context (AGENTS.md, files), but not this conversation, " +
      "so include needed context in the task. Avoid concurrent tasks that " +
      "edit the same files. Returns immediately; the report arrives later as " +
      "a message. Then request revisions with message_agent or close it with " +
      "close_agent.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "Self-contained instructions passed verbatim as the subagent's initial " +
          "prompt. Include the goal, needed conversation-specific context, " +
          "constraints, relevant paths or symbols, prior findings or errors, and " +
          "the expected output. Do not reference context it cannot see or repeat " +
          "project instructions from AGENTS.md.",
      }),
    }),
    execute: async (_id, params, _signal, _onUpdate, toolCtx) => {
      const { task } = params as { task: string };
      const id = randomUUID();
      const taskPath = taskPathFor(id);
      fs.writeFileSync(taskPath, task, { mode: 0o600 });
      try {
        const config = loadConfig(toolCtx.cwd, toolCtx.isProjectTrusted());
        spawn(session, sessionId, id, taskPath, toolCtx.cwd, config);
      } catch (err) {
        // Roll back exactly this id's task file so pi reports the spawn error.
        safeUnlink(taskPath, `task file for ${id}`);
        throw err;
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Spawned subagent ${id} in ${toolCtx.cwd}. ` +
              "Do not poll it; continue other work or end your response. Its " +
              "report will arrive in a new turn, after which it stays alive " +
              "awaiting your verdict.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "message_agent",
    label: "Message Agent",
    description:
      "Send a revision request or follow-up instruction to a live subagent. " +
      "It receives your text as a new turn, acts on it, and reports again. " +
      "Use after reviewing its report when changes are needed; use " +
      "close_agent when the work is accepted. The next report arrives as a " +
      "message — do not poll.",
    parameters: Type.Object({
      id: Type.String({
        description: "The subagent's UUID, from its spawn result or report.",
      }),
      text: Type.String({
        description: "The feedback or instruction for the subagent.",
      }),
    }),
    execute: async (_toolId, params) => {
      const { id, text } = params as { id: string; text: string };
      assertOpenAgent(id);
      try {
        await sendToAgent(id, { type: "message", text });
      } catch (err) {
        throw new Error(
          `Could not reach subagent ${id}: ${err}. It may still be starting ` +
            "(retry shortly) or may have exited; if it stays unreachable, " +
            "clean up its tmux window and task file manually.",
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Message delivered to subagent ${id}. It will act on it and may ` +
              "report again; do not poll.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description:
      "Shut down a live subagent's session without spending a model turn. " +
      "Use to accept its report or to stop one you no longer need. Subagents " +
      "stay alive until closed; close every subagent when you are done with it.",
    parameters: Type.Object({
      id: Type.String({
        description: "The subagent's UUID, from its spawn result or report.",
      }),
    }),
    execute: async (_toolId, params) => {
      const { id } = params as { id: string };
      assertOpenAgent(id);
      try {
        await sendToAgent(id, { type: "close" });
      } catch (err) {
        throw new Error(
          `Could not reach subagent ${id}: ${err}. It may still be starting ` +
            "(retry shortly); if its tmux window is already gone, clean up " +
            "its task file manually.",
        );
      }
      safeUnlink(taskPathFor(id), `task file for ${id}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Subagent ${id} received the close message and is shutting down.`,
          },
        ],
        details: {},
      };
    },
  });
}

// ── child setup ─────────────────────────────────────────────────────

const SUBAGENT_SYSTEM_PROMPT =
  "You are a subagent executing one task delegated by a parent pi session. " +
  "You see the task prompt and pi's normal project context, but not the " +
  "parent's conversation. You share the parent's working tree, so your edits " +
  "are immediately visible. Focus only on the delegated task. Report with " +
  "report_result when you believe it is done, then end your turn and wait: " +
  "the session stays alive while the parent reviews. The parent may send " +
  "revision requests as ordinary messages — act on them and report again — " +
  "and closes the session when the work is accepted. Only report_result " +
  "reaches the parent; interactive replies stay local. If the user asks for " +
  "current findings, call report_result even when the task is incomplete.";

/**
 * Parse and act on one newline-delimited parent message. Malformed JSON or
 * shape is logged and ignored without aborting the handler or dropping later
 * lines.
 */
function processAgentLine(
  pi: ExtensionAPI,
  ctx: { shutdown: () => void },
  line: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    console.error(`fork: ignoring malformed agent line (invalid JSON): ${err}`);
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error(`fork: ignoring malformed agent message: ${line}`);
    return;
  }
  const candidate = parsed as { type?: unknown; text?: unknown };

  if (candidate.type === "message" && typeof candidate.text === "string") {
    // followUp: let a busy child finish its current work before the verdict.
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: `Message from parent:\n\n${candidate.text}`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return;
  }

  if (candidate.type === "close") {
    // Approval: shut down mechanically, no model turn spent on it.
    ctx.shutdown();
    return;
  }

  console.error(`fork: ignoring malformed agent message: ${line}`);
}

function setupChild(
  pi: ExtensionAPI,
  ctx: { shutdown: () => void },
  socketPath: string,
  subagentId: string,
): void {
  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${SUBAGENT_SYSTEM_PROMPT}`,
    };
  });

  // ── result reporting (child → parent) ──────────────────────────────
  //
  // Delivery failures are reported to the model, which retries with the same
  // result. Failures are unambiguous in practice: they mean the parent is
  // gone or the write failed, so a retry cannot deliver a report twice.
  let reportState: "open" | "sending" = "open";

  pi.registerTool({
    name: "report_result",
    label: "Report Result",
    description:
      "Send a result report to the parent. Use when the task is done, when " +
      "reporting a requested revision, or when the user asks for current " +
      "findings. Report outcomes, not progress updates.",
    parameters: Type.Object({
      result: Type.String({
        description:
          "The complete result for the parent. Include the outcome and, when " +
          "relevant, edits, verification, and blockers.",
      }),
    }),
    execute: async (_id, params, _signal, _onUpdate, toolCtx) => {
      if (reportState !== "open") {
        throw new Error("report_result is already delivering a report");
      }
      reportState = "sending";

      const { result } = params as { result: string };
      const payload = `${JSON.stringify({ id: subagentId, summary: result })}\n`;

      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const socket = net.connect(socketPath);
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (err) {
              socket.destroy();
              reject(err);
            } else {
              resolve();
            }
          };

          socket.setTimeout(5000);
          socket.once("error", (err) => finish(err));
          socket.once("timeout", () =>
            finish(new Error("timed out after 5 seconds")),
          );
          socket.end(payload, () => finish());
        });
      } catch (err) {
        reportState = "open";
        const message = `fork: could not deliver result to parent: ${err}`;
        console.error(message);
        toolCtx.ui.notify(
          `${message}. The report was not sent; retry report_result with the same result.`,
          "error",
        );
        throw new Error(
          "Result delivery failed; the report was not sent. Retry " +
            "report_result with the same result.",
        );
      }

      reportState = "open";
      return {
        content: [
          {
            type: "text" as const,
            text: "Report delivered. End your turn and await the parent's verdict.",
          },
        ],
        details: {},
      };
    },
  });

  // ── verdict channel (parent → child) ─────────────────────────────────

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const agentSockPath = agentSocketPathFor(subagentId);
  const server = serveLines(agentSockPath, "agent socket", (line) =>
    processAgentLine(pi, ctx, line),
  );

  pi.on("session_shutdown", () => {
    teardownServer(server, agentSockPath, "agent socket");
  });
}

// ── extension entry ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!inTmux()) return;

  pi.registerFlag("subagent-socket", {
    description: "Parent socket path (internal)",
    type: "string",
  });

  pi.registerFlag("subagent-id", {
    description: "Subagent ID for result routing (internal)",
    type: "string",
  });

  pi.on("session_start", (_event, ctx) => {
    const socketPath = pi.getFlag("subagent-socket") as string | undefined;

    if (socketPath === undefined) {
      // Parent mode
      setupParent(pi, ctx);
      return;
    }

    // Child mode
    const subagentId = pi.getFlag("subagent-id") as string;
    setupChild(pi, ctx, socketPath, subagentId);
  });
}
