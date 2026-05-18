/**
 * fork — Manage subagents as interactive pi sessions in tmux windows.
 *
 * The same extension runs in both parent and child. The `--agent` flag
 * selects mode: present → child running as that named agent; absent →
 * parent that registers the `plan` tool and watches for results.
 *
 * Children run as separate `pi` processes in new tmux windows. The
 * parent's tool call returns immediately; results arrive over a Unix
 * domain socket and are delivered as `fork-result` notifications that
 * trigger a new turn. Each child has its own completion tool:
 * `implement` (plan child), `commit` (implement child), `review`
 * (review child).
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
const RESULT_TYPE = "fork-result";

function socketPathFor(parentSessionId: string): string {
	return path.join(SOCKETS_DIR, `${parentSessionId}.sock`);
}

function planDirFor(slug: string): string {
	return path.join(process.env.FORK_PLANS_DIR ?? "plans", slug);
}

// ── result payloads (child → parent over socket) ────────────────────

interface ResultPayload {
	id: string;
}

interface ReviewResultPayload extends ResultPayload {
	verdict: "pass" | "changes-needed";
}

// ── parent state ────────────────────────────────────────────────────

type ActiveAgent =
	| {
			kind: "plan";
			params: { goal: string; slug: string };
			tmuxWindow: string;
			cwd: string;
	  }
	| {
			kind: "implement";
			params: { plan: string; step: number };
			tmuxWindow: string;
			cwd: string;
	  }
	| {
			kind: "review";
			params: { plan: string; step: number };
			tmuxWindow: string;
			cwd: string;
	  };

interface Pipeline {
	slug: string;
	totalSteps: number;
	currentStep: number;
	cwd: string;
}

interface State {
	session: string;
	sessionId: string;
	active: Map<string, ActiveAgent>;
	pipeline: Pipeline | null;
}

const PROMPTS_DIR = path.join(__dirname, "prompts");

const READ_ONLY = ["read", "grep", "find", "ls"];

// ── parent: spawn primitive + per-kind helpers ─────────────────────

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
		`tmux new-window -t ${state.session} -n ${id} -c ${cwd} -P -F '#I' '${cmdArgs.join(" ")}'`,
		{ encoding: "utf-8", timeout: 3000 },
	).trim();
	execSync(`tmux set-option -t ${state.session}:${win} -w remain-on-exit off`, {
		encoding: "utf-8",
		timeout: 3000,
	});
	return { id, tmuxWindow: win };
}

function spawned(kind: string, tmuxWindow: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: `Spawned ${kind} in tmux window ${tmuxWindow}. Result will be delivered when done.`,
			},
		],
	};
}

function spawnPlan(
	state: State,
	params: { goal: string; slug: string },
	cwd: string,
) {
	const task = `Write a plan for the following goal. Save plan.md and step files under ${planDirFor(params.slug)}/.\n\nGoal: ${params.goal}`;
	const { id, tmuxWindow } = openSubagentWindow(state, {
		kind: "plan",
		task,
		cwd,
		extraArgs: ["--subagent-plan-slug", params.slug],
	});
	state.active.set(id, { kind: "plan", params, tmuxWindow, cwd });
	return spawned("plan", tmuxWindow);
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
) {
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
	const { id, tmuxWindow } = openSubagentWindow(state, {
		kind: "implement",
		task,
		cwd,
	});
	state.active.set(id, { kind: "implement", params, tmuxWindow, cwd });
	return spawned("implement", tmuxWindow);
}

function spawnReview(
	state: State,
	params: { plan: string; step: number },
	cwd: string,
) {
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
		"Call `review` with your verdict and any issues.",
	].join("\n");
	const { id, tmuxWindow } = openSubagentWindow(state, {
		kind: "review",
		task,
		cwd,
	});
	state.active.set(id, { kind: "review", params, tmuxWindow, cwd });
	return spawned("review", tmuxWindow);
}

// ── parent: pipeline + result delivery ─────────────────────────────

function notify(pi: ExtensionAPI, message: string): void {
	pi.sendMessage(
		{ customType: RESULT_TYPE, content: message, display: true },
		{ triggerTurn: true },
	);
}

function startPipeline(
	pi: ExtensionAPI,
	state: State,
	slug: string,
	cwd: string,
): void {
	const planDir = planDirFor(slug);
	const stepCount = fs
		.readdirSync(planDir)
		.filter((f) => f.match(/^step-\d{3}\.md$/)).length;
	if (stepCount === 0) {
		notify(pi, "Plan completed with no steps. Nothing to implement.");
		return;
	}
	state.pipeline = { slug, totalSteps: stepCount, currentStep: 1, cwd };
	notify(pi, `Implementing step 1/${stepCount}...`);
	spawnImplement(state, { plan: slug, step: 1 }, cwd);
}

function deliverResult(
	pi: ExtensionAPI,
	state: State,
	payload: ResultPayload,
): void {
	const slot = state.active.get(payload.id);
	if (!slot)
		throw new Error(`fork: deliverResult for unknown agent ${payload.id}`);
	state.active.delete(payload.id);
	execSync(`tmux kill-window -t ${state.session}:${slot.tmuxWindow}`, {
		encoding: "utf-8",
		timeout: 3000,
	});
	fs.unlinkSync(path.join(TASKS_DIR, `${payload.id}.md`));

	switch (slot.kind) {
		case "plan":
			startPipeline(pi, state, slot.params.slug, slot.cwd);
			return;

		case "implement": {
			if (!state.pipeline) throw new Error("fork: no active pipeline");
			notify(pi, `Step ${slot.params.step} implemented. Reviewing...`);
			spawnReview(state, slot.params, state.pipeline.cwd);
			return;
		}

		case "review": {
			if (!state.pipeline) throw new Error("fork: no active pipeline");
			const { verdict } = payload as ReviewResultPayload;
			if (verdict !== "pass") {
				notify(
					pi,
					`Review failed for step ${slot.params.step}. Pipeline stopped.`,
				);
				state.pipeline = null;
				return;
			}
			state.pipeline.currentStep++;
			if (state.pipeline.currentStep > state.pipeline.totalSteps) {
				notify(
					pi,
					`All ${state.pipeline.totalSteps} steps implemented and reviewed.`,
				);
				state.pipeline = null;
				return;
			}
			const { slug, currentStep, totalSteps, cwd } = state.pipeline;
			notify(pi, `Implementing step ${currentStep}/${totalSteps}...`);
			spawnImplement(state, { plan: slug, step: currentStep }, cwd);
			return;
		}
	}
}

// ── parent role ─────────────────────────────────────────────────────

function setupParent(pi: ExtensionAPI): void {
	fs.mkdirSync(SOCKETS_DIR, { recursive: true });
	fs.mkdirSync(TASKS_DIR, { recursive: true });

	const state: State = {
		session: tmuxSession(),
		sessionId: "",
		active: new Map(),
		pipeline: null,
	};

	let server: net.Server | null = null;
	let sockPath: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		state.sessionId = ctx.sessionManager.getSessionId();
		sockPath = socketPathFor(state.sessionId);
		server = net.createServer((socket) => {
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
		const currentSockPath = sockPath;
		server.listen(currentSockPath, () => {
			fs.chmodSync(currentSockPath, 0o600);
		});
	});

	pi.on("session_shutdown", () => {
		server?.close();
		if (sockPath) fs.unlinkSync(sockPath);
		server = null;
		sockPath = null;
	});

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"Create an implementation plan. Reads the codebase and writes plans/<slug>/plan.md + step files.",
		parameters: Type.Object({
			goal: Type.String({ description: "What the plan should accomplish" }),
			slug: Type.String({
				description: "Filename slug; plan is saved to plans/<slug>/",
			}),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) =>
			spawnPlan(state, params as { goal: string; slug: string }, ctx.cwd),
	});
}

// ── child role: shared helper ──────────────────────────────────────

function reportAndShutdown(
	socketPath: string,
	payload: ResultPayload,
	shutdown: () => void,
): void {
	const socket = net.connect(socketPath);
	socket.on("error", (err) => {
		throw err;
	});
	socket.end(`${JSON.stringify(payload)}\n`, () => shutdown());
}

// ── child role: plan ───────────────────────────────────────────────

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

	pi.on("before_agent_start", () => ({
		systemPrompt: fs.readFileSync(path.join(PROMPTS_DIR, "plan.md"), "utf-8"),
	}));

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

	pi.registerTool({
		name: "implement",
		label: "Implement",
		description:
			"Report completion to the parent and start implementation. Call when the plan is complete.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			reportAndShutdown(socketPath, { id }, ctx.shutdown);
			return {
				content: [
					{ type: "text", text: "Plan complete. Starting implementation." },
				],
			};
		},
	});

	pi.setActiveTools([...READ_ONLY, "write_plan", "write_step", "implement"]);
}

// ── child role: implement ──────────────────────────────────────────

function setupImplementChild(
	pi: ExtensionAPI,
	id: string,
	socketPath: string,
): void {
	pi.on("before_agent_start", () => ({
		systemPrompt: fs.readFileSync(
			path.join(PROMPTS_DIR, "implement.md"),
			"utf-8",
		),
	}));

	pi.registerTool({
		name: "commit",
		label: "Commit",
		description:
			"Stage all changes, commit, and report completion to the parent. " +
			"Call when your implementation is complete.",
		parameters: Type.Object({
			message: Type.String({ description: "Commit message" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { message } = params as { message: string };
			execSync("git add -A", { encoding: "utf-8", timeout: 30000 });
			execSync(`git commit -m ${JSON.stringify(message)}`, {
				encoding: "utf-8",
				timeout: 60000,
			});
			reportAndShutdown(socketPath, { id }, ctx.shutdown);
			return { content: [{ type: "text", text: "Committed and done." }] };
		},
	});

	pi.setActiveTools(["commit"]);
}

// ── child role: review ─────────────────────────────────────────────

function setupReviewChild(
	pi: ExtensionAPI,
	id: string,
	socketPath: string,
): void {
	pi.on("before_agent_start", () => ({
		systemPrompt: fs.readFileSync(path.join(PROMPTS_DIR, "review.md"), "utf-8"),
	}));

	pi.registerTool({
		name: "review",
		label: "Review",
		description:
			"Submit your review verdict and issues, and report completion to the parent. " +
			"Call when your review is complete.",
		parameters: Type.Object({
			verdict: Type.Union(
				[Type.Literal("pass"), Type.Literal("changes-needed")],
				{ description: "Whether the step passes review" },
			),
			issues: Type.Array(
				Type.Object({
					file: Type.String({ description: "File path" }),
					line: Type.Number({ description: "Line number" }),
					issue: Type.String({ description: "Short description" }),
				}),
				{ description: "Issues found (empty if verdict is pass)" },
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { verdict, issues } = params as {
				verdict: "pass" | "changes-needed";
				issues: Array<{ file: string; line: number; issue: string }>;
			};
			const result: ReviewResultPayload = { id, verdict };
			reportAndShutdown(socketPath, result, ctx.shutdown);
			return {
				content: [
					{
						type: "text",
						text: `Review submitted: ${verdict} (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
					},
				],
			};
		},
	});

	pi.setActiveTools([...READ_ONLY, "bash", "review"]);
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

	const agentName = pi.getFlag("agent") as string | undefined;
	if (agentName === undefined) {
		setupParent(pi);
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
}
