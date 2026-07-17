/**
 * fork — Spawn pi subagents in separate tmux windows.
 *
 * The parent registers a single `spawn` tool. Calling it opens a new
 * tmux window running pi with the given task and returns immediately.
 * When the child completes its task, it explicitly sends its result through
 * a terminal tool. The result is delivered over a Unix socket as a
 * notification that triggers a new parent turn.
 *
 * Configure the subagent model via ~/.pi/agent/fork.json (global) or
 * .pi/fork.json (project, overrides global). Any field is optional:
 *   { "model": "glm-5.2", "provider": "zai", "thinking": "high" }
 * The child reads this itself and applies the model through the model
 * registry, using the same resolution rules as `pi --model`.
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
  type ExtensionContext,
  getAgentDir,
  resolveCliModel,
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
const TASKS_DIR = path.join(ROOT, "tasks");
const RESULT_TYPE = "fork-result";

function socketPathFor(sessionId: string): string {
  return path.join(SOCKETS_DIR, `${sessionId}.sock`);
}

function taskPathFor(id: string): string {
  return path.join(TASKS_DIR, `${id}.md`);
}

/** Exact lowercase format emitted by randomUUID(); also blocks path traversal. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── result payload (child → parent over socket) ─────────────────────

interface ResultPayload {
  id: string;
  summary: string;
}

// ── config (~/.pi/agent/fork.json, .pi/fork.json) ───────────────────

interface ForkConfig {
  /** Model id or pattern (supports `provider/id` and `:thinking`). */
  model?: string;
  provider?: string;
  /** Thinking level applied via setThinkingLevel. */
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
): void {
  // argv passed directly; tmux runs a multi-arg command without `sh -c`, so
  // no shell quoting is needed.
  const cmdArgs = [
    "pi",
    "--subagent-socket",
    socketPathFor(sessionId),
    "--subagent-id",
    id,
    `@${taskPath}`,
  ];

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

// ── result delivery ─────────────────────────────────────────────────

function deliverResult(pi: ExtensionAPI, payload: ResultPayload): void {
  const summary = payload.summary.trim() || "(no output)";
  pi.sendMessage(
    {
      customType: RESULT_TYPE,
      content: `Subagent ${payload.id} finished:\n\n${summary}`,
      display: true,
    },
    { triggerTurn: true },
  );
}

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
 * Parse and act on one newline-delimited result line. Malformed JSON or shape
 * is logged and ignored without aborting the handler or dropping later lines.
 * Removing the validated id's task file atomically claims the result, so only
 * the first result for a pending task is delivered.
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

  const id = candidate.id;
  if (!UUID_V4.test(id)) {
    console.error(
      `fork: ignoring result with invalid subagent id (not a UUID v4): ${id}`,
    );
    return;
  }

  // Unlink is both the pending check and atomic claim; do not check existence first.
  try {
    fs.unlinkSync(taskPathFor(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        `fork: ignoring result for unknown or already-delivered id ${id}`,
      );
    } else {
      console.error(`fork: could not claim task file for ${id}: ${err}`);
    }
    return;
  }

  deliverResult(pi, { id, summary: candidate.summary });
}

// ── parent setup ────────────────────────────────────────────────────

function setupParent(
  pi: ExtensionAPI,
  ctx: { sessionManager: { getSessionId: () => string } },
): void {
  fs.mkdirSync(SOCKETS_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  const session = tmuxSession();
  const sessionId = ctx.sessionManager.getSessionId();
  const sockPath = socketPathFor(sessionId);

  // Remove a stale socket left by a previous (crashed/killed) run.
  safeUnlink(sockPath, "stale socket");

  // Task files are authoritative, so running children survive extension reloads.
  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf-8");
    socket.on("error", (err) => {
      console.error(`fork: result socket connection error: ${err}`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        processResultLine(pi, line);
      }
    });
  });

  // A server 'error' (e.g. unable to bind) is logged, not thrown: the parent
  // keeps running; children fail to connect and report that themselves.
  // Mode 0o600 is enforced once listening starts.
  server.on("error", (err) => {
    console.error(`fork: result socket error: ${err}`);
  });
  server.listen(sockPath, () => {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch (err) {
      console.error(`fork: could not chmod socket ${sockPath}: ${err}`);
    }
  });

  pi.on("session_shutdown", () => {
    // close() with a callback absorbs ERR_SERVER_NOT_RUNNING instead of
    // emitting an unhandled 'error'.
    server.close((err) => {
      if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
        console.error(`fork: error closing result socket server: ${err}`);
      }
    });
    safeUnlink(sockPath, "result socket");
  });

  pi.registerTool({
    name: "spawn",
    label: "Spawn",
    description:
      "Delegate an independent task to a fresh pi session in a new tmux window. " +
      "The call returns immediately; do not wait or poll. The subagent sees the " +
      "task and normal project context, including AGENTS.md, but not this " +
      "conversation or prior tool results. It shares the working tree, so avoid " +
      "concurrent tasks that edit the same files. Its result arrives as a new " +
      "message that triggers a new turn.",
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
        spawn(session, sessionId, id, taskPath, toolCtx.cwd);
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
              "result will arrive in a new turn.",
          },
        ],
      };
    },
  });
}

