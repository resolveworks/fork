# fork

Spawn [pi](https://github.com/earendil-works/pi) subagents in tmux windows. Written for my own use; it assumes fluency with pi, tmux, and git worktrees, and stays out of the way — including silently doing nothing outside tmux.

## Install

```bash
pi install git:github.com/resolveworks/fork
```

Or once, without installing:

```bash
pi -e git:github.com/resolveworks/fork
```

## What you get

The parent session gains three tools:

- `spawn_agent({ task, branch? })` — writes the task to a file and opens a new tmux window running `pi @<taskfile>`. Returns immediately. The child sees the task plus normal project context, not the parent's conversation, so the task must be self-contained.
- `message_agent({ id, text })` — delivers a revision request as an ordinary follow-up turn in the child.
- `close_agent({ id })` — mechanical shutdown; no model turn spent.

The child gains `report_result({ result })`. The report travels over a Unix socket and arrives in the parent as a notification that triggers a new turn. The child stays alive after reporting, awaiting the verdict: revisions via `message_agent`, or closure. Reports are outcomes, not progress updates. If delivery fails, the child is told unambiguously and retries with the same payload — a retry cannot double-deliver.

Don't poll. Navigate windows with your usual tmux keys.

## Isolation

Without `branch`, the child shares the parent's working tree — fine for read-only or sequential work, a bad idea for concurrent editors.

With `branch: "kebab-name"`, fork runs `git worktree add ~/.pi/worktrees/<uuid> -b agent/<kebab-name> HEAD` and spawns the child there. The child commits its work; `close_agent` force-removes the worktree (uncommitted work dies with it) and retains the branch for normal review and merge.

Fork deliberately does no environment setup and runs no checks. `git worktree add` fires the repo's `post-checkout` hook — put pnpm/uv/whatever setup there. Commit hooks validate.

## Config

`~/.pi/agent/fork.json`, overridden per-project by `.pi/fork.json` (read only in trusted projects). All fields optional; passed through to the child as CLI flags:

```json
{ "model": "glm-5.2", "provider": "zai", "thinking": "high" }
```

## Runtime state

Under `~/.pi/agent/extensions/fork/` (sockets and task files are mode `0o600`):

- `sockets/<parent-session-id>.sock` — result channel, child → parent
- `agents/<uuid>.sock` — verdict channel, parent → child
- `tasks/<uuid>.md` — the task handed to the child; a present task file marks an open agent and is authoritative across extension reloads

## Orphans

None handled. If a parent dies with children alive: kill their tmux windows, `git worktree remove` any worktrees under `~/.pi/worktrees/`, delete their task files. Agent branches are always retained, whatever happens.
