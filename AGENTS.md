# AGENTS.md

## Overview

**fork** is a [pi](https://github.com/earendil-works/pi) extension that manages subagents as separate interactive pi sessions in tmux windows. When the LLM calls the `subagent` tool, fork spawns a new tmux window running a full pi session with an isolated context window. Results flow back to the parent as notification messages when a subagent completes.

## Project Structure

```
.
├── index.ts          # The entire extension (single file, ~400 lines)
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

- **Parent role** (`setupParent`): Registers the `subagent` tool and watches for result files from children.
- **Child role** (`setupChild`): Listens for `agent_end` events and writes a JSON result file that the parent picks up.

Communication is file-based: children write to `~/.pi/agent/extensions/fork/results/<id>.json`, parents watch that directory with `fs.watch`.

### Agents

Two agents are hardcoded in `index.ts`:

- **planner** — Read-only planning specialist. Receives context and requirements, then produces a clear implementation plan.
- **implementer** — Executes plans by making concrete code changes. Has full tool access.

This keeps the interplay between them tightly controlled and easy to iterate on.

### Key Types

- `AgentConfig` — hardcoded agent definition (name, description, tools, prompt)
- `ResultPayload` — JSON written by child on completion (success, takenOver, summary)

### Lifecycle

1. LLM calls `subagent` tool → parent writes task file, creates tmux window, sends `pi` command with `--append-system-prompt` and `--tools`
2. Child runs in isolated pi session with `PI_SUBAGENT=1` env vars
3. On `agent_end`: if clean completion (`stopReason === "stop"` + no pending messages), child writes success result and shuts down. Otherwise writes `takenOver: true` and stays alive as interactive pi.
4. Parent's `fs.watch` picks up result file → delivers `fork-result` notification → triggers new parent turn
5. Clean completions automatically close the subagent's tmux window

### Reload Safety

The extension uses `globalThis` to persist the `fs.watch` handle and deduplication map across hot reloads within the same pi session.

## Shared Paths

All runtime state lives under `~/.pi/agent/extensions/fork/`:
- `results/` — JSON result files (child → parent communication)
- `tasks/` — task prompts and system prompts for spawned agents

## Conventions

- **Single-file extension.** Everything lives in `index.ts`. If the file grows, consider splitting but keep the pi extension entry as the default export.
- **Agent definitions** are hardcoded in the `AGENTS` array near the top of `index.ts`.
- **No build step.** pi loads `.ts` files directly via its runtime.
- **No tests currently.** If adding tests, note the heavy tmux dependency would need mocking.
- **Error handling** is defensive — most failures return empty strings or silently catch, since tmux may not be available.
- **File permissions:** Task files are written with mode `0o600` (user-only read/write).

## Making Changes

- To modify an agent: edit its entry in the `AGENTS` array in `index.ts`.
- To modify tool behavior: edit the `execute` callback in `setupParent`'s `registerTool` call.
- To change result delivery: edit `tryDeliver` in `setupParent` or `writeResult` in `setupChild`.


## Install & Run

```bash
# Install as a pi extension
pi install git:github.com/johan/fork

# Or try without installing
pi -e git:github.com/johan/fork
```

Must be run inside tmux. If not in tmux, the extension does nothing.
