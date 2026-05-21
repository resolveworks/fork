# AGENTS.md

**fork** is a [pi](https://github.com/earendil-works/pi) extension that spawns subagents as pi sessions in separate tmux windows.

The extension exposes a single `spawn` tool. It opens a new tmux window running pi with the given task, awaits the child's result over a Unix socket, and returns the summary as the tool result.

Everything lives in `index.ts` — start at the default export.

## Philosophy

Fail-fast. No defensive programming, no fallbacks, no silent catches. Missing config or unmet prerequisites should crash with a clear message, not be papered over with defaults.

## Requirements

- **tmux.** The extension no-ops outside tmux.
- **Runtime state** lives under `~/.pi/agent/extensions/fork/`:
  - `sockets/` — per-parent Unix sockets, mode `0o600`
  - `tasks/` — per-id task files handed to children at spawn via pi's `@<path>` argument, mode `0o600`
