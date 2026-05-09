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

When the LLM calls the `subagent` tool, fork spawns a new tmux window running a full interactive pi session with the agent's own system prompt, model, and tools. Each subagent has an isolated context window.

Use tmux keybindings (`Ctrl+B n/p/1-9`, etc.) to navigate between windows.

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | List running subagents |
| `/kill-agent` | Picker to kill (`/kill-agent scout` for direct) |

## Agents

Agent definitions live in `agents/` as markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---

You are a scout...
```

Four agents are included: **scout**, **planner**, **worker**, **reviewer**. Add your own by dropping `.md` files into `agents/`.

The extension also discovers agents from `~/.pi/agent/agents/` and `.pi/agents/`.
