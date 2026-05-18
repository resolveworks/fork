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

The LLM has access to one tool: **plan**. When called, fork spawns a planning agent in a new tmux window. When the plan completes, fork automatically runs the full pipeline:

1. **Plan** — writes `plans/<slug>/plan.md` and step files
2. **Implement** — for each step, spawns an implementer that commits the change
3. **Review** — after each implementation, spawns a reviewer that checks the commit against the step's acceptance criteria

Steps are implemented sequentially. If a review fails, the pipeline stops and the LLM is notified. When all steps pass review, the LLM receives a success summary.

The LLM only needs to call `plan` — everything else runs mechanically.

Use tmux keybindings (`Ctrl+B n/p/1-9`, etc.) to navigate between windows.

### Result delivery

When a subagent completes, it sends a result over a Unix domain socket. The parent processes results and continues the pipeline automatically. Notifications are delivered to the LLM at key points: each implementation, each review, and final success or failure.

If you take over a subagent's tmux window (by typing or pressing Esc), it stays alive as a regular interactive pi session and the pipeline stalls.

## Agents

Three agents are hardcoded in `index.ts`:

- **plan** — The only agent accessible to the LLM. Read-only planning specialist. Writes `plans/<slug>/plan.md` (overview) and `plans/<slug>/step-NNN.md` (one per step) via dedicated `write_plan`/`write_step` tools.
- **implement** — Spawns automatically after planning. Executes a single step and commits on the current branch.
- **review** — Spawns automatically after each implementation. Reads plan/step files and reviews the latest commit (`git show HEAD`) against the step's acceptance criteria.
