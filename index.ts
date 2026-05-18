/**
 * fork — Manage subagents as interactive pi sessions in tmux windows.
 *
 * The same extension runs in both parent and child. Mode is selected by
 * the `--agent` flag: present → child running as that agent; absent →
 * parent that registers one tool per agent and watches for results.
 *
 * Children are spawned as separate `pi` processes in new tmux windows.
 * The parent's tool call returns immediately; results are delivered
 * back as a `fork-result` notification message that triggers a new
 * turn. Each agent has its own completion tool: `implement`, `commit`, or `review`.
 *
 * Requires: run pi inside tmux.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

// ── tmux ────────────────────────────────────────────────────────────

function inTmux(): boolean {
	return !!process.env.TMUX;
}

// ── shared paths / constants ────────────────────────────────────────

const ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "fork");
const SOCKETS_DIR = path.join(ROOT, "sockets");
const TASKS_DIR = path.join(ROOT, "tasks");
const RESULT_TYPE = "fork-result";

function socketPathFor(parentSessionId: string): string {
	return path.join(SOCKETS_DIR, `${parentSessionId}.sock`);
}

function planBaseDir(): string {
	return process.env.FORK_PLANS_DIR ?? "plans";
}

function planDirFor(slug: string): string {
	return path.join(planBaseDir(), slug);
}

// ── result payload (sent by child over socket, parsed by parent) ────

interface ResultPayload {
	id: string;
}

interface ReviewResultPayload extends ResultPayload {
	verdict: "pass" | "changes-needed";
}

interface PipelineState {
	slug: string;
	totalSteps: number;
	currentStep: number;
	cwd: string;
}

// ── SubAgent base ───────────────────────────────────────────────────

abstract class SubAgent<P> {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly tools: readonly string[]; // empty = no restriction
	abstract readonly params: TSchema;

	/** System prompt the child runs under. */
	abstract systemPrompt(): string;

	/** Build the initial task message the child sees, from typed params. */
	abstract formatTask(params: P): string;

	/** Parent: register this agent as its own pi tool. */
	registerTool(pi: ExtensionAPI, dispatcher: Dispatcher): void {
		pi.registerTool({
			name: this.name,
			label: this.name.charAt(0).toUpperCase() + this.name.slice(1),
			description: this.description,
			parameters: this.params as TSchema,
			execute: async (_id, params, _signal, _onUpdate, ctx) =>
				dispatcher.spawn(this, params as P, ctx.cwd),
		});
	}

	/** Child: apply our system prompt and tool restriction. */
	setupChild(pi: ExtensionAPI): void {
		pi.on("before_agent_start", () => ({
			systemPrompt: this.systemPrompt(),
		}));
		if (this.tools.length > 0) {
			pi.setActiveTools([...this.tools]);
		}
	}
}

// ── concrete agents ─────────────────────────────────────────────────

const READ_ONLY = ["read", "grep", "find", "ls"] as const;

class PlanAgent extends SubAgent<{ goal: string; slug: string }> {
	readonly name = "plan";
	readonly description =
		"Create an implementation plan. Reads the codebase and writes plans/<slug>/plan.md + step files.";
	readonly tools = [...READ_ONLY, "write_plan", "write_step"] as const;
	readonly params = Type.Object({
		goal: Type.String({ description: "What the plan should accomplish" }),
		slug: Type.String({
			description: "Filename slug; plan is saved to plans/<slug>/",
		}),
	});

	systemPrompt(): string {
		return [
			"You are a planning specialist. Read the codebase, understand the goal,",
			"and write a plan as a directory of files under the path given in the task.",
			"",
			"Use `write_plan` once to create the overview file (plan.md).",
			"Use `write_step` to create individual step files — they are auto-numbered.",
			"You may also use read-only tools. Do not modify any other file.",
			"",
			"Before writing, think through:",
			"- Current state: what exists, key files and their responsibilities.",
			"- Strategy: how to get from here to the goal, and why this approach.",
			"- Risks: what could go wrong.",
			"",
			"Overview (plan.md) format:",
			"",
			"```",
			"# Plan: <slug>",
			"",
			"## Goal",
			"<what someone can do after this change that they can't do now>",
			"",
			"## Context",
			"<brief orientation: key files, how they fit together, what the implementer needs to know>",
			"",
			"## Steps",
			"1. **<file>** — <what changes>",
			"   - acceptance: <observable behavior — a command, test, or output>",
			"2. ...",
			"",
			"## Risks",
			"<things to watch for>",
			"```",
			"",
			"Each step file (step-NNN.md) must be self-contained: include everything",
			"the implementer needs without reading other steps. Name exact files,",
			"functions, types, and signatures. Write acceptance as observable behavior",
			"('test X passes', 'command outputs Y') — not internal state ('added a struct').",
			"Keep each step to one meaningful commit.",
			"",
			"When done, call `implement`.",
		].join("\n");
	}

