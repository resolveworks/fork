# Applying the research to fork

This file is the bridge from the research to the codebase. It assumes you've at least skimmed [01-core-loop.md](./01-core-loop.md) and know what's in this repo's `index.ts` and `AGENTS.md`.

## Where fork stands today

fork is already in good shape on several axes:

| Best practice | fork's current state |
|---|---|
| Plan-and-Execute pattern | yes — `planner` + `implementer` agents |
| Isolated subagent context | yes — each runs in its own pi session |
| Project-level rules | yes — AGENTS.md |
| Compact system prompts | yes — agent prompts are short |
| Visibility into running work | yes — tmux windows give full view |
| File-based handoff | partial — `tasks/` exists but is transient |
| Plans as durable artifacts | **no** — gap (planner returns text in a notification) |
| External verification | **no** — gap |
| Micro-plans (one plan = one chunk) | **no** — gap; one task = whole feature |

The biggest gaps are **plans-as-files** and **a verifier**. These are the two highest-leverage additions per the research.

## Design principles for fork

A few constraints that should shape every change:

1. **Simpler is better.** Each piece of the system the model has to parse is a chance for derpy models to go wrong. Cut anything that doesn't directly help.
2. **No state in the plan file.** The plan is read-only data. State (which step, retry count, blocked) lives in the orchestrator. Visibility into running agents already exists via tmux — no need to mirror it in files.
3. **One file per artifact type.** AGENTS.md is the project layer. A plan file is the feature layer. No separate spec file — the plan's goal section carries intent.
4. **Each subagent call gets only what it needs.** Project rules + step text + named files. Not the whole plan, not the spec, not the history.

## Recommended changes

In order of impact. Each is a discrete change you could ship independently.

### 1. Plans as durable files (highest priority — your original idea)

**Today:** planner returns a text summary that gets surfaced as a notification. The plan exists only in the conversation transcript.

**Change:** planner writes to `.pi/agent/extensions/fork/plans/<slug>.md` (or in-repo `plans/<slug>.md`, gitignored). The notification carries the *path* and a one-line goal, not the plan body. The implementer subagent takes a `plan` arg (path) and reads the file.

**Why:** Per [02-specs-and-planning.md](./02-specs-and-planning.md), plans-as-files unlock human edits, re-reading on each step, and resumability. Per [07-context-engineering.md](./07-context-engineering.md), durable artifacts beat conversational context for small models.

**Plan format:** simple numbered list, no frontmatter, no checkboxes, no status markers:

```markdown
# Plan: <slug>

## Goal
<one sentence>

## Steps
1. **<file>** — <what changes>
   - acceptance: <how we know it worked>
2. **<file>** — <what changes>
   - acceptance: <how we know it worked>

## Risks
<things to watch for>
```

The file is read-only after the planner writes it. The orchestrator picks step N and hands its text to the implementer. The plan doesn't get mutated, so the implementer can't accidentally damage it.

### 2. Add a verifier agent

**Today:** no verification step. Implementer reports back; main session moves on.

**Change:** add a third hardcoded agent: `verifier`. It receives the step text and the diff (or a description of changes). Its job is to:

- Run type-check / lint / tests externally (shell commands)
- Read the diff against the step's acceptance criterion
- Report pass / fail / list of issues

Wire it as an automatic step after implementer completes. If verifier fails, send the issues back to implementer for revision. Cap at 3 iterations per [04-verification.md](./04-verification.md).

**Why:** "Verification rounds are the hidden win." This is the single biggest expected quality lift.

**Caveat:** the verifier *must* use external signals (type-checker, tests). Pure LLM self-critique can lower quality. The agent's job is to *run* the external tools and aggregate output, not to "review" the code with model intuition.

### 3. One step = one subagent call

**Today:** implementer is invoked once with a freeform task string and is expected to do the whole thing.

**Change:** the parent loop invokes the implementer agent **per step**. The agent sees:

- The project rules (AGENTS.md)
- Its specific step text
- The named files (full content if small, summaries if large)
- Nothing else

**Trade-off:** more tmux windows / more orchestration overhead. But each window's job is small enough that a 7B model can do it. tmux already gives you visibility into all of them, which is part of why this works for fork specifically — you can watch each step's window if you want, and ignore them if you don't.

### 4. Keep prompts compact, keep the model on rails

**Today:** prompts are already short. Good.

**Change:** keep them this way. Resist adding instructions. If you find yourself wanting more, that's a sign the plan needs to carry it.

The pattern is: project rules (in AGENTS.md, loaded by pi) + the step text (passed as task) + nothing else in the system prompt. The agent's instructions should be terse — "implement this step, then stop."

### 5. Cap retries, surface to human via tmux

**Today:** no retry handling. If implementer fails, that's the result.

**Change:** when verifier rejects, send issues back to implementer with the failure text. Cap at 3 iterations. After cap, leave the tmux window open and notify the parent that the step is stuck.

The state of the retry loop lives in the orchestrator's memory (which is a parent-side data structure). It doesn't go in the plan file. tmux already shows the human what's happening — they can take over any stuck window.

### 6. (Optional) Add a scout agent

The original README mentioned scout, planner, worker, reviewer. A scout — read-only, gathers context from the codebase before planning — fits the [07-context-engineering.md](./07-context-engineering.md) story: the planner shouldn't have to discover files; the scout finds them and passes a curated context to the planner.

Lower priority than 1–5, but rounds out the workflow.

## What *not* to add

Things the research suggests against, despite being tempting:

- **State in the plan file (checkboxes, status markers).** The file should be read-only data. State belongs in the orchestrator. tmux gives you live visibility into agents already.
- **A separate spec file alongside the plan.** Doubles the artifact count for marginal benefit. AGENTS.md covers project rules; the plan's goal section covers intent.
- **More-clever planner prompts.** Per [03-agent-patterns.md](./03-agent-patterns.md), the weak-planner problem isn't fixed by prompt cleverness. It's fixed by stronger planners or by the human doing more of the planning.
- **Self-critique loops without external signals.** Per [04-verification.md](./04-verification.md), this lowers quality. The verifier must run real tools.
- **Generalist agents.** The pattern is *specialist* agents with narrow scope, not one capable generalist.
- **Long contexts because the model says it supports them.** Per [08-local-tooling.md](./08-local-tooling.md), effective context is much smaller than advertised for local quantized models.

## A target architecture

Putting it together, this is roughly what a v2 fork looks like:

```
Per-feature flow:
  ┌─────────┐    ┌─────────┐
  │ scout   │ →  │ planner │   →  plan.md (numbered steps)
  │ (opt)   │    │         │
  └─────────┘    └─────────┘
                                       │
                                       ▼ orchestrator iterates
                                       
  for each step in plan:
      ┌──────────────┐    ┌──────────┐
      │ implementer  │ →  │ verifier │ — pass? commit; next step
      │              │ ⤺  │          │ — fail? revise (cap 3)
      └──────────────┘    └──────────┘
                                       │
                                       ▼ stuck?
                                  leave tmux window
                                  open for human
```

Each box is a tmux window. The plan is a file the orchestrator reads. State (which step, retry count) is in the orchestrator's memory. The human watches via tmux if they want.

This is what the research converges on, mapped onto the building blocks you already have, kept as simple as possible.

## See also

- [README.md](./README.md) — index
- [01-core-loop.md](./01-core-loop.md) — the underlying workflow this maps to
- [02-specs-and-planning.md](./02-specs-and-planning.md) — plan file shape
- [04-verification.md](./04-verification.md) — designing the verifier
