# Context engineering

"Context engineering is curating what the model sees so that you get a better result." It's the discipline of deciding *what to load*, *when to load it*, and *what structure to load it in*. Often higher-leverage than prompt wording.

## The hierarchy

A working mental model: the context window is a stack of decreasing scope.

```
┌──────────────────────────────────┐  always loaded
│  Project rules (AGENTS.md)       │
├──────────────────────────────────┤  loaded for plan
│  Plan file (plans/<x>.md)        │
├──────────────────────────────────┤  loaded for step
│  Current step text + relevant    │
│  source files                    │
└──────────────────────────────────┘  ← model only acts on this
```

The principle: each layer narrows. A subagent doing step 3 of plan X should only see step 3, not the whole plan.

For small models this isn't optional. Long context degrades output sharply.

The git layer mirrors this: a feature branch per plan (`plan/<slug>`) keeps all step commits organized in one place. The reviewer reads the branch diff; the human can browse it; merge or revert as a unit. Without a branch, step commits scatter across the log and the plan's full diff is harder to reconstruct.

(Some workflows insert a separate feature-spec layer between project rules and plan. For most setups the plan's goal section is enough; see [02-specs-and-planning.md](./02-specs-and-planning.md).)

## AGENTS.md (the project-level layer)

AGENTS.md is the emerging cross-tool standard for project-level agent instructions. Adopted by 60,000+ repositories as of 2026. Governed by the Agentic AI Foundation under the Linux Foundation, originating from Sourcegraph, OpenAI, Google, Cursor, and Factory.

What goes in it:

- One-sentence project description
- Package manager (if not the default)
- Exact build and test commands
- Code style conventions worth calling out
- Architectural decisions and their rationale
- Security gotchas
- PR conventions

Heuristic: **"What would you tell a senior engineer joining the project on their first day?"** If they'd need it on day one, it belongs in AGENTS.md.

## AGENTS.md vs CLAUDE.md

Both files exist for the same reason. The difference is tooling:

- **AGENTS.md** — cross-tool standard. Supported by Cursor, Aider, Continue, Sourcegraph Cody, Factory, OpenAI tools.
- **CLAUDE.md** — Anthropic's Claude Code looks for this name specifically.

As of April 2026, Claude Code does not natively read AGENTS.md. The common workaround is to keep both (or symlink CLAUDE.md → AGENTS.md). For a multi-tool repo, AGENTS.md is the right default.

This repo already has an AGENTS.md, which is good practice.

## Plans (the feature/execution layer)

A plan turns intent into an ordered set of implementable steps. Lives in `plans/<slug>.md` (or `.pi/.../plans/`). See [02-specs-and-planning.md](./02-specs-and-planning.md) for the shape.

The plan's goal section carries the *intent*; the steps carry the *execution*. Project rules in AGENTS.md are background; the plan is foreground. The implementer reads only what it needs from the plan — usually just the current step.

## What to load per step

For step N of plan X:

- **Always:** project rules (AGENTS.md) — they govern everything
- **Always:** step N text — this is what to do
- **Usually:** the file(s) named in step N — full content
- **Sometimes:** adjacent files referenced by step N — full content if small, function signatures only if large
- **Rarely:** the full plan — usually not needed beyond the step text

Context budget for a small model: aim for **<8K tokens** of loaded context per step, ideally <4K. Past that, quality degrades noticeably for most local models, regardless of advertised context window.

## Tools for packing context

Concrete utilities people use:

- **gitingest** — bundles a repo or subdirectory into a single text file
- **repo2txt** — similar; concatenates source files with headers
- **files-to-prompt** — Simon Willison's tool, same idea
- **`tree` + `head`** — DIY: directory map + first-N-lines of each file

The pattern is the same: one comprehensive context file, not "paste this, then paste this." Reduces token overhead from repeated framing.

## Hierarchical summaries

For larger contexts that won't fit, the working pattern is:

1. Generate per-file summaries (one-time, cached)
2. Generate per-directory summaries from file summaries
3. Generate a project-level summary
4. Load summaries by default; load full file content only when needed

This is what Cursor / Cline / Aider's "codebase indexing" does under the hood. For a manual setup, you can build the same hierarchy by hand and check it in.

## Anti-patterns

- **"Just dump the codebase."** Token waste and quality killer for small models.
- **Re-explaining project rules every prompt.** Put them in AGENTS.md and load once.
- **Conversational context.** Long back-and-forth eats budget. Compress to artifacts (files) and reset.
- **Hidden context.** "You should know that…" — if it's worth knowing, write it in a file the next session can read.
- **Stale context.** Cline specifically: keep KV cache off, because persisted context between tasks creates unpredictable behavior. Same principle: don't carry context implicitly.

## What context engineering replaces

It replaces prompt engineering as the primary lever. Prompt wording matters but is a small effect compared to *what's in the context*. A mediocre prompt with the right context outperforms a brilliant prompt with the wrong context, every time.

## See also

- [02-specs-and-planning.md](./02-specs-and-planning.md) — the plan file shape
- [08-local-tooling.md](./08-local-tooling.md) — how Cline / Aider / Continue handle context loading
- [09-applying-to-fork.md](./09-applying-to-fork.md) — context loading strategy for fork's subagents
