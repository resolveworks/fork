/**
 * fork — Manage subagents as interactive pi sessions in tmux windows.
 *
 * Sessions are opened in the tmux session shared by the main agent.
 * The parent's `subagent` tool returns immediately. When the child
 * finishes cleanly, it writes a result file the parent watches and
 * delivers as a `fork-result` notification message that triggers a
 * new turn. If the human takes over the child's tmux window (typing,
 * Esc, queued message), the child reports `takenOver` and stays alive
 * as a normal interactive pi.
 *
 * Tool:      subagent { agent, task }
 *
 * Requires: run pi inside tmux.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

function isSubagent(): boolean {
	return !!process.env.PI_SUBAGENT;
}

// ── shared paths ────────────────────────────────────────────────────

const ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "fork");
const RESULTS_DIR = path.join(ROOT, "results");
const TASKS_DIR = path.join(ROOT, "tasks");
const RESULT_TYPE = "fork-result";
const SEEN_TTL_MS = 10 * 60 * 1000;

// ── hardcoded agents ────────────────────────────────────────────────

interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	prompt: string;
}

const AGENTS: AgentConfig[] = [
	{
		name: "planner",
		description: "Creates implementation plans from context and requirements (read-only)",
		tools: ["read", "grep", "find", "ls"],
		prompt:
			`You are a planning specialist. You receive context and requirements, then produce a clear implementation plan.\n\n` +
			`You must NOT make any changes. Only read, analyze, and plan.\n\n` +
			`Output format:\n\n` +
			`## Goal\n` +
			`One sentence summary of what needs to be done.\n\n` +
			`## Plan\n` +
			`Numbered steps, each small and actionable:\n` +
			`1. Step one - specific file/function to modify\n` +
			`2. Step two - what to add/change\n` +
			`...\n\n` +
			`## Files to Modify\n` +
			`- path/to/file.ts - what changes\n\n` +
			`## New Files (if any)\n` +
			`- path/to/new.ts - purpose\n\n` +
			`## Risks\n` +
			`Anything to watch out for.`,
	},
	{
		name: "implementer",
		description: "Executes implementation plans by making concrete code changes",
		tools: [],
		prompt:
			`You are an implementation specialist. You execute plans by making concrete code changes.\n\n` +
			`Work autonomously. Use all available tools as needed.\n\n` +
			`Output format when finished:\n\n` +
			`## Completed\n` +
			`What was done.\n\n` +
			`## Files Changed\n` +
			`- path/to/file.ts - what changed\n\n` +
			`## Notes (if any)\n` +
			`Anything the main agent should know.`,
	},
];

// ── result-file helpers (used by both roles) ────────────────────────

interface ResultPayload {
	id: string;
	agent: string;
	parentSessionId: string;
	tmuxWindow: string;
	success: boolean;
	takenOver: boolean;
	stopReason: string;
	summary: string;
	timestamp: number;
}

function unlinkSpawnArtifacts(id: string): void {
	for (const p of [
		path.join(RESULTS_DIR, `${id}.json`),
		path.join(TASKS_DIR, `${id}.md`),
		path.join(TASKS_DIR, `${id}.prompt.md`),
	]) {
		try {
			fs.unlinkSync(p);
		} catch {
			/* missing is fine */
		}
	}
}

// ── child role ──────────────────────────────────────────────────────

function setupChild(pi: ExtensionAPI): void {
	const id = process.env.PI_SUBAGENT_ID;
	const parentSessionId = process.env.PI_SUBAGENT_PARENT;
	const tmuxWindow = process.env.PI_SUBAGENT_WINDOW ?? "";
	const agent = process.env.PI_SUBAGENT_AGENT ?? "";
	if (!id || !parentSessionId) return;

	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	let delivered = false;
	let aborted = false;

	// Allow a new result after the user steers the agent (but not after abort).
	pi.on("agent_start", () => {
		if (!aborted) delivered = false;
	});

	const writeResult = (
		partial: Pick<ResultPayload, "success" | "takenOver" | "stopReason" | "summary">,
	) => {
		if (delivered) return;
		delivered = true;
		const payload: ResultPayload = {
			id,
			agent,
			parentSessionId,
			tmuxWindow,
			timestamp: Date.now(),
			...partial,
		};
		const tmp = path.join(RESULTS_DIR, `.${id}.tmp`);
		const dst = path.join(RESULTS_DIR, `${id}.json`);
		fs.writeFileSync(tmp, JSON.stringify(payload));
		fs.renameSync(tmp, dst);
	};

	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		if (delivered) return;

		const last = [...event.messages]
			.reverse()
			.find((m) => m.role === "assistant") as
			| { role: "assistant"; content: any[]; stopReason?: string }
			| undefined;
		const stopReason = last?.stopReason ?? "unknown";

		const cleanCompletion =
			stopReason === "stop" && !ctx.hasPendingMessages();

		if (cleanCompletion) {
			const summary = (last?.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			writeResult({ success: true, takenOver: false, stopReason, summary });
			ctx.shutdown();
			return;
		}

		// Steer: user sent a message while agent was running.
		// Write takenOver result; agent_start will reset delivered
		// so the next clean completion auto-reports.
		if (ctx.hasPendingMessages()) {
			writeResult({ success: false, takenOver: true, stopReason, summary: "" });
			return;
		}

		// Abort: agent was cancelled (Esc), no pending messages.
		// Register report() tool so the human can explicitly report back.
		aborted = true;
		writeResult({ success: false, takenOver: true, stopReason, summary: "" });

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
				delivered = false; // allow writeResult to supersede the takenOver result
				writeResult({
					success: true,
					takenOver: false,
					stopReason: "report",
					summary: params.summary,
				});
				toolCtx.shutdown();
				return {
					content: [{ type: "text", text: "Reported findings to parent session." }],
				};
			},
		});
	});
}

