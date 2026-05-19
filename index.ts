/**
 * fork — Manage subagents as interactive pi sessions in tmux windows.
 *
 * The same extension runs in both parent and child. The `--agent` flag
 * selects mode: present → child running as that named agent; absent →
 * parent that registers plan/implement/review tools and routes
 * subagent results back as tool results.
 *
 * The parent exposes three tools to the LLM: `plan(goal, slug)`,
 * `implement(step)`, `review(step)`. Each tool spawns a child in a new
 * tmux window, awaits the child's result over a Unix socket, and
 * returns the summary as the tool result. The LLM orchestrates the
 * loop.
 *
 * `implement` and `review` error out until a `plan` call has produced
 * step files; the LLM is expected to call `plan` first.
 *
 * Calls are serialized — only one subagent runs at a time.
 *
 * Tasks are written to per-id files under tasks/; the child reads its
 * task via pi's `@<path>` argument syntax. Files are deleted when the
 * child reports completion.
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
const PROMPTS_DIR = path.join(__dirname, "prompts");
const READ_ONLY = ["read", "grep", "find", "ls"];

function socketPathFor(parentSessionId: string): string {
  return path.join(SOCKETS_DIR, `${parentSessionId}.sock`);
}

function planDirFor(slug: string): string {
  return path.join(process.env.FORK_PLANS_DIR ?? "plans", slug);
}

function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf-8");
}

// ── result payload (child → parent over socket) ─────────────────────

interface ResultPayload {
  id: string;
  summary: string;
}

// ── parent state ────────────────────────────────────────────────────

interface ActiveAgent {
  kind: "plan" | "implement" | "review";
  tmuxWindow: string;
  resolve: (summary: string) => void;
  reject: (err: Error) => void;
}

interface ActivePlan {
  slug: string;
  stepCount: number;
}

interface State {
  session: string;
  sessionId: string;
  active: Map<string, ActiveAgent>;
  activePlan: ActivePlan | null;
}

// ── parent: spawn + await child result ─────────────────────────────

function openSubagentWindow(
  state: State,
  opts: {
    kind: ActiveAgent["kind"];
    task: string;
    cwd: string;
    extraArgs?: string[];
  },
): { id: string; tmuxWindow: string } {
  const { kind, task, cwd, extraArgs = [] } = opts;
  const id = `pi-${kind}-${Date.now().toString(36)}`;
  const taskPath = path.join(TASKS_DIR, `${id}.md`);
  fs.writeFileSync(taskPath, task, { mode: 0o600 });
  const cmdArgs = [
    "pi",
    "--agent",
    kind,
    "--subagent-id",
    id,
    "--subagent-socket",
    socketPathFor(state.sessionId),
    ...extraArgs,
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
  return { id, tmuxWindow: win };
}

function awaitChild(
  state: State,
  kind: ActiveAgent["kind"],
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  extraArgs?: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { id, tmuxWindow } = openSubagentWindow(state, {
      kind,
      task,
      cwd,
      extraArgs,
    });
    state.active.set(id, { kind, tmuxWindow, resolve, reject });
    signal?.addEventListener("abort", () => {
      if (!state.active.has(id)) return;
      state.active.delete(id);
      execSync(`tmux kill-window -t ${state.session}:${tmuxWindow}`, {
        encoding: "utf-8",
        timeout: 3000,
      });
      const taskPath = path.join(TASKS_DIR, `${id}.md`);
      if (fs.existsSync(taskPath)) fs.unlinkSync(taskPath);
      reject(new Error("aborted"));
    });
  });
}

function spawnPlan(
  state: State,
  params: { goal: string; slug: string },
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  return awaitChild(state, "plan", params.goal, cwd, signal, [
    "--subagent-plan-slug",
    params.slug,
  ]);
}

function readStepFiles(plan: string, step: number) {
  const padded = String(step).padStart(3, "0");
  const dir = planDirFor(plan);
  const planPath = path.join(dir, "plan.md");
  const stepPath = path.join(dir, `step-${padded}.md`);
  if (!fs.existsSync(planPath))
    throw new Error(`fork: plan file not found: ${planPath}`);
  if (!fs.existsSync(stepPath))
    throw new Error(`fork: step file not found: ${stepPath}`);
  return {
    padded,
    planContent: fs.readFileSync(planPath, "utf-8"),
    stepContent: fs.readFileSync(stepPath, "utf-8"),
  };
}

function spawnImplement(
  state: State,
  params: { plan: string; step: number },
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { padded, planContent, stepContent } = readStepFiles(
    params.plan,
    params.step,
  );
  const task = [
    "# Plan Overview",
    "",
    planContent,
    "",
    `# Step ${padded}`,
    "",
    stepContent,
  ].join("\n");
  return awaitChild(state, "implement", task, cwd, signal);
}

function spawnReview(
  state: State,
  params: { plan: string; step: number },
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { padded, planContent, stepContent } = readStepFiles(
    params.plan,
    params.step,
  );
  const task = [
    `Review the latest commit, which implements step ${padded} of plan "${params.plan}".`,
    "",
    "# Plan Overview",
    "",
    planContent,
    "",
    `# Step ${padded}`,
    "",
    stepContent,
    "",
    "Inspect the diff with `git show HEAD`.",
    "Judge whether the commit meets the step's intent and acceptance.",
  ].join("\n");
  return awaitChild(state, "review", task, cwd, signal);
}

// ── parent: result delivery ────────────────────────────────────────

function deliverResult(state: State, payload: ResultPayload): void {
  const slot = state.active.get(payload.id);
  // Slot may be absent if the child was aborted before its payload landed.
  if (!slot) return;
  state.active.delete(payload.id);
  execSync(`tmux kill-window -t ${state.session}:${slot.tmuxWindow}`, {
    encoding: "utf-8",
    timeout: 3000,
  });
  fs.unlinkSync(path.join(TASKS_DIR, `${payload.id}.md`));
  slot.resolve(payload.summary);
}

// ── role setup ──────────────────────────────────────────────────────

function summaryResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

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
    activePlan: null,
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
        deliverResult(state, JSON.parse(line) as ResultPayload);
      }
    });
  });
  server.listen(sockPath, () => fs.chmodSync(sockPath, 0o600));

  pi.on("session_shutdown", () => {
    server.close();
    fs.unlinkSync(sockPath);
  });

  pi.registerTool({
    name: "plan",
    label: "Plan",
    description:
      "Spawn a planning subagent. Writes plans/<slug>/ and returns a summary.",
    parameters: Type.Object({
      goal: Type.String({ description: "What the plan should accomplish" }),
      slug: Type.String({
        description: "Filename slug; plan is saved to plans/<slug>/",
      }),
    }),
    execute: async (_id, params, signal, _onUpdate, toolCtx) => {
      if (state.active.size > 0)
        throw new Error("fork: another agent is in flight");
      state.activePlan = null;
      const p = params as { goal: string; slug: string };
      const summary = await spawnPlan(state, p, toolCtx.cwd, signal);
      const planDir = planDirFor(p.slug);
      const stepCount = fs.existsSync(planDir)
        ? fs.readdirSync(planDir).filter((f) => f.match(/^step-\d{3}\.md$/))
            .length
        : 0;
      if (stepCount === 0) {
        return summaryResult(
          `${summary}\n\n(No step files written; nothing to implement.)`,
        );
      }
      state.activePlan = { slug: p.slug, stepCount };
      return summaryResult(
        `${summary}\n\nPlan ready: ${stepCount} step${stepCount === 1 ? "" : "s"}. Call implement(1) to begin.`,
      );
    },
  });

  pi.registerTool({
    name: "implement",
    label: "Implement",
    description:
      "Implement one step of the active plan and commit. Errors if no active plan.",
    parameters: Type.Object({
      step: Type.Integer({ minimum: 1, description: "1-based step number" }),
    }),
    execute: async (_id, params, signal, _onUpdate, toolCtx) => {
      if (state.active.size > 0)
        throw new Error("fork: another agent is in flight");
      if (!state.activePlan)
        throw new Error("fork: no active plan; call plan first");
      const { step } = params as { step: number };
      if (step > state.activePlan.stepCount)
        throw new Error(
          `fork: step ${step} out of range; plan has ${state.activePlan.stepCount} steps`,
        );
      const summary = await spawnImplement(
        state,
        { plan: state.activePlan.slug, step },
        toolCtx.cwd,
        signal,
      );
      return summaryResult(summary);
    },
  });

  pi.registerTool({
    name: "review",
    label: "Review",
    description:
      "Review the latest commit against a step's acceptance. Errors if no active plan.",
    parameters: Type.Object({
      step: Type.Integer({ minimum: 1, description: "1-based step number" }),
    }),
    execute: async (_id, params, signal, _onUpdate, toolCtx) => {
      if (state.active.size > 0)
        throw new Error("fork: another agent is in flight");
      if (!state.activePlan)
        throw new Error("fork: no active plan; call plan first");
      const { step } = params as { step: number };
      if (step > state.activePlan.stepCount)
        throw new Error(
          `fork: step ${step} out of range; plan has ${state.activePlan.stepCount} steps`,
        );
      const summary = await spawnReview(
        state,
        { plan: state.activePlan.slug, step },
        toolCtx.cwd,
        signal,
      );
      return summaryResult(summary);
    },
  });
}

function observeCompletion(
  pi: ExtensionAPI,
  id: string,
  socketPath: string,
): void {
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

function setupPlanChild(
  pi: ExtensionAPI,
  id: string,
  socketPath: string,
): void {
  const slug = pi.getFlag("subagent-plan-slug") as string | undefined;
  if (!slug)
    throw new Error(
      "fork: plan agent missing required --subagent-plan-slug flag",
    );

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${loadPrompt("plan")}`,
  }));

  observeCompletion(pi, id, socketPath);

  const planDir = planDirFor(slug);
  let stepCounter = 0;

  pi.registerTool({
    name: "write_plan",
    label: "Write Plan",
    description: "Write the plan overview file. Can only be called once.",
    parameters: Type.Object({
      content: Type.String({
        description: "Plan overview content (markdown)",
      }),
    }),
    async execute(_id, params) {
      if (fs.existsSync(path.join(planDir, "plan.md"))) {
        throw new Error("write_plan already called — plan.md already exists");
      }
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, "plan.md"),
        (params as { content: string }).content,
        { mode: 0o600 },
      );
      return { content: [{ type: "text", text: `Wrote ${planDir}/plan.md` }] };
    },
  });

  pi.registerTool({
    name: "write_step",
    label: "Write Step",
    description: "Write a numbered step file. Auto-numbers starting at 001.",
    parameters: Type.Object({
      content: Type.String({ description: "Step content (markdown)" }),
    }),
    async execute(_id, params) {
      if (!fs.existsSync(planDir)) {
        throw new Error(
          "write_step called before write_plan — plan directory does not exist",
        );
      }
      stepCounter++;
      const padded = String(stepCounter).padStart(3, "0");
      const filename = `step-${padded}.md`;
      fs.writeFileSync(
        path.join(planDir, filename),
        (params as { content: string }).content,
        { mode: 0o600 },
      );
      return {
        content: [{ type: "text", text: `Wrote ${planDir}/${filename}` }],
      };
    },
  });

  pi.setActiveTools([...READ_ONLY, "write_plan", "write_step"]);
}

function setupImplementChild(
  pi: ExtensionAPI,
  id: string,
  socketPath: string,
): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${loadPrompt("implement")}`,
  }));

  observeCompletion(pi, id, socketPath);
}

function setupReviewChild(
  pi: ExtensionAPI,
  id: string,
  socketPath: string,
): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${loadPrompt("review")}`,
  }));

  observeCompletion(pi, id, socketPath);

  pi.setActiveTools([...READ_ONLY, "bash"]);
}

// ── extension entry ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!inTmux()) return;

  pi.registerFlag("agent", {
    description: "Subagent mode: one of plan, implement, review",
    type: "string",
  });
  pi.registerFlag("subagent-id", {
    description: "Subagent id (internal)",
    type: "string",
  });
  pi.registerFlag("subagent-socket", {
    description: "Parent socket path (internal)",
    type: "string",
  });
  pi.registerFlag("subagent-plan-slug", {
    description: "Plan slug for plan agent (internal)",
    type: "string",
  });

  pi.on("session_start", (_event, ctx) => {
    const agentName = pi.getFlag("agent") as string | undefined;
    if (agentName === undefined) {
      setupParent(pi, ctx);
      return;
    }

    const id = pi.getFlag("subagent-id") as string | undefined;
    const socketPath = pi.getFlag("subagent-socket") as string | undefined;
    if (!id)
      throw new Error("fork: subagent missing required --subagent-id flag");
    if (!socketPath)
      throw new Error("fork: subagent missing required --subagent-socket flag");

    switch (agentName) {
      case "plan":
        setupPlanChild(pi, id, socketPath);
        return;
      case "implement":
        setupImplementChild(pi, id, socketPath);
        return;
      case "review":
        setupReviewChild(pi, id, socketPath);
        return;
      default:
        throw new Error(`fork: unknown agent "${agentName}"`);
    }
  });
}