	formatTask({ goal, slug }: { goal: string; slug: string }): string {
		return `Write a plan for the following goal. Save plan.md and step files under ${planDirFor(slug)}/.\n\nGoal: ${goal}`;
	}
}

class ImplementAgent extends SubAgent<{ plan: string; step: number }> {
	readonly name = "implement";
	readonly description =
		"Implement a single step from a plan. Commits on the current branch.";
	// `plan` param is a slug (e.g. "dark-mode"); paths are constructed internally.
	readonly tools: readonly string[] = []; // unrestricted
	readonly params = Type.Object({
		plan: Type.String({ description: "Plan slug (e.g. dark-mode)" }),
		step: Type.Number({ description: "Step number to implement" }),
	});

	systemPrompt(): string {
		return [
			"You are an implementation specialist. Implement exactly one step of a",
			"plan — not more.",
			"",
			"- Implement only the step described in the task.",
			"- Call `commit` when done with a one-line summary of what changed.",
			"  Pre-commit hooks (type-check, lint, tests) must pass.",
			"  If a hook fails, fix the underlying issue and re-commit — don't bypass.",
		].join("\n");
	}

	formatTask({ plan, step }: { plan: string; step: number }): string {
		const padded = String(step).padStart(3, "0");
		const dir = planDirFor(plan);
		const planPath = path.join(dir, "plan.md");
		const stepPath = path.join(dir, `step-${padded}.md`);
		if (!fs.existsSync(planPath)) {
			throw new Error(`fork: plan file not found: ${planPath}`);
		}
		if (!fs.existsSync(stepPath)) {
			throw new Error(`fork: step file not found: ${stepPath}`);
		}
		const planContent = fs.readFileSync(planPath, "utf-8");
		const stepContent = fs.readFileSync(stepPath, "utf-8");
		return [
			`# Plan Overview`,
			"",
			planContent,
			"",
			`# Step ${padded}`,
			"",
			stepContent,
		].join("\n");
	}
}

interface ReviewIssue {
	file: string;
	line: number;
	issue: string;
}

class ReviewAgent extends SubAgent<{ plan: string; step: number }> {
	readonly name = "review";
	readonly description =
		"Read-only code review specialist. Reads plan/step files and reviews the latest commit against the step's acceptance criteria.";
	readonly tools = [...READ_ONLY, "bash"] as const;
	readonly params = Type.Object({
		plan: Type.String({ description: "Plan slug (e.g. dark-mode)" }),
		step: Type.Number({ description: "Step number to review" }),
	});

	systemPrompt(): string {
		return [
			"You are a code reviewer. You judge whether one step of a plan was",
			"implemented correctly. Pre-commit hooks already ran — don't re-run",
			"linters, type-checks, or tests. Focus on judgment:",
			"",
			"- Does the diff match the step's acceptance criterion?",
			"- Design problems, missed edge cases, security issues, inconsistency.",
			"",
			"Use `bash` for `git show HEAD` and `git diff` only.",
			"",
			"When done, call `review` with your verdict and issues.",
		].join("\n");
	}

	formatTask({ plan, step }: { plan: string; step: number }): string {
		const padded = String(step).padStart(3, "0");
		const dir = planDirFor(plan);
		const planPath = path.join(dir, "plan.md");
		const stepPath = path.join(dir, `step-${padded}.md`);
		if (!fs.existsSync(planPath)) {
			throw new Error(`fork: plan file not found: ${planPath}`);
		}
		if (!fs.existsSync(stepPath)) {
			throw new Error(`fork: step file not found: ${stepPath}`);
		}
		const planContent = fs.readFileSync(planPath, "utf-8");
		const stepContent = fs.readFileSync(stepPath, "utf-8");
		return [
			`Review the latest commit, which implements step ${padded} of plan "${plan}".`,
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
	}
}

// ── registry ────────────────────────────────────────────────────────

const agents: SubAgent<Record<string, unknown>>[] = [
	new PlanAgent(),
	new ImplementAgent(),
	new ReviewAgent(),
];
const agentByName = new Map(agents.map((a) => [a.name, a]));

// ── parent: dispatcher ──────────────────────────────────────────────

class Dispatcher {
	private active = new Map<
		string,
		{
			agent: SubAgent<Record<string, unknown>>;
			params: Record<string, unknown>;
			tmuxWindow: string;
			cwd: string;
		}
	>();
	private pipeline: PipelineState | null = null;
	private session: string;
	private currentSessionId: string | null = null;

