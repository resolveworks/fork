# AGENTS.md

## Overview

**fork** is a [pi](https://github.com/earendil-works/pi) extension that manages subagents as separate interactive pi sessions in tmux windows. When the LLM calls the `subagent` tool, fork spawns a new tmux window running a full pi session with an isolated context window. Results flow back to the parent as notification messages when a subagent completes.

## Project Structure

```
.
├── index.ts          # The entire extension (single file, ~475 lines)
├── agents/           # Built-in agent definitions (markdown + YAML frontmatter)
│   ├── scout.md      # Fast codebase recon, returns compressed context
│   ├── planner.md    # Creates implementation plans (read-only)
│   ├── worker.md     # General-purpose agent with full tool access
│   └── reviewer.md   # Code review (read-only bash: git diff, git log, etc.)
├── package.json      # Declares the extension via pi.extensions field
└── README.md
```

## Tech Stack

- **Language:** TypeScript (ESM)
- **Runtime:** Node.js (via pi's embedded runtime)
- **Dependency:** `@earendil-works/pi-coding-agent` (ExtensionAPI types), `typebox` (parameter schemas)
- **Platform requirement:** tmux — the extension does nothing outside tmux

## Architecture

### Parent/Child Model

The extension entry point (`export default function`) checks the environment and branches:

- **Parent role** (`setupParent`): Registers the `subagent` tool, `/agents` and `/kill-agent` commands, and watches for result files from children.
- **Child role** (`setupChild`): Listens for `agent_end` events and writes a JSON result file that the parent picks up.

Communication is file-based: children write to `~/.pi/agent/extensions/fork/results/<id>.json`, parents watch that directory with `fs.watch`.

### Agent Discovery

Agents are discovered from three directories (in order):
1. `~/.pi/agent/agents/` (user-global)
2. `.pi/agents/` (project-local)
3. `agents/` (this repo's built-ins)

Each agent is a `.md` file with YAML frontmatter (`name`, `description`, `tools`) and a markdown body that becomes the system prompt.

### Key Types

- `AgentConfig` — parsed agent definition (name, description, tools, prompt)
- `AgentEntry` — runtime state for a spawned subagent (id, window, parent session)
- `ResultPayload` — JSON written by child on completion (success, takenOver, summary)

### Lifecycle

1. LLM calls `subagent` tool → parent writes task file, creates tmux window, sends `pi` command with `--append-system-prompt` and `--tools`
2. Child runs in isolated pi session with `PI_SUBAGENT=1` env vars
3. On `agent_end`: if clean completion (`stopReason === "stop"` + no pending messages), child writes success result and shuts down. Otherwise writes `takenOver: true` and stays alive as interactive pi.
4. Parent's `fs.watch` picks up result file → delivers `fork-result` notification → triggers new parent turn
5. Stale entries (dead tmux windows) are pruned on load

### Reload Safety

The extension uses `globalThis` to persist the `fs.watch` handle and deduplication map across hot reloads within the same pi session.

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | List running subagents with name, window, and task |
| `/kill-agent [name]` | Kill a subagent (picker if no name given, direct if name provided) |

## Shared Paths

All runtime state lives under `~/.pi/agent/extensions/fork/`:
- `results/` — JSON result files (child → parent communication)
- `tasks/` — task prompts and system prompts for spawned agents
- `/tmp/pi-agents-<session>.json` — ephemeral agent registry per tmux session

## Conventions

- **Single-file extension.** Everything lives in `index.ts`. If the file grows, consider splitting but keep the pi extension entry as the default export.
- **Agent definitions** use simple YAML frontmatter parsing (not a library). Fields: `name`, `description`, `tools` (comma-separated), `model` (optional).
- **No build step.** pi loads `.ts` files directly via its runtime.
- **No tests currently.** If adding tests, note the heavy tmux dependency would need mocking.
- **Error handling** is defensive — most failures return empty strings or silently catch, since tmux may not be available.
- **File permissions:** Task files are written with mode `0o600` (user-only read/write).

## Making Changes

- To add a new agent: create a `.md` file in `agents/` with the frontmatter format shown above.
- To modify tool behavior: edit the `execute` callback in `setupParent`'s `registerTool` call.
- To change result delivery: edit `tryDeliver` in `setupParent` or `writeResult` in `setupChild`.
- To add a new command: use `pi.registerCommand()` in `setupParent`.

## Install & Run

```bash
# Install as a pi extension
pi install git:github.com/johan/fork

# Or try without installing
pi -e git:github.com/johan/fork
```

Must be run inside tmux. If not in tmux, the extension registers a stub `/agents` command that warns the user.
