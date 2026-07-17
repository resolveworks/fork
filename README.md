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

The parent LLM gets a **spawn** tool. Calling it opens a new tmux window running pi with the given task and returns immediately. The child gets a terminal **complete_task** tool. When the delegated task is complete, the child calls it with the final result intended for the parent. That payload is sent over a Unix socket and delivered as a notification that triggers a new parent turn; the child then closes.

A spawned task resolves at most once. `complete_task` is not a progress-reporting tool and ordinary interactive answers in the child remain local. Interrupting a child has no reporting semantics; the child should complete only when its delegated task is done or when the user explicitly asks it to return its current findings.

If socket delivery fails or times out, the child stays open, displays an error, and can retry `complete_task` with the same result. The parent atomically accepts only the first result, which also makes retries safe after an ambiguous socket failure.

Use tmux keybindings (`Ctrl+B n/p/1-9`, etc.) to navigate between windows.
