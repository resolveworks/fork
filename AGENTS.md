# AGENTS.md

**fork** is a [pi](https://github.com/earendil-works/pi) extension that spawns subagents as pi sessions in separate tmux windows.

The extension exposes `spawn_agent`, `message_agent`, and `close_agent` tools to parent sessions. Calling `spawn_agent` opens a new tmux window running pi with the given task and returns immediately. Child sessions get a `report_result` tool; its report payload is sent back over a Unix socket and delivered as a notification that triggers a new parent turn. Children stay alive after reporting: the parent reviews, requests revisions with `message_agent`, and closes them with `close_agent`.

Everything lives in `index.ts` — start at the default export.

## Requirements

- **tmux.** The extension silently no-ops outside tmux.
- **Runtime state** lives under `~/.pi/agent/extensions/fork/`:
  - `sockets/` — per-parent Unix sockets, mode `0o600`
  - `agents/` — per-child Unix sockets (verdict channel), mode `0o600`
  - `tasks/` — per-id task files handed to children at spawn via pi's `@<path>` argument, mode `0o600`; a present task file marks an open agent and persists until `close_agent`
- **Orphan policy:** none. If a parent exits with children alive, their tmux windows linger; kill the windows and remove their task files by hand.
