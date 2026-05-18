# AGENTS.md

## Overview

**fork** is a [pi](https://github.com/earendil-works/pi) extension that manages subagents as separate interactive pi sessions in tmux windows. The LLM calls a single `plan` tool; when the plan completes, fork mechanically spawns implement and review agents for each step in sequence. Results flow back to the parent as notification messages.

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
├── index.ts          # The entire extension (single file)
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

- **Parent role** (`setupParent`): Registers the `plan` tool for the LLM and listens on a per-session Unix domain socket for result messages from children. When a child completes, `deliverResult` drives the pipeline mechanically.
- **Child role** (`setupChild`): Registers agent-specific tools plus a completion tool (`implement`, `commit`, or `review` depending on the agent). When the agent calls its completion tool, the child sends a JSON result line over the socket and shuts down.

Communication is socket-based: each parent listens on `~/.pi/agent/extensions/fork/sockets/<parentSessionId>.sock` (mode 0o600). Children connect, write one newline-delimited JSON `ResultPayload` (or `ReviewResultPayload` for review agents), and close.

### Agents

Three agents are defined as plain objects conforming to the `Agent<P>` interface near the top of `index.ts`:

- **plan** — The only agent accessible to the LLM. Read-only planning specialist. Uses dedicated `write_plan` and `write_step` tools to write `plans/<slug>/plan.md` (overview) and `plans/<slug>/step-NNN.md` (one per step).
- **implement** — Spawns mechanically after planning. Executes a single step. Reads `plans/<slug>/plan.md` for overview context and `plans/<slug>/step-NNN.md` for the specific step. The `plan` param is a slug (e.g. `dark-mode`); paths are constructed internally.
- **review** — Spawns mechanically after each implementation. Read-only code review specialist. Reads the same plan/step files and reviews the latest commit (`git show HEAD`) against the step's acceptance criteria.

### Key Types

- `Agent<P>` — plain object interface for an agent definition (name, description, tools, params, systemPrompt, formatTask)
- `State` — mutable bag closed over by parent functions: `{ session, sessionId, active, pipeline }`
- `ResultPayload` — JSON sent by plan and implement children: `{ id }`
- `ReviewResultPayload` — extends `ResultPayload` with `verdict: "pass" | "changes-needed"`, sent by review children
- `PipelineState` — tracks the mechanical pipeline: `{ slug, totalSteps, currentStep, cwd }`

### Lifecycle

1. LLM calls the `plan` tool → parent writes the task file, creates a tmux window, and `send-keys` a `pi --agent plan ...` command into it
2. Child starts in an isolated pi session, applies the plan system prompt via `before_agent_start`, and reads the task from the task file
3. Plan agent writes plan.md and step files, then calls `implement` → sends `{ id }` over the socket
4. `deliverResult` sees a plan agent completed → calls `startPipeline`, which reads the plan directory to count steps and spawns an implement agent for step 1
5. Implement agent makes changes and calls `commit` (stages + commits) → `deliverResult` sees an implement agent completed → spawns a review agent for that step
6. Review agent calls `review` with its verdict and issues → sends `ReviewResultPayload { id, verdict }` over the socket
7. `deliverResult` sees a review agent completed:
   - If verdict is `"pass"`: advances to next step (spawns implement) or completes the pipeline if all steps done
   - If verdict is `"changes-needed"`: stops the pipeline and notifies the LLM
8. Clean completions automatically close the subagent's tmux window and remove its task file

### Lifecycle hooks

Setup and teardown ride pi's own events: the socket server is created in `session_start` and closed (with its socket file unlinked) in `session_shutdown`. `session_shutdown` fires on `quit`, `reload`, `new`, `resume`, and `fork` — every case where the extension instance is torn down — so no `globalThis` bookkeeping is needed to survive hot reloads. Each extension instance owns its own server in a closure. Stale sockets from a crashed prior process are not preemptively removed; `listen` will throw `EADDRINUSE` and the user clears the file.

## Shared Paths

All runtime state lives under `~/.pi/agent/extensions/fork/`:
- `sockets/` — per-parent Unix domain sockets (`<parentSessionId>.sock`, mode 0o600)
- `tasks/` — task message files handed to children at spawn (mode 0o600)

Plan files live in the working directory:
- `plans/<slug>/plan.md` — plan overview (mode 0o600)
- `plans/<slug>/step-NNN.md` — individual step files (mode 0o600)

The plan directory defaults to `plans/` but can be overridden with the `FORK_PLANS_DIR` environment variable.

## Conventions

- **Single-file extension.** Everything lives in `index.ts`. If the file grows, consider splitting but keep the pi extension entry as the default export.
- **Agent definitions** are plain objects near the top of `index.ts`. No classes, no registry.
- **No build step.** pi loads `.ts` files directly via its runtime.
- **No tests currently.** If adding tests, note the heavy tmux dependency would need mocking.
- **Error handling** follows fail-fast: if something is wrong, throw or crash with a clear message. No silent catches, no empty-string fallbacks. If tmux isn't available, say so and fail.
- **File permissions:** Task files are written with mode `0o600` (user-only read/write).

## Making Changes

- To modify an agent: edit its object literal in `index.ts`.
- To modify tool behavior: edit the `execute` callback in the corresponding `registerTool` call.
- To change the pipeline: edit `deliverResult`, `startPipeline`, or `spawnImplementStep`.
- To change result delivery: edit `deliverResult` (parent) or the completion tool (`implement`/`commit`/`review`) in `setupChild` (child).

## Install & Run

```bash
# Install as a pi extension
pi install git:github.com/johan/fork

# Or try without installing
pi -e git:github.com/johan/fork
```

Must be run inside tmux. If not in tmux, the extension does nothing.
