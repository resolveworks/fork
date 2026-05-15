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

function tmux(cmd: string): string {
	try {
		return execSync(`tmux ${cmd}`, { encoding: "utf-8", timeout: 3000 }).trim();
	} catch {
		return "";
	}
}

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

// ── result payload (sent by child over socket, parsed by parent) ────

interface ResultPayload {
	id: string;
	agent: string;
	tmuxWindow: string;
	success: boolean;
	takenOver: boolean;
	stopReason: string;
	summary: string;
	timestamp: number;
}

interface ChildCompletion {
	success: boolean;
	takenOver: boolean;
	stopReason: string;
	summary: string;
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

	/** Parse the child's raw completion into a typed result. */
	abstract extractResult(raw: ChildCompletion, params: P): R;

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
	{ planPath: string }
> {
	readonly name = "plan";
	readonly description =
		"Create an implementation plan. Reads the codebase and writes plans/<slug>.md.";
	readonly tools = [...READ_ONLY, "write"] as const;
	readonly params = Type.Object({
		goal: Type.String({ description: "What the plan should accomplish" }),
		slug: Type.String({
			description: "Filename slug; plan is saved to plans/<slug>.md",
		}),
	});

	systemPrompt(): string {
		return [
			"You are a planning specialist. Read the codebase, understand the goal,",
			"and write a plan file at the path given in the task.",
			"",
			"You may use read-only tools and `write` for the plan file only. Do not",
			"modify any other file.",
			"",
			"Plan format:",
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
			"Each step must be small enough that a single subagent can implement it",
			"with only the named file(s) loaded. Spell out paths, signatures, imports.",
		].join("\n");
	}

	formatTask({ goal, slug }: { goal: string; slug: string }): string {
		return `Write a plan for the following goal and save it to plans/${slug}.md.\n\nGoal: ${goal}`;
	}

	extractResult(
		_raw: ChildCompletion,
		{ slug }: { goal: string; slug: string },
	): { planPath: string } {
		return { planPath: `plans/${slug}.md` };
	}
}

class ImplementAgent extends SubAgent<
	{ plan: string; step: number },
	{ commit: string }
> {
	readonly name = "implement";
	readonly description =
		"Implement a single step from a plan. Commits on the current branch.";
	readonly tools: readonly string[] = []; // unrestricted
	readonly params = Type.Object({
		plan: Type.String({ description: "Path to the plan file" }),
		step: Type.Number({ description: "Step number to implement" }),
	});

	systemPrompt(): string {
		return [
			"You are an implementation specialist. Implement exactly one step of a",
			"plan — not more.",
			"",
			"- Read the plan file specified in the task.",
			"- Find the named step. Implement only that step's changes.",
			"- Commit when done. Pre-commit hooks (type-check, lint, tests) must pass.",
			"  If a hook fails, fix the underlying issue and re-commit — don't bypass.",
			"- Output a one-line summary of what changed.",
		].join("\n");
	}

	formatTask({ plan, step }: { plan: string; step: number }): string {
		return `Implement step ${step} of ${plan}. Read the plan, find step ${step}, implement only that step, then commit.`;
	}

	extractResult(
		_raw: ChildCompletion,
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
		"Review a step's commit against its acceptance criteria. Returns a structured verdict.";
	readonly tools = [...READ_ONLY, "bash"] as const;
	readonly params = Type.Object({
		plan: Type.String({ description: "Path to the plan file" }),
		step: Type.Number({ description: "Step number that was implemented" }),
		commit: Type.String({ description: "Commit SHA implementing the step" }),
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
			"Use `bash` for `git show <commit>` and `git diff` only.",
			"",
			"End your response with exactly this block, and nothing after it:",
			"",
			"```verdict",
			"verdict: pass | changes-needed",
			"issues:",
			"  - file: path/to/file.ts",
			"    line: 42",
			"    issue: short description",
			"```",
			"",
			"If there are no issues, leave the `issues:` list empty.",
		].join("\n");
	}

	formatTask({
		plan,
		step,
		commit,
	}: { plan: string; step: number; commit: string }): string {
		return [
			`Review commit ${commit}, which implements step ${step} of ${plan}.`,
			"",
			`1. Read ${plan} and find step ${step}, including its acceptance.`,
			`2. Inspect the diff with \`git show ${commit}\`.`,
			`3. Judge whether the commit meets the step's intent and acceptance.`,
			`4. Emit the verdict block per the system prompt.`,
		].join("\n");
	}

	extractResult(
		raw: ChildCompletion,
		_params: { plan: string; step: number; commit: string },
	): { verdict: "pass" | "changes-needed"; issues: ReviewIssue[] } {
		return parseVerdictBlock(raw.summary);
	}
}

function parseVerdictBlock(text: string): {
	verdict: "pass" | "changes-needed";
	issues: ReviewIssue[];
} {
	const block = text.match(/```verdict\s*\n([\s\S]*?)```/);
	if (!block) {
		return {
			verdict: "changes-needed",
			issues: [
				{ file: "", line: 0, issue: "Reviewer did not emit a verdict block" },
			],
		};
	}
	const body = block[1];
	const v = body.match(/verdict:\s*(pass|changes-needed)/);
	const verdict = (v?.[1] ?? "changes-needed") as "pass" | "changes-needed";

	const issues: ReviewIssue[] = [];
	const re = /-\s*file:\s*(\S+)\s*\n\s*line:\s*(\d+)\s*\n\s*issue:\s*(.+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		issues.push({ file: m[1], line: Number(m[2]), issue: m[3].trim() });
	}
	return { verdict, issues };
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
	private active = new Map<string, { agent: SubAgent<any, any>; params: any }>();
	private finalized = new Set<string>();
	private session: string;
	private currentSessionId: string | null = null;

	constructor(private pi: ExtensionAPI) {
		this.session = tmux("display-message -p '#S'");
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

		const win = tmux(
			`new-window -t ${this.session} -n ${id} -c ${ctx.cwd} -P -F '#I'`,
		);
		if (!win) {
			return {
				content: [{ type: "text", text: "Failed to create tmux window." }],
				isError: true,
			};
		}
		tmux(`set-option -t ${this.session}:${win} -w remain-on-exit off`);

		const cmd = [
			"pi",
			"--agent",
			agent.name,
			"--subagent-id",
			id,
			"--subagent-socket",
			socketPathFor(this.currentSessionId),
			"--subagent-window",
			win,
			`@${taskPath}`,
		].join(" ");
		tmux(`send-keys -t ${this.session}:${win} ${JSON.stringify(cmd)} Enter`);

		this.active.set(id, { agent, params });

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

		const message = this.formatDelivery(payload);

		this.pi.sendMessage(
			{
				customType: RESULT_TYPE,
				content: message.content,
				display: true,
				details: message.details,
			},
			{ triggerTurn: true },
		);

		if (!payload.takenOver) {
			this.finalized.add(payload.id);
			if (payload.tmuxWindow) {
				tmux(`kill-window -t ${this.session}:${payload.tmuxWindow}`);
			}
			fs.unlinkSync(path.join(TASKS_DIR, `${payload.id}.md`));
		}
	}

	private formatDelivery(data: ResultPayload): {
		content: string;
		details: unknown;
	} {
		if (data.takenOver) {
			return {
				content: `Subagent **${data.agent}** (window ${data.tmuxWindow}) was taken over — no findings returned. (stopReason: ${data.stopReason})`,
				details: data,
			};
		}

		const slot = this.active.get(data.id);
		this.active.delete(data.id);
		if (!slot) {
			// Orphaned result (e.g. recovered after restart) — deliver raw.
			return {
				content: `Subagent **${data.agent}** completed:\n\n${data.summary || "(no output)"}`,
				details: data,
			};
		}

		const typed = slot.agent.extractResult(
			{
				success: data.success,
				takenOver: data.takenOver,
				stopReason: data.stopReason,
				summary: data.summary,
			},
			slot.params,
		);

		return {
			content: `Subagent **${data.agent}** completed:\n\n\`\`\`json\n${JSON.stringify(typed, null, 2)}\n\`\`\``,
			details: { ...data, typed },
		};
	}
}

// ── parent role ─────────────────────────────────────────────────────

function setupParent(pi: ExtensionAPI): void {
	fs.mkdirSync(SOCKETS_DIR, { recursive: true });
	fs.mkdirSync(TASKS_DIR, { recursive: true });

	const dispatcher = new Dispatcher(pi);

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		dispatcher.setSessionId(sessionId);

		// Planned cleanup of a server left by a previous extension load in this
		// same process (pi's hot-reload model). We don't preemptively clean
		// sockets from other processes — `listen` will throw EADDRINUSE.
		const prevServer = (globalThis as any).__fork_server as net.Server | undefined;
		const prevPath = (globalThis as any).__fork_server_path as string | undefined;
		if (prevServer) {
			prevServer.close();
			if (prevPath) fs.unlinkSync(prevPath);
		}

		const sockPath = socketPathFor(sessionId);
		const server = net.createServer((socket) => {
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
			fs.chmodSync(sockPath, 0o600);
		});
		(globalThis as any).__fork_server = server;
		(globalThis as any).__fork_server_path = sockPath;
	});

	for (const a of agents) a.registerTool(pi, dispatcher);
}

// ── child role ──────────────────────────────────────────────────────

function setupChild(pi: ExtensionAPI, agent: SubAgent<any, any>): void {
	const id = pi.getFlag("subagent-id") as string | undefined;
	const socketPath = pi.getFlag("subagent-socket") as string | undefined;
	const tmuxWindow = (pi.getFlag("subagent-window") as string | undefined) ?? "";
	if (!id) throw new Error("fork: subagent missing required --subagent-id flag");
	if (!socketPath)
		throw new Error("fork: subagent missing required --subagent-socket flag");

	agent.setupChild(pi);

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
			tmuxWindow,
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
	pi.registerFlag("subagent-window", {
		description: "Subagent tmux window (internal)",
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
