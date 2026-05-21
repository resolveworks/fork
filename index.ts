/**
 * fork — Spawn pi subagents in separate tmux windows.
 *
 * The parent registers a single `spawn` tool. Calling it opens a new
 * tmux window running pi with the given task and returns immediately.
 * When the child finishes, its final assistant message is sent back
 * over a Unix socket and delivered as a notification that triggers a
 * new turn.
 *
 * Requires: run pi inside tmux.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── tmux ────────────────────────────────────────────────────────────

function inTmux(): boolean {
  return !!process.env.TMUX;
}

function tmuxSession(): string {
  return execSync("tmux display-message -p '#S'", {
    encoding: "utf-8",
    timeout: 3000,
  }).trim();
}

// ── paths ───────────────────────────────────────────────────────────

const ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "fork");
const SOCKETS_DIR = path.join(ROOT, "sockets");
const TASKS_DIR = path.join(ROOT, "tasks");
const RESULT_TYPE = "fork-result";

function socketPathFor(sessionId: string): string {
  return path.join(SOCKETS_DIR, `${sessionId}.sock`);
}

// ── result payload (child → parent over socket) ─────────────────────

interface ResultPayload {
  id: string;
  summary: string;
}

// ── parent state ────────────────────────────────────────────────────

interface ActiveChild {
  tmuxWindow: string;
}

interface State {
  session: string;
  sessionId: string;
  active: Map<string, ActiveChild>;
}

// ── spawn (fire-and-forget) ─────────────────────────────────────────

function spawn(
  state: State,
  task: string,
  cwd: string,
): { id: string; tmuxWindow: string } {
  const id = `pi-${Date.now().toString(36)}`;
  const taskPath = path.join(TASKS_DIR, `${id}.md`);
  fs.writeFileSync(taskPath, task, { mode: 0o600 });

  const cmdArgs = [
    "pi",
    "--subagent-id",
    id,
    "--subagent-socket",
    socketPathFor(state.sessionId),
    `@${taskPath}`,
  ];

  const win = execSync(
    `tmux new-window -t ${state.session}: -n ${id} -c ${cwd} -P -F '#I' '${cmdArgs.join(" ")}'`,
    { encoding: "utf-8", timeout: 3000 },
  ).trim();

  execSync(`tmux set-option -t ${state.session}:${win} -w remain-on-exit off`, {
    encoding: "utf-8",
    timeout: 3000,
  });

  state.active.set(id, { tmuxWindow: win });
  return { id, tmuxWindow: win };
}

// ── result delivery ─────────────────────────────────────────────────

function deliverResult(
  pi: ExtensionAPI,
  state: State,
  payload: ResultPayload,
): void {
  const slot = state.active.get(payload.id);
  if (!slot) return; // aborted before result landed
  state.active.delete(payload.id);
  execSync(`tmux kill-window -t ${state.session}:${slot.tmuxWindow}`, {
    encoding: "utf-8",
    timeout: 3000,
  });
  fs.unlinkSync(path.join(TASKS_DIR, `${payload.id}.md`));

  pi.sendMessage(
    {
      customType: RESULT_TYPE,
      content: payload.summary || "(no output)",
      display: true,
    },
    { triggerTurn: true },
  );
}

// ── parent setup ────────────────────────────────────────────────────

function setupParent(
  pi: ExtensionAPI,
  ctx: { sessionManager: { getSessionId: () => string } },
): void {
  fs.mkdirSync(SOCKETS_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  const state: State = {
    session: tmuxSession(),
    sessionId: ctx.sessionManager.getSessionId(),
    active: new Map(),
  };
  const sockPath = socketPathFor(state.sessionId);

  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        deliverResult(pi, state, JSON.parse(line) as ResultPayload);
      }
    });
  });
  server.listen(sockPath, () => fs.chmodSync(sockPath, 0o600));

  pi.on("session_shutdown", () => {
    server.close();
    fs.unlinkSync(sockPath);
  });

  pi.registerTool({
    name: "spawn",
    label: "Spawn",
    description:
      "Spawn a pi subagent in a new tmux window. Returns immediately. " +
      "The subagent's final output is delivered as a notification when it finishes, " +
      "triggering a new turn with the results.",
    parameters: Type.Object({
      task: Type.String({ description: "Task description for the subagent" }),
    }),
    execute: async (_id, params, _signal, _onUpdate, toolCtx) => {
      const { task } = params as { task: string };
      const { tmuxWindow } = spawn(state, task, toolCtx.cwd);
      return {
        content: [
          {
            type: "text" as const,
            text: `Spawned subagent in tmux window ${tmuxWindow}. Results will be delivered when done.`,
          },
        ],
      };
    },
  });
}

// ── child setup ─────────────────────────────────────────────────────

function setupChild(pi: ExtensionAPI, id: string, socketPath: string): void {
  pi.on("agent_end", (event, ctx) => {
    const last = [...event.messages]
      .reverse()
      .find((m) => m.role === "assistant") as
      | { role: "assistant"; content: any[]; stopReason?: string }
      | undefined;

    if (!last || last.stopReason !== "stop" || ctx.hasPendingMessages()) return;

    const summary = (last.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const socket = net.connect(socketPath);
    socket.on("error", (err) => {
      throw err;
    });
    socket.end(`${JSON.stringify({ id, summary })}\n`, () => ctx.shutdown());
  });
}

// ── extension entry ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!inTmux()) return;

  pi.registerFlag("subagent-id", {
    description: "Subagent id (internal)",
    type: "string",
  });
  pi.registerFlag("subagent-socket", {
    description: "Parent socket path (internal)",
    type: "string",
  });

  pi.on("session_start", (_event, ctx) => {
    const id = pi.getFlag("subagent-id") as string | undefined;

    if (id === undefined) {
      // Parent mode
      setupParent(pi, ctx);
      return;
    }

    // Child mode
    const socketPath = pi.getFlag("subagent-socket") as string | undefined;
    if (!socketPath)
      throw new Error("fork: subagent missing required --subagent-socket flag");
    setupChild(pi, id, socketPath);
  });
}
