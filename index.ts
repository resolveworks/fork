/**
 * subagent-tmux — Manage subagents as interactive pi sessions in tmux windows.
 *
 * Everything visible lives in pi's TUI. tmux is invisible plumbing.
 *
 * Commands:  /agents  /switch  /kill-agent  /goto
 * Keys:      Alt+←/→ cycle windows, Alt+1-9 jump to window
 * Tool:      subagent { agent, task }
 *
 * Requires: run pi inside tmux.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

// ── state (ephemeral JSON in /tmp) ──────────────────────────────────

interface AgentEntry {
	id: string;
	name: string;
	task: string;
	window: string; // tmux window index
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
		"agents",  // local repo (./agents/)
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
					model: fm.model,
					prompt: m[2].trim(),
				});
			}
		} catch {
			/* skip unreadable dirs */
		}
	}
	return agents;
}

// ── widget rendering ────────────────────────────────────────────────

function renderWidget(
	agents: AgentEntry[],
	current: string,
	main: string,
): string[] {
	if (agents.length === 0) return [];

	const parts: string[] = [];
	parts.push(current === main ? "▸main" : " main");
	for (const a of agents) {
		const icon = current === a.window ? "▸" : " ";
		const short =
			a.task.length > 25 ? a.task.slice(0, 22) + "…" : a.task;
		parts.push(`${icon}${a.name}: ${short}`);
	}

	return [
		`Agents: ${parts.join("  │ ")}`,
		"Alt+←/→ switch · Alt+1-9 jump · /switch · /kill-agent",
	];
}

// ── extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!inTmux()) {
		pi.registerCommand("agents", {
			description: "Subagent management (requires tmux)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					"Run pi inside tmux to use subagent-tmux.",
					"warn",
				);
			},
		});
		return;
	}

	const session = tmux("display-message -p '#S'");

	// ── keybindings (registered in ALL instances, main + subagent) ──

	pi.registerShortcut("alt+left", {
		description: "Previous tmux window",
		handler: async () => {
			tmux("select-window -t :-");
		},
	});

	pi.registerShortcut("alt+right", {
		description: "Next tmux window",
		handler: async () => {
			tmux("select-window -t :+");
		},
	});

	for (let i = 1; i <= 9; i++) {
		pi.registerShortcut(`alt+${i}`, {
			description: `Go to window ${i}`,
			handler: async () => {
				tmux(`select-window -t :${i}`);
			},
		});
	}

	// Subagent instances get keybindings but nothing else.
	if (isSubagent()) return;

	// ── main instance only from here ──

	const mainWindow = tmux("display-message -p '#I'");
	let agents = pruneStale(session, loadAgents(session));
	saveAgents(session, agents);

	// Cached ctx for widget updates.
	let ctx: any = null;

	function refreshWidget() {
		if (!ctx) return;
		agents = pruneStale(session, loadAgents(session));
		saveAgents(session, agents);
		ctx.ui.setWidget(
			"agents",
			agents.length > 0
				? renderWidget(agents, tmux("display-message -p '#I'"), mainWindow)
				: undefined,
			{ placement: "belowEditor" },
		);
	}

	// ── events ──

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		refreshWidget();
	});
	pi.on("turn_end", async () => refreshWidget());
	pi.on("tool_execution_end", async () => refreshWidget());

	// ── tool ──

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a subagent as a separate interactive pi session in a new tmux window. " +
			"Each subagent has an isolated context and runs autonomously. " +
			"Use /agents to list, /switch <name> to view, /kill-agent <name> to stop.",
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
			const agent = allAgents.find((a) => a.name === params.agent);

			if (!agent) {
				const list =
					allAgents
						.map((a) => `  ${a.name}: ${a.description}`)
						.join("\n") || "  (none found)";
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

			// Write system prompt to temp file (pi reads it via --append-system-prompt)
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-"));
			const promptPath = path.join(tmpDir, `${agent.name}.md`);
			fs.writeFileSync(promptPath, agent.prompt, { mode: 0o600 });

			// Create tmux window
			const id = `pi-${agent.name}-${Date.now().toString(36)}`;
			const win = tmux(
				`new-window -t ${session} -n ${id} -c ${ctx.cwd} -P -F '#I'`,
			);
			if (!win) {
				return {
					content: [{ type: "text", text: "Failed to create tmux window." }],
					isError: true,
				};
			}

			// Build and send pi command
			const cmd = ["PI_SUBAGENT=1", "pi"];
			cmd.push("--append-system-prompt", promptPath);
			if (agent.model) cmd.push("--model", agent.model);
			if (agent.tools?.length) cmd.push("--tools", agent.tools.join(","));
			cmd.push("-p", JSON.stringify(params.task));
			tmux(
				`send-keys -t ${session}:${win} ${JSON.stringify(cmd.join(" "))} Enter`,
			);

			// Track
			agents = loadAgents(session);
			agents.push({
				id,
				name: agent.name,
				task: params.task,
				window: win,
				started: Date.now(),
			});
			saveAgents(session, agents);
			refreshWidget();

			return {
				content: [
					{
						type: "text",
						text: `Spawned ${agent.name} (window ${win}). Use /switch ${agent.name} or Alt+Right to view.`,
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

	pi.registerCommand("switch", {
		description: "Switch to an agent ('main' or agent name)",
		handler: async (args, ctx) => {
			agents = pruneStale(session, loadAgents(session));
			saveAgents(session, agents);

			if (!args) {
				const choices = [
					`main (window ${mainWindow})`,
					...agents.map(
						(a) =>
							`${a.name} (win ${a.window}): ${a.task.slice(0, 40)}`,
					),
				];
				const pick = await ctx.ui.select("Switch to:", choices);
				if (!pick) return;
				const idx = choices.indexOf(pick);
				tmux(
					`select-window -t ${session}:${idx === 0 ? mainWindow : agents[idx - 1].window}`,
				);
				return;
			}

			if (args === "main") {
				tmux(`select-window -t ${session}:${mainWindow}`);
			} else {
				const a = agents.find(
					(a) => a.name === args || a.id === args,
				);
				if (a) tmux(`select-window -t ${session}:${a.window}`);
				else ctx.ui.notify(`Unknown agent: ${args}`, "error");
			}
		},
	});

	pi.registerCommand("kill-agent", {
		description: "Kill a subagent window",
		handler: async (args, ctx) => {
			agents = pruneStale(session, loadAgents(session));

			let target: AgentEntry | undefined;
			if (args) {
				target = agents.find(
					(a) => a.name === args || a.id === args,
				);
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
			agents = agents.filter((a) => a.id !== target!.id);
			saveAgents(session, agents);
			refreshWidget();
			ctx.ui.notify(`Killed ${target.name}`, "info");
		},
	});

	pi.registerCommand("goto", {
		description: "Go to main window",
		handler: async () => {
			tmux(`select-window -t ${session}:${mainWindow}`);
		},
	});
}