	constructor(private pi: ExtensionAPI) {
		this.session = execSync("tmux display-message -p '#S'", {
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
	}

	setSessionId(id: string): void {
		this.currentSessionId = id;
	}

	spawn<P>(
		agent: SubAgent<P>,
		params: P,
		cwd: string,
	): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
		if (!this.currentSessionId) {
			throw new Error(
				"fork: spawn called before session_start; no session id available",
			);
		}
		const id = `pi-${agent.name}-${Date.now().toString(36)}`;
		const taskPath = path.join(TASKS_DIR, `${id}.md`);
		fs.writeFileSync(taskPath, agent.formatTask(params), { mode: 0o600 });

		const win = execSync(
			`tmux new-window -t ${this.session} -n ${id} -c ${cwd} -P -F '#I'`,
			{ encoding: "utf-8", timeout: 3000 },
		).trim();
		execSync(
			`tmux set-option -t ${this.session}:${win} -w remain-on-exit off`,
			{ encoding: "utf-8", timeout: 3000 },
		);

		const cmdParts = [
			"pi",
			"--agent",
			agent.name,
			"--subagent-id",
			id,
			"--subagent-socket",
			socketPathFor(this.currentSessionId),
		];
		if (agent instanceof PlanAgent) {
			cmdParts.push("--subagent-plan-slug", (params as { slug: string }).slug);
		}
		cmdParts.push(`@${taskPath}`);
		const cmd = cmdParts.join(" ");
		execSync(
			`tmux send-keys -t ${this.session}:${win} ${JSON.stringify(cmd)} Enter`,
			{ encoding: "utf-8", timeout: 3000 },
		);

		this.active.set(id, { agent, params, tmuxWindow: win, cwd });

		return {
			content: [
				{
					type: "text",
					text: `Spawned ${agent.name} in tmux window ${win}. Result will be delivered when done.`,
				},
			],
		};
	}

	deliverResult(payload: ResultPayload): void {
		const slot = this.active.get(payload.id);
		if (!slot)
			throw new Error(
				`fork: deliverResult called for unknown agent ${payload.id}`,
			);

		this.active.delete(payload.id);
		execSync(`tmux kill-window -t ${this.session}:${slot.tmuxWindow}`, {
			encoding: "utf-8",
			timeout: 3000,
		});
		fs.unlinkSync(path.join(TASKS_DIR, `${payload.id}.md`));

		if (slot.agent instanceof PlanAgent) {
			this.startPipeline(slot.params as { slug: string }, slot.cwd);
		} else if (slot.agent instanceof ImplementAgent) {
			this.handleImplementComplete(
				slot.params as { plan: string; step: number },
			);
		} else if (slot.agent instanceof ReviewAgent) {
			const { verdict } = payload as ReviewResultPayload;
			this.handleReviewComplete(
				slot.params as { plan: string; step: number },
				verdict,
			);
		}
	}

	private startPipeline(params: { slug: string }, cwd: string): void {
		const { slug } = params;
		const planDir = planDirFor(slug);
		const stepFiles = fs
			.readdirSync(planDir)
			.filter((f) => f.match(/^step-\d{3}\.md$/))
			.sort();

		if (stepFiles.length === 0) {
			this.notify("Plan completed with no steps. Nothing to implement.");
			return;
		}

		this.pipeline = { slug, totalSteps: stepFiles.length, currentStep: 1, cwd };
		this.spawnImplementStep();
	}

	private spawnImplementStep(): void {
		if (!this.pipeline) throw new Error("fork: no active pipeline");
		const { slug, currentStep, totalSteps } = this.pipeline;

		this.notify(`Implementing step ${currentStep}/${totalSteps}...`);

		const implementAgent = agentByName.get("implement");
		if (!implementAgent)
			throw new Error("fork: implement agent not found in registry");
		this.spawn(
			implementAgent,
			{ plan: slug, step: currentStep },
			this.pipeline.cwd,
		);
	}

	private handleImplementComplete(params: {
		plan: string;
		step: number;
	}): void {
		if (!this.pipeline) throw new Error("fork: no active pipeline");

		this.notify(`Step ${params.step} implemented. Reviewing...`);

		const reviewAgent = agentByName.get("review");
		if (!reviewAgent)
			throw new Error("fork: review agent not found in registry");
		this.spawn(
			reviewAgent,
			{ plan: params.plan, step: params.step },
			this.pipeline.cwd,
		);
	}

	private handleReviewComplete(
		params: { plan: string; step: number },
		verdict: "pass" | "changes-needed",
	): void {
		if (!this.pipeline) throw new Error("fork: no active pipeline");

		if (verdict === "pass") {
			this.pipeline.currentStep++;
			if (this.pipeline.currentStep > this.pipeline.totalSteps) {
				this.notify(
					`All ${this.pipeline.totalSteps} steps implemented and reviewed.`,
				);
				this.pipeline = null;
			} else {
				this.spawnImplementStep();
			}
		} else {
			this.notify(`Review failed for step ${params.step}. Pipeline stopped.`);
			this.pipeline = null;
		}
	}

	private notify(message: string): void {
		this.pi.sendMessage(
			{ customType: RESULT_TYPE, content: message, display: true },
			{ triggerTurn: true },
		);
	}
}

// ── parent role ─────────────────────────────────────────────────────

function setupParent(pi: ExtensionAPI): void {
	fs.mkdirSync(SOCKETS_DIR, { recursive: true });
	fs.mkdirSync(TASKS_DIR, { recursive: true });

	const dispatcher = new Dispatcher(pi);
	let server: net.Server | null = null;
	let sockPath: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		dispatcher.setSessionId(sessionId);

		sockPath = socketPathFor(sessionId);
		server = net.createServer((socket) => {
			let buf = "";
			socket.setEncoding("utf-8");
			socket.on("data", (chunk: string) => {
				buf += chunk;
				for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.length === 0) continue;
					const payload = JSON.parse(line) as ResultPayload;
					dispatcher.deliverResult(payload);
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

	// Only expose plan to the LLM; implement and review run mechanically
	const planAgent = agentByName.get("plan");
	if (!planAgent) throw new Error("fork: plan agent not found in registry");
	planAgent.registerTool(pi, dispatcher);
}

// ── child role ──────────────────────────────────────────────────────

function setupChild(
	pi: ExtensionAPI,
	agent: SubAgent<Record<string, unknown>>,
): void {
	const id = pi.getFlag("subagent-id") as string | undefined;
	const socketPath = pi.getFlag("subagent-socket") as string | undefined;
	if (!id)
		throw new Error("fork: subagent missing required --subagent-id flag");
	if (!socketPath)
		throw new Error("fork: subagent missing required --subagent-socket flag");

	agent.setupChild(pi);

	// Register plan-specific tools for PlanAgent
	if (agent instanceof PlanAgent) {
		const slug = pi.getFlag("subagent-plan-slug") as string | undefined;
		if (!slug)
			throw new Error(
				"fork: plan agent missing required --subagent-plan-slug flag",
			);

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
				return {
					content: [{ type: "text", text: `Wrote ${planDir}/plan.md` }],
				};
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
				const socket = net.connect(socketPath);
				socket.on("error", (err) => {
					throw err;
				});
				socket.end(`${JSON.stringify({ id })}\n`, () => ctx.shutdown());
				return {
					content: [
						{ type: "text", text: "Plan complete. Starting implementation." },
					],
				};
			},
		});

		pi.setActiveTools([
			...agent.tools,
			"write_plan",
			"write_step",
			"implement",
		]);
	}

	if (agent instanceof ImplementAgent) {
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
				const socket = net.connect(socketPath);
				socket.on("error", (err) => {
					throw err;
				});
				socket.end(`${JSON.stringify({ id })}\n`, () => ctx.shutdown());
				return { content: [{ type: "text", text: "Committed and done." }] };
			},
		});
		pi.setActiveTools([...agent.tools, "commit"]);
	} else if (agent instanceof ReviewAgent) {
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
					issues: ReviewIssue[];
				};
				const socket = net.connect(socketPath);
				socket.on("error", (err) => {
					throw err;
				});
				const payload: ReviewResultPayload = { id, verdict };
				socket.end(`${JSON.stringify(payload)}\n`, () => ctx.shutdown());
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
		pi.setActiveTools([...agent.tools, "review"]);
	}
}

// ── extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!inTmux()) return;

	pi.registerFlag("agent", {
		description: `Subagent mode: one of ${agents.map((a) => a.name).join(", ")}`,
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
	if (agentName) {
		const agent = agentByName.get(agentName);
		if (!agent) throw new Error(`fork: unknown agent "${agentName}"`);
		setupChild(pi, agent);
		return;
	}
	setupParent(pi);
}
