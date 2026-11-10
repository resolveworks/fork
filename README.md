# fork

Spawn [pi](https://github.com/earendil-works/pi) subagents as separate interactive pi sessions in tmux windows. Each child has its own conversation context and normal pi capabilities. Watch or type into its window; fork automatically delivers its response when it settles. Children stay alive for revision requests until closed.

Fork adds three tools to the parent session. Tmux provides window management, Unix sockets carry reports and follow-up instructions, and optional Git worktrees isolate changes.

## Requirements

- pi 1.1.0 or newer
- tmux, with pi running inside it
- Git, for optional worktree isolation
- Linux; macOS is untested, though the implementation uses portable tmux, Git, and Unix socket APIs

## Install

From npm:

```bash
pi install npm:@resolveworks/fork
```

From Git:

```bash
pi install git:github.com/resolveworks/fork
```

Or once, without installing:

```bash
pi -e npm:@resolveworks/fork
```

Restart pi or run `/reload` after installation.

## Usage

Start pi inside tmux and ask it to delegate a self-contained task. For example:

> Spawn a subagent named `docs-review` to check README.md against index.ts. Review only and report inaccuracies and missing behavior with file and line references.

Fork opens a background tmux window named `docs-review` and returns immediately. Continue other work or end your turn; settlement reports arrive automatically.

Use your normal tmux keys to inspect the child or type into its session. When the child settles, its response and any messages you entered since its previous settlement arrive in the parent.

Review the report, then request revisions or close the child:

> Ask the documentation subagent to also check the configuration examples.

> Close the documentation subagent; its report is sufficient.

Children retain their full session context between revision requests.

## Tools

The parent session gains three tools:

- `spawn_agent({ name, task, worktree?, model? })` — starts a child in a new tmux window and returns its UUID immediately.
  - `name` is lowercase kebab-case. It names the tmux window and, with isolation enabled, the Git branch.
  - `task` is passed verbatim as the child’s initial prompt. The child receives this task and pi’s normal project context. Include the goal, conversation-specific context, constraints, relevant paths, and expected output.
  - `worktree` creates an isolated Git worktree when `true`; the default is `false`.
  - `model` selects a configured [model profile](#model-profiles).
- `message_agent({ id, text })` — sends a revision request or follow-up instruction to an open child. The message steers its current run or starts a new turn if the child is idle.
- `close_agent({ id })` — closes the child and cleans up its runtime state without spending a model turn.

Names label tmux windows and Git branches; UUIDs identify agents in `message_agent` and `close_agent`.

## Settlement reports

Whenever a child settles after a completed run, fork sends its clean final response and any human messages entered in the child session since the previous settlement.

The report arrives as a steering notification. If the parent is busy, it is delivered after pending tool calls and before the next model call; if the parent is idle, it starts a new turn immediately.

Fork tracks each report until delivery is confirmed. When a parent interrupt clears queued reports, fork delivers them again once the interrupted run settles. Delivery failures on the child side appear in the child session.

Long reports are collapsed in the parent transcript. Use pi’s expand keybinding (`ctrl+o` by default) to read the full report.

## Working-tree isolation

By default, the child shares the parent’s working tree. Use shared mode for read-only or sequential work and worktree isolation for concurrent editors.

With `worktree: true`, fork creates a worktree from `HEAD`:

```bash
git worktree add -b agent/<name> ~/.pi/worktrees/<uuid> HEAD
```

The child starts in that worktree and is instructed to commit its work before finishing. Spawning fails if `agent/<name>` already exists.

`close_agent` kills the child’s tmux window, force-removes the worktree, and deletes its task file. **Uncommitted work in the worktree is discarded.** The `agent/<name>` branch is retained for ordinary review and merge.

Children run with the permissions of the user who launched pi.

Repository hooks manage environment setup and validation: Git’s `post-checkout` hook can prepare the worktree and install dependencies, while commit hooks validate committed work.

## Model profiles

Configure child models globally in `~/.pi/agent/fork.json` or per project in `.pi/fork.json`. Project configuration is read in trusted projects.

```json
{
  "default": {
    "model": "glm-5.2",
    "thinking": "high"
  },
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

Profiles support `model`, `provider`, and `thinking`. Fork passes them to the child as pi CLI flags, leaving model resolution to pi.

Each option requires a `tag` and `description`. Fork exposes these to the parent model, which can select a profile with `spawn_agent`’s `model` argument. `default` applies when that argument is omitted; an omitted default uses pi’s normal startup rules.

Configuration is merged by top-level field: project values replace global values.

## Runtime state

Fork stores runtime state under `~/.pi/agent/extensions/fork/`:

- `sockets/<parent-session-id>.sock` — result channel, child → parent
- `agents/<uuid>.sock` — message channel, parent → child
- `tasks/<uuid>.md` — the child’s initial task; a present task file marks the agent as open and remains authoritative across extension reloads

Sockets and task files use mode `0o600`. Isolated worktrees live under `~/.pi/worktrees/<uuid>`.

## Development

Requires Node.js 22.18 or newer and pnpm 11.3.0 or newer.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm format:check
```

Use `pnpm format` to apply formatting. The pre-commit hook enforces type checking and formatting.

## License

[MIT](LICENSE)
