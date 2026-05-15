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
| One step at a time | **no** — gap; one task = whole feature |

The biggest gaps are **plans-as-files** and **a verifier**. These are the two highest-leverage additions per the research.

## Design principles for fork

A few constraints that should shape every change:

1. **Simpler is better.** Each piece of the system the model has to parse is a chance for derpy models to go wrong. Cut anything that doesn't directly help.
2. **No state anywhere; plans are read-only data.** No retry counters, no step pointers, no "current step" markers. The planner writes the plan once and no one writes to it again. The parent agent reads the plan on each turn and decides what to dispatch next.
3. **One file per artifact type.** AGENTS.md is the project layer. A plan file is the feature layer. No separate spec file.
4. **Each subagent call gets only what it needs.** Project rules + step text + named files. Not the whole plan, not history.

## Recommended changes

In order of impact. Each is a discrete change you could ship independently.

### 1. Plans as durable files (highest priority — your original idea)

**Today:** planner returns a text summary that gets surfaced as a notification. The plan exists only in the conversation transcript.

**Change:** planner writes to `.pi/agent/extensions/fork/plans/<slug>.md` (or in-repo `plans/<slug>.md`, gitignored). The notification carries the *path* and a one-line goal, not the plan body. The parent agent then reads the file when it needs to dispatch a step.

**Why:** Per [02-specs-and-planning.md](./02-specs-and-planning.md), plans-as-files unlock human edits and re-reading without re-deriving. Per [07-context-engineering.md](./07-context-engineering.md), durable artifacts beat conversational context for small models.

**Plan format:** simple numbered list, no frontmatter, no checkboxes, no status markers, no annotations after the fact:

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

### 2. Add a verifier agent

**Today:** no verification step. Implementer reports back; main session moves on.

**Change:** add a third hardcoded agent: `verifier`. It receives the step text and the diff (or a description of changes), runs type-check / lint / tests as shell commands, and reports pass or a list of specific failures.

The parent agent decides what to do with the verifier's report — re-dispatch the implementer with the failures, dispatch the next step, or surface to the human. There's no automated retry loop in fork's code; the parent agent's turn is the decision point.

**Why:** "Verification rounds are the hidden win." This is the single biggest expected quality lift.

**Caveat:** the verifier *must* use external signals (type-checker, tests). Pure LLM self-critique can lower quality. The agent's job is to *run* the external tools and aggregate output, not to "review" the code with model intuition.

### 3. One step per implementer dispatch

**Today:** implementer is invoked once with a freeform task string and is expected to do the whole thing.

**Change:** dispatch the implementer for **one step at a time**, with the step's text as the task. The agent sees:

- The project rules (AGENTS.md)
- Its specific step text
- The named files (full content if small, summaries if large)
- Nothing else

The parent agent dispatches step 1, gets a result, dispatches step 2, etc. — making per-turn decisions, not running a loop.

**Trade-off:** more tmux windows. But each window's job is small enough that a 7B model can do it, and tmux already gives the human visibility into all of them.

### 4. Keep prompts compact

**Today:** prompts are already short. Good.

**Change:** keep them this way. Resist adding instructions. If you find yourself wanting more, that's a sign the plan needs to carry it.

The pattern: project rules (in AGENTS.md, loaded by pi) + the step text (passed as the task) + nothing else in the system prompt. Agent instructions stay terse — "implement this step, then stop."

### 5. (Optional) Add a scout agent

The original README mentioned scout, planner, worker, reviewer. A scout — read-only, gathers context from the codebase before planning — fits the [07-context-engineering.md](./07-context-engineering.md) story: the planner shouldn't have to discover files; the scout finds them and passes a curated context to the planner.

Lower priority than 1–4, but rounds out the workflow.

## What *not* to add

Things the research suggests against, despite being tempting:

- **State anywhere — files, parent memory, retry counters.** The parent agent's per-turn decisions are enough. tmux gives live visibility.
- **A separate spec file alongside the plan.** Doubles the artifact count for marginal benefit. AGENTS.md covers project rules; the plan's goal section covers intent.
- **Automated retry loops in fork's code.** The parent agent decides per turn whether to re-dispatch the implementer. Don't hard-code a loop.
- **Updating the plan file after it's written.** Plans are write-once. If the plan is wrong, replan — make a new file.
- **More-clever planner prompts.** Per [03-agent-patterns.md](./03-agent-patterns.md), the weak-planner problem isn't fixed by prompt cleverness.
- **Self-critique loops without external signals.** Per [04-verification.md](./04-verification.md), this lowers quality. The verifier must run real tools.
- **Generalist agents.** The pattern is *specialist* agents with narrow scope, not one capable generalist.

## A target architecture

Putting it together, this is roughly what a v2 fork looks like:

```
  ┌─────────┐    ┌─────────┐
  │ scout   │ →  │ planner │   →  plan.md (numbered steps, write-once)
  │ (opt)   │    │         │
  └─────────┘    └─────────┘
                                     
  parent agent reads plan.md, picks a step, dispatches:
                                       
      ┌──────────────┐    ┌──────────┐
      │ implementer  │    │ verifier │
      │  (one step)  │    │ (one     │
      │              │    │  check)  │
      └──────────────┘    └──────────┘
                                       
  results come back via fork-result notifications.
  parent agent takes a new turn, decides what to dispatch next.
  human watches via tmux, intervenes if needed.
```

Each box is a tmux window. The plan is a write-once file. The human sees everything via tmux.

This is what the research converges on, mapped onto the building blocks you already have, kept as simple as possible.

## See also

- [README.md](./README.md) — index
- [01-core-loop.md](./01-core-loop.md) — the underlying workflow this maps to
- [02-specs-and-planning.md](./02-specs-and-planning.md) — plan file shape
- [04-verification.md](./04-verification.md) — designing the verifier
