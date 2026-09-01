# AGENTS.md

**fork** is a [pi](https://github.com/earendil-works/pi) extension that spawns subagents as pi sessions in separate tmux windows.

The extension exposes `spawn_agent`, `message_agent`, and `close_agent` tools to parent sessions. Calling `spawn_agent` opens a new tmux window running pi with the given task and returns immediately. It shares the parent's working tree by default; an optional `branch` creates an isolated Git worktree on a new `agent/<name>` branch. Child sessions get a `report_result` tool; its report payload is sent back over a Unix socket and delivered to the parent as a follow-up notification: a fresh turn immediately if the parent is idle, or queued as the parent's next turn if it is mid-work. An interrupt (escape) clears that queue without delivering queued custom messages — so fork tracks every report until its `message_end` confirms delivery and re-delivers the rest on `agent_settled`; an interrupt can no longer lose a report. Children stay alive after reporting: the parent reviews, requests revisions with `message_agent`, and closes them with `close_agent`. Closing an isolated child removes its worktree and retains its branch.

Everything lives in `index.ts` — start at the default export.

## Development

Requires Node.js 22.18 or newer and pnpm 11.3.0.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm format:check
```

Use `pnpm format` to apply formatting. Run the typecheck and formatting check before finishing a change; the pre-commit hook enforces both.

## Requirements

- **tmux.** The extension silently no-ops outside tmux.
- **Runtime state** lives under `~/.pi/agent/extensions/fork/`:
  - `sockets/` — per-parent Unix sockets, mode `0o600`
  - `agents/` — per-child Unix sockets (verdict channel), mode `0o600`
  - `tasks/` — per-id task files handed to children at spawn via pi's `@<path>` argument, mode `0o600`; a present task file marks an open agent and persists until `close_agent`
- **Worktrees** live under `~/.pi/worktrees/<id>`; paths use the child UUID while branches use the requested `agent/<name>`
- **Repository policy:** fork only creates and removes worktrees. Repository-owned `post-checkout` and commit hooks handle environment setup and validation; fork has no setup runner or checks gate.
- **Orphan policy:** none. If a parent exits with children alive, their tmux windows and worktrees linger; kill the windows, run `git worktree remove` for isolated children, and remove their task files by hand. Agent branches are always retained for ordinary merge or deletion.
