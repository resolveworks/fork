# AGENTS.md

## Overview

**fork** is a [pi](https://github.com/earendil-works/pi) extension that manages subagents as separate interactive pi sessions in tmux windows. When the LLM calls the `subagent` tool, fork spawns a new tmux window running a full pi session with an isolated context window. Results flow back to the parent as notification messages when a subagent completes.

## Philosophy

This project follows a **fail-fast** philosophy:

- **No defensive programming.** Don't anticipate and silently swallow failures. If something is wrong, crash loudly.
- **No fallbacks.** If an environment variable or config is missing, that's a bug — not an opportunity for a default. Error immediately and tell the user what they forgot.
- **No backward compatibility.** We don't maintain old behavior or migration paths. Break things cleanly and move forward.
- **Explicit over implicit.** Dependencies, requirements, and failure modes should be obvious from the code — not hidden behind defaults or `try/catch` blocks that eat errors.

If you're adding error handling: ask yourself whether the error represents a programmer mistake or a missing prerequisite. If so, throw or crash — don't recover.

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

- **Parent role** (`setupParent`): Registers one tool per agent and listens on a per-session Unix domain socket for result messages from children.
- **Child role** (`setupChild`): Listens for `agent_end` events and sends a JSON result line over the socket address it was given at spawn.

Communication is socket-based: each parent listens on `~/.pi/agent/extensions/fork/sockets/<parentSessionId>.sock` (mode 0o600). Children connect, write one newline-delimited JSON `ResultPayload`, and close. Per-parent socket scoping replaces the previous shared results directory.

### Agents

Three agents are hardcoded in the `AGENTS` array in `index.ts`:

- **planner** — Read-only planning specialist.
- **implementer** — Executes plans with code changes.
- **reviewer** — Read-only code review specialist.

This keeps the interplay between them tightly controlled and easy to iterate on.

### Key Types

- `SubAgent<P, R>` — base class for an agent definition (name, description, tools, system prompt, task formatter, result extractor)
- `ResultPayload` — JSON sent by child on completion or takeover (id, agent, tmuxWindow, success, takenOver, stopReason, summary, timestamp)

### Lifecycle

1. LLM calls an agent's tool → parent writes the task file, creates a tmux window, and `send-keys` a `pi --agent <name> --subagent-id <id> --subagent-socket <path> --subagent-window <win> @<taskPath>` command into it
2. Child starts in an isolated pi session, applies the agent's system prompt via `before_agent_start`, and reads the task from the task file
3. On `agent_end`: if clean completion (`stopReason === "stop"` + no pending messages), child sends a success `ResultPayload` over the socket and shuts down. If the human interrupted, child sends `takenOver: true` and stays alive as an interactive pi (with a `report` tool if the run was aborted).
4. Parent's socket connection handler parses the JSON line and delivers a `fork-result` notification → triggers a new parent turn
5. Clean completions automatically close the subagent's tmux window and remove its task file

### Reload Safety

The extension uses `globalThis.__fork_server` (and the matching `__fork_server_path`) to remember the listening socket across hot reloads within the same pi process. On reload, the previous server is closed and its socket file unlinked before the new one starts listening. Cleanup is for *known* prior state we placed there — stale sockets from a crashed prior process are not preemptively removed; `listen` will throw `EADDRINUSE` and the user clears the file.

## Shared Paths

All runtime state lives under `~/.pi/agent/extensions/fork/`:
- `sockets/` — per-parent Unix domain sockets (`<parentSessionId>.sock`, mode 0o600)
- `tasks/` — task message files handed to children at spawn (mode 0o600)

## Conventions

- **Single-file extension.** Everything lives in `index.ts`. If the file grows, consider splitting but keep the pi extension entry as the default export.
- **Agent definitions** are hardcoded in the `AGENTS` array near the top of `index.ts`.
- **No build step.** pi loads `.ts` files directly via its runtime.
- **No tests currently.** If adding tests, note the heavy tmux dependency would need mocking.
- **Error handling** follows fail-fast: if something is wrong, throw or crash with a clear message. No silent catches, no empty-string fallbacks. If tmux isn't available, say so and fail.
- **File permissions:** Task files are written with mode `0o600` (user-only read/write).

## Making Changes

- To modify an agent: edit its entry in the `AGENTS` array in `index.ts`.
- To modify tool behavior: edit the `execute` callback in `setupParent`'s `registerTool` call.
- To change result delivery: edit `Dispatcher.deliverResult` (parent) or `sendResult` in `setupChild` (child).


## Install & Run

```bash
# Install as a pi extension
pi install git:github.com/johan/fork

# Or try without installing
pi -e git:github.com/johan/fork
```

Must be run inside tmux. If not in tmux, the extension does nothing.
