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
 * turn. If the human takes over the child's tmux window (typing, Esc,
 * queued message), the child reports `takenOver` and stays alive.
 *
 * Requires: run pi inside tmux.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

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



// ── SubAgent base ───────────────────────────────────────────────────

abstract class SubAgent<P, R> {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly tools: readonly string[]; // empty = no restriction
	abstract readonly params: TSchema;

	/** System prompt the child runs under. */
	abstract systemPrompt(): string;

	/** Build the initial task message the child sees, from typed params. */
	abstract formatTask(params: P): string;

	/** Extract the typed result after child completion. */
	abstract extractResult(params: P): R;

	/** Parent: register this agent as its own pi tool. */
	registerTool(pi: ExtensionAPI, dispatcher: Dispatcher): void {
		pi.registerTool({
			name: this.name,
			label: this.name.charAt(0).toUpperCase() + this.name.slice(1),
			description: this.description,
			parameters: this.params as any,
			execute: async (_id, params, _signal, _onUpdate, ctx) =>
				dispatcher.spawn(this, params as P, ctx),
		});
	}

	/** Child: apply our system prompt and tool restriction. */
	setupChild(pi: ExtensionAPI): void {
		pi.on("before_agent_start", () => ({
			systemPrompt: this.systemPrompt(),
		}));
		if (this.tools.length > 0) {
			pi.setActiveTools([...this.tools, "report"]);
		}
	}
}

// ── concrete agents ─────────────────────────────────────────────────

const READ_ONLY = ["read", "grep", "find", "ls"] as const;

class PlanAgent extends SubAgent<
	{ goal: string; slug: string },
	{ planDir: string }
> {
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
			"Overview (plan.md) format:",
			"",
			"```",
			"# Plan: <slug>",
			"",
			"## Goal",
			"<one sentence>",
			"",
			"## Steps",
			"1. **<file>** — <what changes>",
			"   - acceptance: <how we know it worked>",
			"2. ...",
			"",
			"## Risks",
			"<things to watch for>",
			"```",
			"",
			"Each step file (step-NNN.md) must be small enough that a single subagent",
			"can implement it with only the named file(s) loaded. Spell out paths,",
			"signatures, imports, and acceptance criteria.",
		].join("\n");
	}

	formatTask({ goal, slug }: { goal: string; slug: string }): string {
		return `Write a plan for the following goal. Save plan.md and step files under ${planDirFor(slug)}/.\n\nGoal: ${goal}`;
	}

	extractResult(
		{ slug }: { goal: string; slug: string },
	): { planDir: string } {
		return { planDir: planDirFor(slug) };
	}
}

class ImplementAgent extends SubAgent<
	{ plan: string; step: number },
	{ commit: string }
> {
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
			"- Commit when done. Pre-commit hooks (type-check, lint, tests) must pass.",
			"  If a hook fails, fix the underlying issue and re-commit — don't bypass.",
			"- Output a one-line summary of what changed.",
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

	extractResult(
		_params: { plan: string; step: number },
	): { commit: string } {
		try {
			return {
				commit: execSync("git rev-parse HEAD", {
					encoding: "utf-8",
				}).trim(),
			};
		} catch {
			return { commit: "" };
		}
	}
}

interface ReviewIssue {
	file: string;
	line: number;
	issue: string;
}

class ReviewAgent extends SubAgent<
	{ plan: string; step: number; commit: string },
	{ verdict: "pass" | "changes-needed"; issues: ReviewIssue[] }
> {
	readonly name = "review";
	readonly description =
		"Read-only code review specialist. Reads plan/step files and reviews the commit against the step's acceptance criteria.";
	readonly tools = [...READ_ONLY, "bash", "write_review"] as const;
	readonly params = Type.Object({
		plan: Type.String({ description: "Plan slug (e.g. dark-mode)" }),
		step: Type.Number({ description: "Step number to review" }),
		commit: Type.String({ description: "Commit SHA implementing the step" }),
	});

	/** Stored by the write_review tool call. */
	lastReview: { verdict: "pass" | "changes-needed"; issues: ReviewIssue[] } | null =
		null;

	systemPrompt(): string {
		return [
			"You are a code reviewer. You judge whether one step of a plan was",
			"implemented correctly. Pre-commit hooks already ran — don't re-run",
			"linters, type-checks, or tests. Focus on judgment:",
			"",
			"- Does the diff match the step's acceptance criterion?",
			"- Design problems, missed edge cases, security issues, inconsistency.",
			"",
			"Use `bash` for `git show <commit>` and `git diff` only.",
			"",
			"When done, call `write_review` with your verdict and issues.",
		].join("\n");
	}

	formatTask({
		plan,
		step,
		commit,
	}: { plan: string; step: number; commit: string }): string {
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
			`Review commit ${commit}, which implements step ${padded} of plan "${plan}".`,
			"",
			"# Plan Overview",
			"",
			planContent,
			"",
			`# Step ${padded}`,
			"",
			stepContent,
			"",
			`Inspect the diff with \`git show ${commit}\`.`,
			"Judge whether the commit meets the step's intent and acceptance.",
			"Call `write_review` with your verdict and any issues.",
		].join("\n");
	}

	extractResult(
		_params: { plan: string; step: number; commit: string },
	): { verdict: "pass" | "changes-needed"; issues: ReviewIssue[] } {
		if (!this.lastReview) {
			return {
				verdict: "changes-needed",
				issues: [
					{ file: "", line: 0, issue: "Reviewer did not call write_review" },
				],
			};
		}
		return this.lastReview;
	}
}

