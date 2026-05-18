# fork

A [pi](https://github.com/earendil-works/pi) extension for managing subagents as separate interactive pi sessions in tmux windows.

Sessions are opened in the tmux session shared by the main agent. All window management (switching, cycling, jumping) is handled by tmux directly.

## Requirements

- tmux
- Run pi inside tmux

## Install

```bash
pi install git:github.com/johan/fork
```

Or try without installing:

```bash
pi -e git:github.com/johan/fork
```

## How it works

When the LLM calls the `subagent` tool, fork spawns a new tmux window running a full interactive pi session with the agent's own system prompt and tools. Each subagent has an isolated context window.

Use tmux keybindings (`Ctrl+B n/p/1-9`, etc.) to navigate between windows.

### Result delivery

When a subagent completes cleanly, its findings are delivered to the parent session as a notification and the tmux window is closed. If you take over a subagent's window (by typing or pressing Esc), it stays alive as a regular interactive pi session and no findings are returned. An aborted subagent registers a `report` tool so you can explicitly send findings back when ready.

### Tool access

If an agent definition has no `tools` specified, the subagent inherits pi's full default tool set. Otherwise it is limited to the listed tools plus `report` (for manual reporting after abort).

## Agents

Three agents are hardcoded in `index.ts`:

- **plan** — Read-only planning specialist. Writes `plans/<slug>/plan.md` (overview) and `plans/<slug>/step-NNN.md` (one per step) via dedicated `write_plan`/`write_step` tools.
- **implement** — Executes a single step. Reads `plans/<slug>/plan.md` for overview context and `plans/<slug>/step-NNN.md` for the specific step to implement. Commits on the current branch.
- **review** — Read-only code review specialist. Reads the same plan/step files and reviews the commit against the step's acceptance criteria.
