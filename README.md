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

The parent LLM gets **spawn_agent**, **message_agent**, and **close_agent** tools. Calling `spawn_agent` opens a new tmux window running pi with the given task and returns immediately. When the child believes its delegated task is complete, it calls **report_result** with a report for the parent. That payload is sent over a Unix socket and delivered as a notification that triggers a new parent turn — and the child stays alive awaiting the verdict. The parent reviews the report, requests revisions with **message_agent** (delivered as an ordinary turn in the child, which reports again), and closes the child with **close_agent** when the work is accepted.

`report_result` is not a progress-reporting tool and ordinary interactive answers in the child remain local. Interrupting a child has no reporting semantics; the child should report only when it believes its delegated task is done or when the user explicitly asks it to return its current findings.

If socket delivery fails or times out, the child displays an error and retries `report_result` with the same result. Delivery failures are unambiguous in practice, so a retry cannot deliver a report twice.

If a parent exits with children still alive, their tmux windows linger; kill the windows (and remove their task files under `~/.pi/agent/extensions/fork/tasks/`) by hand.

Use tmux keybindings (`Ctrl+B n/p/1-9`, etc.) to navigate between windows.