// ── registry ────────────────────────────────────────────────────────

const agents: SubAgent<any, any>[] = [
	new PlanAgent(),
	new ImplementAgent(),
	new ReviewAgent(),
];
const agentByName = new Map(agents.map((a) => [a.name, a]));

// ── parent: dispatcher ──────────────────────────────────────────────

class Dispatcher {
	private active = new Map<string, { agent: SubAgent<any, any>; params: any; tmuxWindow: string }>();
	private finalized = new Set<string>();
	private session: string;
	private currentSessionId: string | null = null;

	constructor(private pi: ExtensionAPI) {
		this.session = execSync("tmux display-message -p '#S'", { encoding: "utf-8", timeout: 3000 }).trim();
	}

	setSessionId(id: string): void {
		this.currentSessionId = id;
	}

	spawn<P, R>(
		agent: SubAgent<P, R>,
		params: P,
		ctx: { cwd: string },
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
			`tmux new-window -t ${this.session} -n ${id} -c ${ctx.cwd} -P -F '#I'`,
			{ encoding: "utf-8", timeout: 3000 },
		).trim();
		execSync(`tmux set-option -t ${this.session}:${win} -w remain-on-exit off`, { encoding: "utf-8", timeout: 3000 });

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
		execSync(`tmux send-keys -t ${this.session}:${win} ${JSON.stringify(cmd)} Enter`, { encoding: "utf-8", timeout: 3000 });

		this.active.set(id, { agent, params, tmuxWindow: win });

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
		if (this.finalized.has(payload.id)) return;

		const slot = this.active.get(payload.id);
		if (!slot) throw new Error(`fork: deliverResult called for unknown agent ${payload.id}`);
		const { tmuxWindow } = slot;

		const content = this.formatDelivery(slot);

		this.pi.sendMessage(
			{
				customType: RESULT_TYPE,
				content,
				display: true,
			},
			{ triggerTurn: true },
		);

		this.finalized.add(payload.id);
		this.active.delete(payload.id);
		execSync(`tmux kill-window -t ${this.session}:${tmuxWindow}`, { encoding: "utf-8", timeout: 3000 });
		fs.unlinkSync(path.join(TASKS_DIR, `${payload.id}.md`));
	}

	private formatDelivery(
		slot: { agent: SubAgent<any, any>; params: any; tmuxWindow: string },
	): string {
		const typed = slot.agent.extractResult(slot.params);
		return `Subagent **${slot.agent.name}** completed:\n\n\`\`\`json\n${JSON.stringify(typed, null, 2)}\n\`\`\``;
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
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.length === 0) continue;
					const payload = JSON.parse(line) as ResultPayload;
					dispatcher.deliverResult(payload);
				}
			});
		});
		server.listen(sockPath, () => {
			fs.chmodSync(sockPath!, 0o600);
		});
	});

	pi.on("session_shutdown", () => {
		server?.close();
		if (sockPath) fs.unlinkSync(sockPath);
		server = null;
		sockPath = null;
	});

	for (const a of agents) a.registerTool(pi, dispatcher);
}

// ── child role ──────────────────────────────────────────────────────