// ── parent role ─────────────────────────────────────────────────────

function setupParent(pi: ExtensionAPI): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.mkdirSync(TASKS_DIR, { recursive: true });

	const session = tmux("display-message -p '#S'");

	// ── result watcher (single instance across reloads via globalThis) ──

	const seen = ((globalThis as any).__fork_seen ??= new Map<string, { ts: number; takenOver: boolean }>());
	let currentSessionId: string | null = null;

	const tryDeliver = (file: string) => {
		if (!file.endsWith(".json") || file.startsWith(".")) return;
		const full = path.join(RESULTS_DIR, file);
		if (!fs.existsSync(full)) return;

		let data: ResultPayload;
		try {
			data = JSON.parse(fs.readFileSync(full, "utf-8"));
		} catch {
			return;
		}
		if (!data?.id) return;

		// Wrong session (or session_start hasn't fired yet): leave it for
		// the right session to pick up later via primeExisting().
		if (!currentSessionId || data.parentSessionId !== currentSessionId) return;

		// Dedupe with TTL.  Allow re-delivery when a takenOver result is
		// superseded by a real one (user steered after aborting).
		const now = Date.now();
		for (const [k, v] of seen) if (now - v.ts > SEEN_TTL_MS) seen.delete(k);
		const prev = seen.get(data.id);
		if (prev && !(prev.takenOver && !data.takenOver)) {
			unlinkSpawnArtifacts(data.id);
			return;
		}
		seen.set(data.id, { ts: now, takenOver: data.takenOver });

		const content = data.takenOver
			? `Subagent **${data.agent}** (window ${data.tmuxWindow}) was taken over — no findings returned. (stopReason: ${data.stopReason})`
			: `Subagent **${data.agent}** completed:\n\n${data.summary || "(no output)"}`;

		pi.sendMessage(
			{ customType: RESULT_TYPE, content, display: true, details: data },
			{ triggerTurn: true },
		);

		// Close the subagent's tmux window on clean completion.
		// TakenOver windows are still in use by a human — leave them.
		if (!data.takenOver && data.tmuxWindow) {
			try { tmux(`kill-window -t ${session}:${data.tmuxWindow}`); } catch {}
		}

		unlinkSpawnArtifacts(data.id);
	};

	const primeExisting = () => {
		try {
			for (const f of fs.readdirSync(RESULTS_DIR)) tryDeliver(f);
		} catch {
			/* dir missing on first run is fine */
		}
	};

	const prevUnsub = (globalThis as any).__fork_unwatch;
	if (typeof prevUnsub === "function") {
		try {
			prevUnsub();
		} catch {
			/* ignore */
		}
	}
	const watcher = fs.watch(RESULTS_DIR, (_event, name) => {
		if (name) tryDeliver(name);
	});
	(globalThis as any).__fork_unwatch = () => watcher.close();

	pi.on("session_start", (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		primeExisting();
	});

	// ── tool ──

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a subagent as a separate interactive pi session in a new tmux window. " +
			"Returns immediately. Findings are delivered to this session as a follow-up " +
			"message when the subagent finishes. If the user takes over the subagent's " +
			"tmux window (typing, Esc, queued message), no findings are returned.",
		parameters: Type.Object({
			agent: Type.String({
				description:
					"Agent name. Available: " +
					AGENTS.map((a) => `${a.name} — ${a.description}`).join("; "),
			}),
			task: Type.String({ description: "Task for the subagent" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const cfg = AGENTS.find((a) => a.name === params.agent);

			if (!cfg) {
				const list = AGENTS.map((a) => `  ${a.name}: ${a.description}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent "${params.agent}".\nAvailable:\n${list}`,
						},
					],
					isError: true,
				};
			}

			const id = `pi-${cfg.name}-${Date.now().toString(36)}`;
			const taskPath = path.join(TASKS_DIR, `${id}.md`);
			const promptPath = path.join(TASKS_DIR, `${id}.prompt.md`);
			fs.writeFileSync(taskPath, params.task, { mode: 0o600 });
			fs.writeFileSync(promptPath, cfg.prompt, { mode: 0o600 });

			const win = tmux(
				`new-window -t ${session} -n ${id} -c ${ctx.cwd} -P -F '#I'`,
			);
			if (!win) {
				return {
					content: [{ type: "text", text: "Failed to create tmux window." }],
					isError: true,
				};
			}
			tmux(`set-option -t ${session}:${win} -w remain-on-exit off`);

			const env = [
				`PI_SUBAGENT=1`,
				`PI_SUBAGENT_ID=${id}`,
				`PI_SUBAGENT_AGENT=${cfg.name}`,
				`PI_SUBAGENT_PARENT=${currentSessionId ?? ""}`,
				`PI_SUBAGENT_WINDOW=${win}`,
			].join(" ");
			const cmd = [env, "pi", "--append-system-prompt", promptPath];
			if (cfg.tools?.length)
				cmd.push("--tools", [...cfg.tools, "report"].join(","));
			cmd.push(`@${taskPath}`);
			tmux(
				`send-keys -t ${session}:${win} ${JSON.stringify(cmd.join(" "))} Enter`,
			);

			return {
				content: [
					{
						type: "text",
						text: `Spawned ${cfg.name} in tmux window ${win}. Findings will be delivered as a notification when done.`,
					},
				],
			};
		},
	});
}

// ── extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!inTmux()) return;

	if (isSubagent()) {
		setupChild(pi);
		return;
	}
	setupParent(pi);
}
