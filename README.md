# fork

A [pi](https://github.com/earendil-works/pi) extension that spawns subagents as separate pi sessions in tmux windows.

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

The LLM gets one tool: **spawn**. Calling it opens a new tmux window running pi with the given task and returns immediately. When the child finishes, its final message is sent back over a Unix socket and delivered as a notification that triggers a new turn.

Use tmux keybindings (`Ctrl+B n/p/1-9`, etc.) to navigate between windows.

Steering or follow-up input typed into a subagent's window becomes part of its delegated run and may shape the result that is eventually returned. Pressing Esc aborts the current delegated run, so that run is not reported back automatically; the subagent stays available as a regular interactive pi session.