function setupChild(pi: ExtensionAPI, agent: SubAgent<any, any>): void {
	const id = pi.getFlag("subagent-id") as string | undefined;
	const socketPath = pi.getFlag("subagent-socket") as string | undefined;
	if (!id) throw new Error("fork: subagent missing required --subagent-id flag");
	if (!socketPath)
		throw new Error("fork: subagent missing required --subagent-socket flag");

	agent.setupChild(pi);

	// Register plan-specific tools for PlanAgent
	if (agent instanceof PlanAgent) {
		const slug = pi.getFlag("subagent-plan-slug") as string | undefined;
		if (!slug) throw new Error("fork: plan agent missing required --subagent-plan-slug flag");

		const planDir = planDirFor(slug);
		let stepCounter = 0;

		pi.registerTool({
			name: "write_plan",
			label: "Write Plan",
			description: "Write the plan overview file. Can only be called once.",
			parameters: Type.Object({
				content: Type.String({ description: "Plan overview content (markdown)" }),
			}),
			async execute(_id, params) {
				if (fs.existsSync(path.join(planDir, "plan.md"))) {
					throw new Error("write_plan already called — plan.md already exists");
				}
				fs.mkdirSync(planDir, { recursive: true });
				fs.writeFileSync(path.join(planDir, "plan.md"), (params as { content: string }).content, { mode: 0o600 });
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
					throw new Error("write_step called before write_plan — plan directory does not exist");
				}
				stepCounter++;
				const padded = String(stepCounter).padStart(3, "0");
				const filename = `step-${padded}.md`;
				fs.writeFileSync(path.join(planDir, filename), (params as { content: string }).content, { mode: 0o600 });
				return { content: [{ type: "text", text: `Wrote ${planDir}/${filename}` }] };
			},
		});

		pi.setActiveTools([...agent.tools, "write_plan", "write_step", "report"]);
	}

	if (agent instanceof ReviewAgent) {
		pi.registerTool({
			name: "write_review",
			label: "Write Review",
			description:
				"Submit your review verdict and issues. Call once when done.",
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
			async execute(_id, params) {
				const { verdict, issues } = params as {
					verdict: "pass" | "changes-needed";
					issues: ReviewIssue[];
				};
				agent.lastReview = { verdict, issues };
				return {
					content: [
						{
							type: "text",
							text: `Review recorded: ${verdict} (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
						},
					],
				};
			},
		});

		pi.setActiveTools([...agent.tools, "report"]);
	}

	let delivered = false;
	let aborted = false;

	const sendResult = (
		partial: Pick<
			ResultPayload,
			"success" | "takenOver" | "stopReason" | "summary"
		>,
		onSent?: () => void,
	) => {
		if (delivered) {
			onSent?.();
			return;
		}
		delivered = true;
		const payload: ResultPayload = {
			id,
			agent: agent.name,
			timestamp: Date.now(),
			...partial,
		};
		const socket = net.connect(socketPath);
		socket.on("error", (err) => {
			throw err;
		});
		socket.end(`${JSON.stringify(payload)}\n`, () => {
			onSent?.();
		});
	};

	pi.on("agent_start", () => {
		if (!aborted) delivered = false;
	});

	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		if (delivered) return;

		const last = [...event.messages].reverse().find((m) => m.role === "assistant") as
			| { role: "assistant"; content: any[]; stopReason?: string }
			| undefined;
		const stopReason = last?.stopReason ?? "unknown";

		const cleanCompletion = stopReason === "stop" && !ctx.hasPendingMessages();

		if (cleanCompletion) {
			const summary = (last?.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			sendResult(
				{ success: true, takenOver: false, stopReason, summary },
				() => ctx.shutdown(),
			);
			return;
		}

		// Steer: user typed while running. takenOver result now; agent_start
		// will reset `delivered` so the next clean completion supersedes it.
		if (ctx.hasPendingMessages()) {
			sendResult({ success: false, takenOver: true, stopReason, summary: "" });
			return;
		}

		// Abort: Esc, no pending messages. Hand the human a `report()` tool.
		aborted = true;
		sendResult({ success: false, takenOver: true, stopReason, summary: "" });

		pi.registerTool({
			name: "report",
			label: "Report",
			description:
				"Report findings back to the parent session and close this subagent window. " +
				"Call this when the human instructs you to report back.",
			parameters: Type.Object({
				summary: Type.String({
					description: "Summary of findings to report to the parent",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
				delivered = false;
				await new Promise<void>((resolve) => {
					sendResult(
						{
							success: true,
							takenOver: false,
							stopReason: "report",
							summary: (params as { summary: string }).summary,
						},
						resolve,
					);
				});
				toolCtx.shutdown();
				return {
					content: [
						{ type: "text", text: "Reported findings to parent session." },
					],
				};
			},
		});
	});
}

// ── extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!inTmux()) return;

	pi.registerFlag("agent", {
		description: "Subagent mode: one of " + agents.map((a) => a.name).join(", "),
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
