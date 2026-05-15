# The core loop

The workflow that has emerged as the proven default across spec-driven development practitioners, agentic frameworks, and small-model deployments. Three phases, all of them small.

## The three phases

```
┌────────┐   ┌─────────┐   ┌────────┐
│ PLAN   │ → │ CHUNK   │ → │ VERIFY │
│ (file) │   │ (1 step)│   │ (loop) │
└────────┘   └─────────┘   └────────┘
                  ↑              │
                  └──────────────┘
```

(Some workflows split a separate **spec** phase before the plan — see [02-specs-and-planning.md](./02-specs-and-planning.md). For most setups, the plan's goal section carries that information and the project's `AGENTS.md` carries the rules.)

### 1. Plan — produce a plan file

A human-and-model collaboration that ends in a plan file. The plan is the artifact, not the conversation. It contains:

- A one-line goal
- An ordered list of small, individually-implementable steps
- Each step names files, gives a one-line change, and has an acceptance criterion
- Risks / things to watch for

The plan file is **read-only data** once written. The parent agent reads it and decides per turn which step to dispatch next. Nothing tracks "where we are" — each dispatch is a discrete event. See [02-specs-and-planning.md](./02-specs-and-planning.md) for the shape.

Key property: each step should fit in a single small-model context window without needing the rest of the codebase loaded.

### 2. Chunk — implement one step

Pick step N. Load: the step text, the relevant files, the project rules. Implement only that step. Test it. Commit. Then step N+1.

Three rules from practice:
- **Never generate "huge swaths" at once** — produces consistency and duplication issues.
- **Each chunk is a commit** — "save points" for easy rollback. "Never commit code you can't explain."
- **One step ≠ one tool call**; one step = one human-reviewable unit of change.

The implementer never sees the other steps or the full plan history. Just its step.

### 3. Verify — close the loop

Two layers, at different points in the workflow:

- **Hard signals (per step)**: type-check, lint, tests run as git pre-commit hooks. The implementer commits; the hook fails or passes. Failures are visible immediately and fixed before the commit lands. No extra agent dispatch needed.
- **Soft signals (per plan)**: a separate reviewer agent reads the full plan diff against the acceptance criteria. It exercises judgment — design issues, intent mismatch, edge cases — but doesn't re-run the mechanical checks the hooks already passed. It reports a structured verdict: `pass` or `changes-needed` with specific issues. See [04-verification.md](./04-verification.md).

If verify fails: the parent agent decides what to do — re-dispatch the implementer with the failure text, dispatch a different step, or hand it to the human. No automatic loop. If a step keeps failing across attempts: the plan was probably wrong — replan.

## Why this works for derpy models

| Problem with small models | How the loop addresses it |
|---|---|
| Short effective context | Each chunk is small; only what's needed is loaded |
| Hallucinated APIs | Plan pins libraries/signatures; tests catch fabricated calls |
| Goes off the rails | Plan file is re-read each step; can't drift far |
| Inconsistent style | Project rules in AGENTS.md; same rules every step |
| Bad architecture choices | Architecture decided in the plan by stronger model (or human) |
| Doesn't know when to stop | Each step has a defined acceptance criterion |

The loop trades model intelligence for **process discipline**. The model becomes a reliable executor of a clear instruction, not a strategist.

## What this loop replaces

It replaces the dominant 2023-era pattern of "tell the agent the whole goal and let it figure it out" (ReAct-style). That pattern works at frontier-model scale and fails immediately at 7B–30B scale. Plan-then-execute architectures consistently outperform ReAct for tasks of any non-trivial complexity, with the gap widening as the model shrinks.

## Common antipatterns

- **No plan, just chunks.** Chunks without a plan produce locally-correct but globally-inconsistent code.
- **One mega-chunk.** "Implement the whole feature" — produces the inconsistency and duplication mentioned above.
- **State in the plan file.** Plans should be read-only data. There's no need to track "which step is in progress" — the parent agent picks a step, dispatches, and the result is the result.
- **Self-verification only.** Asking the same model "is this right?" tends to *decrease* accuracy without external signals.
- **Loading the whole codebase each chunk.** Long context degrades small-model output substantially. Load surgically.

## See also

- [02-specs-and-planning.md](./02-specs-and-planning.md) — the plan file shape
- [03-agent-patterns.md](./03-agent-patterns.md) — architectural variants of plan-and-execute
- [04-verification.md](./04-verification.md) — the verify step in detail
- [09-applying-to-fork.md](./09-applying-to-fork.md) — how this maps onto fork's planner/implementer split
