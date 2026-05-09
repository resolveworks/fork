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
 * Commands:  /agents  /kill-agent
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

// ── state (ephemeral JSON in /tmp) ──────────────────────────────────

interface AgentEntry {
	id: string;
	name: string;
	task: string;
	window: string; // tmux window index
	parentSessionId: string;
	started: number;
}

function statePath(session: string): string {
	return path.join(os.tmpdir(), `pi-agents-${session}.json`);
}

function loadAgents(session: string): AgentEntry[] {
	try {
		return JSON.parse(fs.readFileSync(statePath(session), "utf-8"));
	} catch {
		return [];
	}
}

function saveAgents(session: string, agents: AgentEntry[]): void {
	fs.writeFileSync(statePath(session), JSON.stringify(agents, null, 2));
}

/** Remove entries whose tmux window no longer exists. */
function pruneStale(session: string, agents: AgentEntry[]): AgentEntry[] {
	const alive = new Set(
		tmux(`list-windows -t ${session} -F '#I'`)
			.split("\n")
			.filter(Boolean),
	);
	return agents.filter((a) => alive.has(a.window));
}

// ── agent discovery (frontmatter .md files) ─────────────────────────

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	prompt: string;
}

function discoverAgents(): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const dirs = [
		path.join(os.homedir(), ".pi", "agent", "agents"),
		".pi/agents",
		"agents", // local repo (./agents/)
	];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const raw = fs.readFileSync(path.join(dir, entry.name), "utf-8");
				const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
				if (!m) continue;

				const fm: Record<string, string> = {};
				for (const line of m[1].split("\n")) {
					const i = line.indexOf(":");
					if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
				}
				if (!fm.name || !fm.description) continue;

				agents.push({
					name: fm.name,
					description: fm.description,
					tools: fm.tools
						?.split(",")
						.map((t) => t.trim())
						.filter(Boolean),
					prompt: m[2].trim(),
				});
			}
		} catch {
			/* skip unreadable dirs */
		}
	}
	return agents;
}

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

	// Allow a new result after the user steers the agent following an abort.
	pi.on("agent_start", () => {
		delivered = false;
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

		// Anything else (aborted, error, length, pending messages, missing
		// last message, unknown stopReason) → human took over OR something
		// weird happened. Fail safe: tell parent, stay alive.
		writeResult({ success: false, takenOver: true, stopReason, summary: "" });
		// No ctx.shutdown(): child stays alive as interactive pi.
	});
}

// ── parent role ─────────────────────────────────────────────────────

function setupParent(pi: ExtensionAPI): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.mkdirSync(TASKS_DIR, { recursive: true });

	const session = tmux("display-message -p '#S'");

	let agents = pruneStale(session, loadAgents(session));
	saveAgents(session, agents);

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

		// Drop the spawn record from /tmp state too.
		agents = loadAgents(session).filter((a) => a.id !== data.id);
		saveAgents(session, agents);

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
			"tmux window (typing, Esc, queued message), no findings are returned. " +
			"Use /agents to list, /kill-agent <name> to stop.",
		parameters: Type.Object({
			agent: Type.String({
				description:
					"Agent name. Available: " +
					discoverAgents()
						.map((a) => `${a.name} — ${a.description}`)
						.join("; "),
			}),
			task: Type.String({ description: "Task for the subagent" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const allAgents = discoverAgents();
			const cfg = allAgents.find((a) => a.name === params.agent);

			if (!cfg) {
				const list =
					allAgents.map((a) => `  ${a.name}: ${a.description}`).join("\n") ||
					"  (none found)";
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
			if (cfg.tools?.length) cmd.push("--tools", cfg.tools.join(","));
			cmd.push(`@${taskPath}`);
			tmux(
				`send-keys -t ${session}:${win} ${JSON.stringify(cmd.join(" "))} Enter`,
			);

			agents = loadAgents(session);
			agents.push({
				id,
				name: cfg.name,
				task: params.task,
				window: win,
				parentSessionId: currentSessionId ?? "",
				started: Date.now(),
			});
			saveAgents(session, agents);

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

	// ── commands ──

	pi.registerCommand("agents", {
		description: "List running subagents",
		handler: async (_args, ctx) => {
			agents = pruneStale(session, loadAgents(session));
			saveAgents(session, agents);
			if (agents.length === 0) {
				ctx.ui.notify("No subagents running.", "info");
				return;
			}
			const lines = agents.map(
				(a) => `  ${a.name} (win ${a.window}): ${a.task.slice(0, 60)}`,
			);
			ctx.ui.notify(`Subagents:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("kill-agent", {
		description: "Kill a subagent window",
		handler: async (args, ctx) => {
			agents = pruneStale(session, loadAgents(session));

			let target: AgentEntry | undefined;
			if (args) {
				target = agents.find((a) => a.name === args || a.id === args);
			} else if (agents.length > 0) {
				const choices = agents.map(
					(a) => `${a.name} (win ${a.window}): ${a.task.slice(0, 40)}`,
				);
				const pick = await ctx.ui.select("Kill:", choices);
				if (pick) target = agents[choices.indexOf(pick)];
			}

			if (!target) {
				ctx.ui.notify("No agent to kill.", "error");
				return;
			}

			try {
				tmux(`kill-window -t ${session}:${target.window}`);
			} catch {
				/* already gone */
			}
			// Remove any pending result file so the parent doesn't get a phantom
			// notification later.
			unlinkSpawnArtifacts(target.id);
			agents = agents.filter((a) => a.id !== target!.id);
			saveAgents(session, agents);
			ctx.ui.notify(`Killed ${target.name}`, "info");
		},
	});
}

// ── extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!inTmux()) {
		pi.registerCommand("agents", {
			description: "Subagent management (requires tmux)",
			handler: async (_args, ctx) => {
				ctx.ui.notify("Run pi inside tmux to use fork.", "warn");
			},
		});
		return;
	}

	if (isSubagent()) {
		setupChild(pi);
		return;
	}
	setupParent(pi);
}
