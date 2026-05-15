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

If an agent definition omits `tools`, the subagent gets full tool access. Otherwise it is limited to the listed tools plus `report` (for manual reporting after abort).

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | List running subagents |
| `/kill-agent` | Picker to kill (`/kill-agent planner` for direct) |

## Agents

Agent definitions live in `agents/` as markdown files with YAML frontmatter:

```markdown
---
name: reviewer
description: Reviews implementation with fresh eyes
tools: read, grep, find, ls, bash
---

You are a code reviewer...
```

Three agents are included: **planner**, **implementer**, **reviewer**. Add your own by dropping `.md` files into `agents/`.

Agents are discovered from three directories (first match wins):
1. `~/.pi/agent/agents/` (user-global)
2. `.pi/agents/` (project-local)
3. `agents/` (built-in)
