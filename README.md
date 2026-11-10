# fork

Spawn [pi](https://github.com/earendil-works/pi) subagents in tmux windows. Each child is a separate pi process you can watch and type into; it reports back over a Unix socket and stays alive for revision requests. Assumes fluency with pi, tmux, and git worktrees, and stays out of the way — including silently doing nothing outside tmux.

## Requirements

- pi 1.1.0 or newer (newest pi API used: `agent_settled.aborted`)
- tmux, with pi running inside it
- git, for `worktree` isolation
- Linux; macOS untested (nothing Linux-specific), Windows unsupported

## Install

```bash
pi install npm:@resolveworks/fork
```

Or from git:

```bash
pi install git:github.com/resolveworks/fork
```

Or once, without installing:

```bash
pi -e npm:@resolveworks/fork
```

Then restart pi, or `/reload`.

## What you get

The parent session gains three tools:

- `spawn_agent({ task, name, worktree?, model? })` — writes the task to a file and opens a new tmux window titled `<name>` running `pi @<taskfile>`. Returns immediately. The child sees the task plus normal project context, not the parent's conversation, so the task must be self-contained.
- `message_agent({ id, text })` — steers a revision request into the child's current run, or starts a new turn when the child is idle.
- `close_agent({ id })` — mechanical shutdown; no model turn spent.

Whenever the child settles, fork sends its final response and any human messages entered since the previous settle over a Unix socket. No reporting tool or model action is required. The settlement arrives in the parent as a steering notification: immediately if the parent is idle, or injected into the parent's current run after its pending tool calls. Human interventions therefore arrive together with the child's response, preserving their context.

The child stays alive after settling, awaiting revisions via `message_agent` or closure. Delivery failures are reported in the child session. Interrupting the parent would drop its queued notifications, so fork re-delivers them once the interrupted run settles — an escape can no longer lose a message.

Don't poll. Navigate windows with your usual tmux keys.

## Isolation

Without `worktree: true`, the child shares the parent's working tree — fine for read-only or sequential work, a bad idea for concurrent editors.

With `worktree: true`, fork runs `git worktree add ~/.pi/worktrees/<uuid> -b agent/<name> HEAD` and spawns the child there. The spawn fails if that branch already exists. The child commits its work; `close_agent` force-removes the worktree (uncommitted work dies with it) and retains the branch for normal review and merge.

Fork deliberately does no environment setup and runs no checks. `git worktree add` fires the repo's `post-checkout` hook — put pnpm/uv/whatever setup there. Commit hooks validate.

## Config

`~/.pi/agent/fork.json`, overridden per-project by `.pi/fork.json` (read only in trusted projects). A `default` profile plus named `options`, passed through to the child as CLI flags:

```json
{
  "default": { "model": "glm-5.2", "thinking": "high" },
  "options": [
    {
      "tag": "small",
      "description": "Fast and inexpensive; use for routine tasks.",
      "model": "glm-4.7-air"
    },
    {
      "tag": "big",
      "description": "Stronger reasoning; use for complex design and difficult debugging.",
      "model": "claude-opus-4-5",
      "provider": "anthropic"
    }
  ]
}
```

Each option requires a `description`, shown to the parent model alongside its tag so it can select an appropriate profile. `spawn_agent` takes an optional `model` argument naming an option's tag; without it, the `default` profile applies, or pi's normal startup rules if there is none. The project file replaces global fields wholesale.

## Runtime state

Under `~/.pi/agent/extensions/fork/` (sockets and task files are mode `0o600`):

- `sockets/<parent-session-id>.sock` — result channel, child → parent
- `agents/<uuid>.sock` — verdict channel, parent → child
- `tasks/<uuid>.md` — the task handed to the child; a present task file marks an open agent and is authoritative across extension reloads

## Development

Requires Node.js 22.18 or newer and pnpm 11.3.0.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm format:check
```

Use `pnpm format` to apply formatting.
