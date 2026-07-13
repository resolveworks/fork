/**
 * fork — Spawn pi subagents in separate tmux windows.
 *
 * The parent registers a single `spawn` tool. Calling it opens a new
 * tmux window running pi with the given task and returns immediately.
 * When the child finishes, its final assistant message is sent back
 * over a Unix socket and delivered as a notification that triggers a
 * new turn.
 *
 * Configure the subagent model via ~/.pi/agent/fork.json (global) or
 * .pi/fork.json (project, overrides global). Any field is optional:
 *   { "model": "glm-5.2", "provider": "zai", "thinking": "high" }
 * The child reads this itself and applies the model through the model
 * registry, using the same resolution rules as `pi --model`.
 *
 * Requires: run pi inside tmux.
 */

import { execSync } from "node:child_process";
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
  summary: string;
}

// ── config (~/.pi/agent/fork.json, .pi/fork.json) ───────────────────

interface ForkConfig {
  /** Model id or pattern (supports `provider/id` and `:thinking`). */
  model?: string;
  /** Provider name, e.g. "anthropic" or "zai". */
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

/**
 * Seed the global fork.json with the current model so the plugin is useful
 * out of the box. Only writes if the file does not yet exist; never overwrites
 * a user's config.
 */
function seedConfig(model: { provider: string; id: string }): void {
  const file = path.join(getAgentDir(), "fork.json");
  if (fs.existsSync(file)) return;
  const seeded: ForkConfig = { provider: model.provider, model: model.id };
  try {
    fs.writeFileSync(file, `${JSON.stringify(seeded, null, 2)}\n`);
    console.error(
      `fork: created ${file} with ${seeded.provider}/${seeded.model}`,
    );
  } catch (err) {
    console.error(`fork: failed to create ${file}: ${err}`);
  }
}

// ── spawn (fire-and-forget) ─────────────────────────────────────────

function spawn(
  session: string,
  sessionId: string,
  taskPath: string,
  cwd: string,
): void {
  const id = path.basename(taskPath, ".md");
  const cmdArgs = [
    "pi",
    "--subagent-socket",
    socketPathFor(sessionId),
    `@${taskPath}`,
  ];

  execSync(
    `tmux new-window -t ${session}: -n ${id} -c ${cwd} '${cmdArgs.join(" ")}'`,
    { encoding: "utf-8", timeout: 3000 },
  );
}

// ── result delivery ─────────────────────────────────────────────────

function deliverResult(
  pi: ExtensionAPI,
  payload: ResultPayload,
  taskPath: string,
): void {
  if (taskPath) fs.unlinkSync(taskPath);

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
  ctx: {
    sessionManager: { getSessionId: () => string };
    model: { provider: string; id: string } | undefined;
  },
): void {
  fs.mkdirSync(SOCKETS_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  // First run: seed ~/.pi/agent/fork.json with the current model so the
  // plugin works out of the box. Never overwrites an existing file.
  if (ctx.model) seedConfig(ctx.model);

  const session = tmuxSession();
  const sessionId = ctx.sessionManager.getSessionId();
  const sockPath = socketPathFor(sessionId);

  // Remove stale socket from a previous (crashed/killed) run.
  if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);

  // Track task files so we can clean them up when results arrive.
  const taskFiles: string[] = [];

  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        const taskPath = taskFiles.shift() ?? "";
        deliverResult(pi, JSON.parse(line) as ResultPayload, taskPath);
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
      "Spawn a pi subagent in a new tmux window. Returns immediately " +
      "(asynchronous); the subagent runs as a fresh pi session and cannot see " +
      "this conversation, your reasoning, or prior tool results. It starts in the " +
      "current working directory and shares the same filesystem — it is not an " +
      "isolated copy, so its edits are live. Concurrent subagents may finish in " +
      "any order; do not assign overlapping file edits to concurrent subagents, " +
      "as they can conflict. When it finishes, only the subagent's final textual " +
      "response is delivered asynchronously into your context.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "Complete, self-contained instructions for the subagent. The subagent " +
          "cannot see this conversation, so include everything it needs: goal, " +
          "relevant context and constraints, exact file paths, and the expected " +
          "output. The task is passed directly to the subagent as its initial prompt.",
      }),
    }),
    execute: async (_id, params, _signal, _onUpdate, toolCtx) => {
      const { task } = params as { task: string };
      const id = `pi-${Date.now().toString(36)}`;
      const taskPath = path.join(TASKS_DIR, `${id}.md`);
      fs.writeFileSync(taskPath, task, { mode: 0o600 });
      taskFiles.push(taskPath);
      spawn(session, sessionId, taskPath, toolCtx.cwd);
      return {
        content: [
          {
            type: "text" as const,
            text: task,
          },
        ],
      };
    },
  });
}

// ── child setup ─────────────────────────────────────────────────────

const SUBAGENT_SYSTEM_PROMPT =
  "You are a subagent spawned by a parent pi process. " +
  "You do not share the parent's conversation, reasoning, or tool results — " +
  "work only from the task you were given. You run in the parent's working " +
  "tree (the same filesystem), so your edits are live. " +
  "Focus exclusively on the assigned task; do not spawn subagents or delegate work. " +
  "When you are done, end your response with a clear summary. Only the text of " +
  "your final message is sent back to the parent.";

async function setupChild(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  socketPath: string,
): Promise<void> {
  // Apply the configured subagent model. The child resolves it through the
  // model registry — same rules as `pi --model` (provider/id, :thinking,
  // fuzzy matching) — so the parent never has to forward flags.
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
      systemPrompt: event.systemPrompt + "\n\n" + SUBAGENT_SYSTEM_PROMPT,
    };
  });

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
    socket.end(`${JSON.stringify({ summary })}\n`, () => ctx.shutdown());
  });
}

// ── extension entry ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!inTmux()) return;

  pi.registerFlag("subagent-socket", {
    description: "Parent socket path (internal)",
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
    await setupChild(pi, ctx, socketPath);
  });
}
