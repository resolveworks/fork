# The core loop

The workflow that has emerged as the proven default across spec-driven development practitioners, agentic frameworks, and small-model deployments. It is essentially "waterfall in 15 minutes" — every phase compressed, but the sequence preserved because compression doesn't survive without it.

## The four phases

```
┌────────┐   ┌────────┐   ┌─────────┐   ┌────────┐
│ SPEC   │ → │ PLAN   │ → │ CHUNK   │ → │ VERIFY │
│ (what) │   │ (how)  │   │ (1 step)│   │ (loop) │
└────────┘   └────────┘   └─────────┘   └────────┘
                              ↑              │
                              └──────────────┘
```

### 1. Spec — what to build

A human + model collaboration to produce a `spec.md`. The spec is the artifact, not the conversation. Contents (Addy Osmani's checklist):

- Problem and acceptance criteria
- Architecture decisions
- Data models
- Testing strategy
- Boundaries — "always do" / "ask first" / "never do"

The model's job in this phase is to ask clarifying questions until the spec is concrete. "Specific details prevent ambiguity. Rather than saying 'React project,' specify 'React 18 with TypeScript, Vite, and Tailwind CSS.'"

### 2. Plan — how to build it

Feed the spec to a planning step. Output: an ordered list of small, individually-implementable steps. Each step names files to touch and a one-line goal. The plan is itself a file (`plan.md` or per-feature `plans/<slug>.md`) — the human can edit it before executing.

Key property: each step should fit in a single small-model context window without needing the rest of the codebase loaded.

### 3. Chunk — implement one step

Pick step N. Load: the step text, the relevant files, the spec, the project rules. Implement only that step. Test it. Commit. Then step N+1.

Three rules from practice:
- **Never generate "huge swaths" at once** — produces consistency and duplication issues.
- **Each chunk is a commit** — "save points" for easy rollback. "Never commit code you can't explain."
- **One step ≠ one tool call**; one step = one human-reviewable unit of change.

### 4. Verify — close the loop

Two layers:

- **Hard signals**: tests, type-check, lint, build. These are the ground truth. The agent runs them and feeds failures back.
- **Soft signals**: a separate reviewer agent reads the diff against the spec. Useful, but only as a complement — never the sole verifier (see [04-verification.md](./04-verification.md)).

If verify fails: revise the chunk. If verify keeps failing: revise the plan step. If the plan step keeps failing: revise the spec.

## Why this works for derpy models

| Problem with small models | How the loop addresses it |
|---|---|
| Short effective context | Each chunk is small; only what's needed is loaded |
| Hallucinated APIs | Spec pins libraries/versions; tests catch fabricated calls |
| Goes off the rails | Plan file is re-read each step; can't drift far |
| Inconsistent style | Project rules in AGENTS.md; same rules every step |
| Bad architecture choices | Architecture decided in spec by stronger model (or human) |
| Doesn't know when to stop | Each step has a defined acceptance criterion |

The loop trades model intelligence for **process discipline**. The model becomes a reliable executor of a clear instruction, not a strategist.

## What this loop replaces

It replaces the dominant 2023-era pattern of "tell the agent the whole goal and let it figure it out" (ReAct-style). That pattern works at frontier-model scale and fails immediately at 7B–30B scale. Plan-then-execute architectures consistently outperform ReAct for tasks of any non-trivial complexity, with the gap widening as the model shrinks.

## Common antipatterns

- **No spec, just a plan.** Plans without specs drift because the implementer can't tell which constraints are load-bearing.
- **No plan, just chunks.** Chunks without a plan produce locally-correct but globally-inconsistent code.
- **One mega-chunk.** "Implement the whole feature" — produces the inconsistency and duplication mentioned above.
- **Self-verification only.** Asking the same model "is this right?" tends to *decrease* accuracy without external signals.
- **Loading the whole codebase each chunk.** Long context degrades small-model output substantially. Load surgically.

## See also

- [02-specs-and-planning.md](./02-specs-and-planning.md) — what to put in spec and plan files
- [03-agent-patterns.md](./03-agent-patterns.md) — architectural variants of plan-and-execute
- [04-verification.md](./04-verification.md) — the verify step in detail
- [09-applying-to-fork.md](./09-applying-to-fork.md) — how this maps onto fork's planner/implementer split
