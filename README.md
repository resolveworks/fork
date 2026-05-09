# fork

A [pi](https://github.com/earendil-works/pi) extension for managing subagents as separate interactive pi sessions in tmux windows. Everything lives in pi's TUI — tmux is invisible plumbing.

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

A widget below the editor shows all running agents:

```
Agents: ▸main │ ⏳scout: find auth code │  worker: implement cache
Alt+←/→ switch · Alt+1-9 jump · /switch · /kill-agent
```

## Keybindings

| Key | Action |
|-----|--------|
| `Alt+←` / `Alt+→` | Cycle through tmux windows |
| `Alt+1` – `Alt+9` | Jump to window by number |

Work from both the main and subagent windows.

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | List running subagents |
| `/switch` | Picker to switch (`/switch scout` for direct) |
| `/kill-agent` | Picker to kill (`/kill-agent scout` for direct) |
| `/goto` | Jump back to main window |

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
