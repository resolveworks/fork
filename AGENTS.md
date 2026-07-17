# AGENTS.md

**fork** is a [pi](https://github.com/earendil-works/pi) extension that spawns subagents as pi sessions in separate tmux windows.

The extension exposes a `spawn` tool to parent sessions. Calling it opens a new tmux window running pi with the given task and returns immediately. Child sessions get a terminal `complete_task` tool; its explicit result payload is sent back over a Unix socket and delivered as a notification that triggers a new parent turn.

Everything lives in `index.ts` — start at the default export.

## Requirements

- **tmux.** The extension silently no-ops outside tmux.
- **Runtime state** lives under `~/.pi/agent/extensions/fork/`:
  - `sockets/` — per-parent Unix sockets, mode `0o600`
  - `tasks/` — per-id task files handed to children at spawn via pi's `@<path>` argument, mode `0o600`
