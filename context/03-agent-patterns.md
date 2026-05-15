# Agent patterns

The architectural variants for splitting a task across multiple LLM calls. All of these are improvements on ReAct (think-act-observe in a tight loop), which works at frontier scale and crumbles at small-model scale.

## ReAct (the baseline you're trying to beat)

The 2022 default: model gets a goal, thinks, picks a tool, observes the result, thinks again, picks another tool, etc. The model is re-prompted with the entire growing trace after every step.

Why it fails for small models:
- The trace grows linearly with steps; small models degrade fast in long context
- The model has to plan *and* act simultaneously; small models drop one
- No external structure to recover when it gets lost
- Tool-call errors cascade because there's no separate planning step to recover

ReAct is the floor; everything below is better.

## Plan-and-Execute (the standard upgrade)

**Structure:** A planner runs once, produces a multi-step plan. Executors handle each step. The planner can be re-invoked to replan if execution diverges.

**Why it helps:** Decouples strategic reasoning (planner) from tactical execution (executor). The executor sees only its current step, not the full plan history. Cheaper, faster, more reliable than ReAct.

**The bottleneck:** Empirically, "weak planners are the most critical bottleneck." Plan quality dominates outcome quality.

**Use when:** You have one planning step and a sequence of small, mostly-independent execution steps. This is the right default for coding work.

## ReWOO (Reasoning Without Observation)

**Structure:** Planner produces a plan that includes *variable references* (`#E1`, `#E2`, …) for the outputs of later steps. A worker runs each step, substituting variables with actual results. A solver integrates everything at the end.

**Why it helps:**
- The planner only runs once. No re-prompting per step.
- 5× token efficiency and ~4% accuracy improvement on multi-step benchmarks
- Tool calls don't require re-invoking the LLM between them

**Use when:** Steps have data dependencies on each other but the dependency graph is mostly linear. E.g., "search for X, then look up details of the first result, then summarize."

**Caveat for coding:** Code tasks often need to react to surprises (test failures, type errors). ReWOO's "plan everything once" assumption is weaker for code than for retrieval-heavy tasks.

## LLMCompiler

**Structure:** Planner outputs a DAG of tasks with explicit dependencies. A scheduler runs independent tasks in parallel. A joiner inspects results and either finalizes or replans.

**Why it helps:** Up to 3.6× speedup through parallel execution. Best for tasks with naturally parallelizable subtasks.

**Use when:** You have multiple genuinely independent subtasks (e.g., "summarize each of these five files"). Less useful for sequential coding work where step 2 needs step 1's result.

## Reflection / generate-verify-revise

**Structure:** Generator produces a candidate. Verifier (separate model, tests, or rules) evaluates. If failed, generator revises with the feedback. Loop until pass or budget exhausted.

This isn't a *replacement* for plan-and-execute; it's an inner loop inside the executor step. See [04-verification.md](./04-verification.md) for details.

## The mixing-models caveat

The intuitive move — strong planner + cheap executor — has been benchmarked, and the results are sobering. From the akitaonrails 2026 benchmark:

| Configuration | Score / 100 | vs. solo planner |
|---|---|---|
| Opus solo | 97 | baseline |
| Opus + Sonnet executor | 92 | −5 |
| Opus + Haiku executor | 90 | −7 |
| Opus + Kimi K2.6 executor | 95 | −2 |
| Opus + GLM executor | 93 | −4 |
| GPT-5.4 xHigh + medium | 94 vs 97 | −3, but 80% cheaper |

**Every mixed pairing lost quality** vs. the strong-solo baseline. The benefit was cost, not quality. The best case (GPT-5.4 + medium) was 3 points worse for 80% cheaper.

The lesson is not "don't split work" — it's "don't expect quality from a planner-executor split that you wouldn't get from a strong model alone." Splitting is a **cost lever** and a **context-window lever**, not a quality lever.

For local-only setups, the calculation is different: you don't have a strong-solo option, so the comparison isn't fair. But the underlying point holds — the split helps because each model sees less context, not because the planner makes the executor smart.

### Hidden costs

The same benchmark found Opus-driving-Kimi cost 3× more than Kimi-solo when planner overhead was counted. Orchestration has overhead. Budget for it.

## Verification rounds: the underrated lever

From the same research: "Verification rounds are the hidden win. If your orchestrator prompt includes 'write then verify then fix,' you'll see quality lift. If it just includes 'delegate everything,' you'll see cost lift without quality lift."

Translation: adding a *verifier* (not just a planner and an executor) is where the quality actually comes from. See [04-verification.md](./04-verification.md).

## What to use for coding with small local models

Default: **Plan-and-Execute + verifier loop**.

- Plan-and-Execute fits coding work (sequential, requires reaction to results)
- ReWOO is overkill — you'll need to replan anyway when tests fail
- LLMCompiler only helps if you have parallelizable subtasks
- The verifier is non-optional; without it you're just splitting work, not improving it

## See also

- [02-specs-and-planning.md](./02-specs-and-planning.md) — what the planner produces
- [04-verification.md](./04-verification.md) — the verifier step in detail
- [06-small-models.md](./06-small-models.md) — capability constraints to design around
