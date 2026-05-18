# AGENTS.md

**fork** is a [pi](https://github.com/earendil-works/pi) extension that runs subagents as interactive pi sessions in separate tmux windows. The LLM calls a single `plan` tool; when the plan completes, fork mechanically spawns implement and review agents for each step.

Everything lives in `index.ts` — start at the default export.

## Philosophy

Fail-fast. No defensive programming, no fallbacks, no silent catches. Missing config or unmet prerequisites should crash with a clear message, not be papered over with defaults.

## Requirements

- **tmux.** The extension no-ops outside tmux.
- **Plans directory** defaults to `./plans/`; override with `FORK_PLANS_DIR`.
- **Runtime state** lives under `~/.pi/agent/extensions/fork/`:
  - `sockets/` — per-parent Unix sockets, mode `0o600`
  - `tasks/` — per-id task files handed to children at spawn via pi's `@<path>` argument, mode `0o600`