// ── child setup ─────────────────────────────────────────────────────

const SUBAGENT_SYSTEM_PROMPT =
  "You are a subagent working on one task delegated by a parent pi session. " +
  "The task prompt is your only parent-conversation context; also follow the " +
  "project context loaded by pi. You share the parent's working tree, so your " +
  "edits are immediately visible. Focus only on the delegated task. When it is " +
  "complete, call complete_task with the result for the parent and make it your " +
  "final tool call. Interactive replies and interruptions stay local and do not " +
  "complete the task. If the user explicitly asks you to return current findings, " +
  "call complete_task even if the task is incomplete.";

async function setupChild(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  socketPath: string,
  subagentId: string,
): Promise<void> {
  // The child resolves the configured model through the model registry —
  // same rules as `pi --model` — so the parent never forwards flags.
  const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
  if (config.model) {
    const result = resolveCliModel({
      cliProvider: config.provider,
      cliModel: config.model,
      modelRegistry: ctx.modelRegistry,
    });
    if (result.model) {
      const ok = await pi.setModel(result.model);
      if (!ok) {
        ctx.ui.notify(
          `fork: no API key for subagent model ${config.provider ? `${config.provider}/` : ""}${config.model}`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `fork: could not resolve subagent model: ${result.error ?? result.warning ?? "not found"}`,
        "warning",
      );
    }
    const thinking = config.thinking ?? result.thinkingLevel;
    if (thinking) pi.setThinkingLevel(thinking);
  } else if (config.thinking) {
    pi.setThinkingLevel(config.thinking);
  }

  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${SUBAGENT_SYSTEM_PROMPT}`,
    };
  });

  // ── terminal result delivery (child → parent) ──────────────────────
  //
  // A successful local socket flush is the protocol's delivery boundary; the
  // existing protocol has no application-level acknowledgement. A timeout or
  // socket error can therefore be ambiguous. We let the model retry after any
  // failed attempt: the parent's atomic task-file claim makes retransmission
  // idempotent and guarantees that at most one result reaches the parent. Once
  // an attempt flushes successfully, this child permanently rejects duplicates.
  let completionState: "open" | "sending" | "complete" = "open";

  pi.registerTool({
    name: "complete_task",
    label: "Complete Task",
    description:
      "Return the delegated task's result to the parent and end this child " +
      "session. Use only when the task is complete or the user explicitly asks " +
      "to return current findings; make this the final tool call. Interactive " +
      "replies and progress updates stay local. If delivery fails, the task " +
      "remains open; retry with the same result.",
    parameters: Type.Object({
      result: Type.String({
        description:
          "The complete result for the parent. Include the outcome and, when " +
          "relevant, edits, verification, and blockers.",
      }),
    }),
    execute: async (_id, params, _signal, _onUpdate, toolCtx) => {
      if (completionState !== "open") {
        throw new Error(
          completionState === "sending"
            ? "complete_task is already delivering a result"
            : "complete_task already completed this task",
        );
      }
      completionState = "sending";

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
        completionState = "open";
        const message = `fork: could not deliver result to parent: ${err}`;
        console.error(message);
        toolCtx.ui.notify(
          `${message}. The task remains open; retry complete_task with the same result.`,
          "error",
        );
        throw new Error(
          "Result delivery failed; the task remains open. Retry complete_task " +
            "with the same result.",
        );
      }

      completionState = "complete";
      toolCtx.shutdown();
      return {
        content: [
          {
            type: "text" as const,
            text: "Result delivered to parent; closing this child session.",
          },
        ],
        details: {},
        terminate: true,
      };
    },
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

  pi.on("session_start", async (_event, ctx) => {
    const socketPath = pi.getFlag("subagent-socket") as string | undefined;

    if (socketPath === undefined) {
      // Parent mode
      setupParent(pi, ctx);
      return;
    }

    // Child mode
    const subagentId = pi.getFlag("subagent-id") as string;
    await setupChild(pi, ctx, socketPath, subagentId);
  });
}
