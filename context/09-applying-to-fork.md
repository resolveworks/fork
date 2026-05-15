# Applying the research to fork

This file is the bridge from the research to the codebase. It assumes you've at least skimmed [01-core-loop.md](./01-core-loop.md) and know what's in this repo's `index.ts` and `AGENTS.md`.

## Where fork stands today

fork is already in good shape on several axes:

| Best practice | fork's current state |
|---|---|
| Plan-and-Execute pattern | yes — `planner` + `implementer` agents |
| Isolated subagent context | yes — each runs in its own pi session |
| File-based handoff | partial — `tasks/` exists but is transient |
| Project-level rules | yes — AGENTS.md |
| Compact system prompts | yes — agent prompts are short |
| External verification | **no** — gap |
| Plans as durable artifacts | **no** — gap (current planner returns text in a notification) |
| Schema-shaped plan format | partial — prompt asks for sections but isn't enforced |
| Micro-specs (one plan = one chunk) | **no** — gap; one plan = whole feature |
| Loop budgeting / retries | **no** — gap |

The biggest gaps are **plans-as-files** and **a verifier**. These are the two highest-leverage additions per the research.

## Recommended changes

In order of impact. Each is a discrete change you could ship independently.

### 1. Plans as durable files (highest priority — your original idea)

**Today:** planner returns a text summary that gets surfaced as a notification. The plan exists only in the conversation transcript.

**Change:** planner writes to `plans/<slug>.md` (or `.pi/plans/<slug>.md`). The notification carries the *path* and a one-line goal, not the plan body. The implementer subagent takes a `plan` arg (path) and reads the file.

**Why:** Per [02-specs-and-planning.md](./02-specs-and-planning.md), plans-as-files unlock human edits, re-reading on each step, resumability, and execution-as-checkboxes. Per [07-context-engineering.md](./07-context-engineering.md), durable artifacts beat conversational context for small models.

**Concrete shape:** see the plan schema in [02-specs-and-planning.md](./02-specs-and-planning.md). Checklist items with file paths, acceptance criteria, and risks.

**Open question — where they live:** in-repo (`plans/`, gitignored) vs `.pi/plans/`. In-repo wins for reviewability + survives across machines + integrates with git. Recommend in-repo with `plans/` added to `.gitignore` by default, and a flag to commit them for shared work.

### 2. Add a verifier agent

**Today:** no verification step. Implementer reports back; main session moves on.

**Change:** add a third hardcoded agent: `verifier`. It receives the plan file path and the diff (or a description of changes). Its job is to:

- Run type-check / lint / tests externally (shell commands)
- Read the diff against the spec / plan
- Report pass / fail / list of issues

Wire it as an automatic step after implementer completes. If verifier fails, send the issues back to implementer for revision (cap at 3 iterations per [04-verification.md](./04-verification.md)).

**Why:** "Verification rounds are the hidden win." This is the single biggest expected quality lift.

**Caveat:** the verifier *must* use external signals (type-checker, tests). Pure LLM self-critique can lower quality. The agent's job is to *run* the external tools and aggregate output, not to "review" the code with model intuition.

### 3. Schema-shaped plan format

**Today:** the planner prompt describes a format but doesn't enforce it. Output is freeform prose with section headers.

**Change:** make the plan a strictly-schema'd markdown file (or YAML frontmatter + checklist). The implementer parses it mechanically. Steps become iterable.

Example structure:

```markdown
---
slug: <slug>
goal: <one line>
spec: <path or null>
---

## Steps

- [ ] step-1: `src/foo.ts` — add `parseConfig()` function
  - acceptance: `pnpm test foo.test.ts` passes
- [ ] step-2: `src/bar.ts` — wire up `parseConfig` into init
  - acceptance: type-check passes, no new warnings

## Risks
- ...
```

**Why:** Per [05-reliability-techniques.md](./05-reliability-techniques.md), schemas pin reliability. The implementer can iterate `for step in steps_not_done(plan_file)` instead of reasoning about prose. Each step becomes its own narrow subagent invocation.

### 4. One step = one subagent call

**Today:** implementer is invoked once with a freeform task string and is expected to do the whole thing.

**Change:** the parent loop invokes the implementer agent **per step**. The agent sees:

- The project rules (AGENTS.md)
- Its specific step text
- The named files (full content if small, summaries if large)
- Nothing else

This is the micro-spec pattern in [02-specs-and-planning.md](./02-specs-and-planning.md). Keeps each call's context budget small enough for derpy models.

**Trade-off:** more tmux windows / more orchestration overhead. But each window's job is small enough that a 7B model can do it.

### 5. Compact, focused agent prompts

**Today:** the prompts are already short, which is good. Per [08-local-tooling.md](./08-local-tooling.md), this is exactly the lever Cline had to discover (their "compact prompt" mode).

**Change:** keep them this way. Resist adding instructions. If you find yourself wanting more, that's a sign the spec / plan needs to carry it.

### 6. Loop budgeting + retry/blocked state

**Today:** no retry handling. If implementer fails, that's the result.

**Change:** when verifier rejects, send issues back to implementer with `revise: <step>` flavor. Cap at 3 iterations. After cap, mark step as **blocked** in the plan file and surface to the human.

Track per-step status in the plan file checkboxes:
- `[ ]` not started
- `[~]` in progress
- `[!]` blocked
- `[x]` done

**Why:** per [04-verification.md](./04-verification.md), uncapped loops produce error amplification. Bounded iteration with explicit blocked state is the working pattern.

### 7. (Optional) Add a scout/researcher agent

The README mentions four agents (scout, planner, worker, reviewer) but only two are hardcoded. A scout — read-only, gathers context from the codebase before planning — fits the [07-context-engineering.md](./07-context-engineering.md) story: the planner shouldn't have to discover files; the scout finds them and passes a curated context to the planner.

Tier of priority is below 1–6, but it rounds out the workflow.

## What *not* to add

Things the research suggests against, despite being tempting:

- **More-clever planner prompts.** Per [03-agent-patterns.md](./03-agent-patterns.md), the weak-planner problem isn't fixed by prompt cleverness. It's fixed by stronger planners (or by the human doing more of the planning).
- **Self-critique loops without external signals.** Per [04-verification.md](./04-verification.md), this lowers quality.
- **Generalist agents.** The pattern is *specialist* agents with narrow scope, not one capable generalist.
- **Long contexts because the model says it supports them.** Per [08-local-tooling.md](./08-local-tooling.md), effective context is much smaller than advertised for local quantized models.

## A target architecture

Putting it together, this is roughly what a v2 fork looks like:

```
Subagent flow per chunk:
  ┌─────────┐    ┌─────────┐    ┌──────────────┐    ┌──────────┐
  │ scout   │ →  │ planner │ →  │ implementer  │ →  │ verifier │
  │ (opt)   │    │         │    │ (per step)   │ ⤺  │          │
  └─────────┘    └─────────┘    └──────────────┘    └──────────┘
       │              │                │                  │
       ▼              ▼                ▼                  ▼
   context.md     plan.md          edits + commits   pass/fail
   (curated)      (checklist)                        (+ issues)
```

Each box is a tmux window. Each artifact is a file. Each call's context is narrow.

This is what the research converges on, mapped onto the building blocks you already have.

## See also

- [README.md](./README.md) — index
- [01-core-loop.md](./01-core-loop.md) — the underlying workflow this maps to
- [02-specs-and-planning.md](./02-specs-and-planning.md) — plan/spec file shapes
- [04-verification.md](./04-verification.md) — designing the verifier
