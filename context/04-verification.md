# Verification

The step that has the strongest empirical evidence for quality lift, and the one most easily skipped. Verification is what separates "splitting work to manage context" (a logistics win) from "splitting work to get better code" (a quality win).

## The generate → evaluate → revise loop

The basic structure:

```
       ┌─────────────┐
       │  Generate   │
       │ (candidate) │
       └──────┬──────┘
              │
              ▼
       ┌─────────────┐
       │  Evaluate   │
       │ (reviewer)  │
       └──────┬──────┘
              │
         pass │ fail
              │
              ▼
       ┌─────────────┐
       │   Revise    │
       │ (feedback   │
       │  → next gen)│
       └──────┬──────┘
              │
              ▲
              └─── back to Generate
```

This is "searching at test time" — instead of trying to produce the right answer in one pass, you sample, check, and refine.

## The critical finding: external > self

A widely-replicated 2023 result: asking an LLM to review and correct its own outputs **decreases** accuracy on math and reasoning tasks. The model changes correct answers to wrong ones more often than it fixes errors.

The fix is not "use a smarter model for review" — it is **external verification signals**. Things that aren't the model giving itself a vibe-check:

| Strong signal | Weak signal |
|---|---|
| Tests pass / fail | "Looks good to me" |
| Type-checker output | "I reviewed it, seems fine" |
| Linter / formatter | Self-rated confidence |
| Execution trace | LLM-as-judge with no rubric |
| Schema validation | Freeform critique |

The CRITIC framework (2023) made this explicit: have the LLM generate a response, then use *external tools* (Python interpreter, search, classifier) to verify factual claims, code, or safety. The verification is mechanical, not LLM-driven.

## Two layers: hooks + reviewer

The mechanical checks and the judgment review are best handled by different mechanisms, at different points in the workflow.

### Layer 1: Pre-commit hooks (per step)

Compile / type-check, lint, and tests run automatically as git pre-commit hooks. The implementer makes its changes and commits; the hook runs; if it fails, the implementer sees the error output and fixes before the commit lands. No extra subagent, no parent-agent decision point.

This means the cheapest, highest-signal checks happen **at commit time, automatically, on every step.** The implementer doesn't need to be told to run them — the commit itself enforces them.

### Layer 2: Reviewer agent (per step)

After each step commits (hooks passing), a reviewer agent reads the step's diff with the step text and acceptance criteria loaded. This is where soft signals enter — but they're anchored against a written spec, not vibes.

The reviewer's job is **judgment only**. Hooks already caught type errors, lint violations, and test failures — the implementer won't return until the commit lands. The reviewer brings fresh eyes for things hooks can't check:

- Design issues: is this the right approach?
- Intent mismatch: does the implementation match the step's acceptance criteria?
- Edge cases: what breaks at the boundaries?
- Security: anything exposed that shouldn't be?
- Consistency: does this fit with the rest of the codebase?

Reviewing per step (rather than per plan) catches design issues early, before later steps build on a wrong foundation. The cost is more reviewer dispatches; the saving is smaller, cheaper reviews and less rework when something is off.

## When LLM-as-reviewer actually works

Cross-model correction works when the reviewer model is *different from* the generator. Most successful patterns use:

- Small fine-tuned reviewer vs. larger general-purpose generator
- Multi-agent debate between models with similar capabilities
- A reviewer that has *the spec loaded* and the generator that doesn't

The pattern that doesn't work: same model, same prompt, "review your answer." Avoid.

## Failure modes of verification loops

From the agent-loops literature, three patterns to watch:

1. **Weak / gameable scoring.** If the reviewer is a soft LLM judge, the generator learns to please the judge rather than solve the task. Mitigated by hard external signals.

2. **Underspecified tasks.** If there's no clear notion of "better," refinement has nowhere to go. Mitigated by acceptance criteria in the plan / spec.

3. **Error amplification.** Repeated revise attempts compound mistakes — the generator latches onto a wrong direction and the reviewer rationalizes it. Mitigated by stopping after a couple of attempts and falling back to human review.

## Knowing when to stop

A revise-on-failure dance can compound mistakes if it goes on too long. The practical guidance:

- After 2–3 unsuccessful revise attempts, stop and hand the problem to the human
- Each attempt should include the previous failure text verbatim — don't paraphrase it
- If the same kind of failure keeps appearing, the plan step was probably wrong; replan rather than retry

## What reviewing buys you with small models

The cost-benefit is good. Small models are cheap to run, so iteration is cheap. The reviewer catches the exact failure modes small models are prone to (hallucinated APIs, wrong imports, missed edge cases) using cheap external signals. The combination — cheap generator + cheap reviewer — has been shown to match much larger single-model setups on schema-bounded tasks.

The benchmark result that matters: "Well-orchestrated small models can match or exceed larger single-agent baselines, with performance driven primarily by the capacity of the Orchestrator rather than the size of execution sub-agents." For fork, the "orchestrator" is just the parent agent making per-turn decisions — that agent's quality is what determines whether the review pattern lifts results.

## Concrete shape (per step)

The reviewer's job, on one dispatch:

1. Read the step text and its acceptance criteria
2. Read the step's diff (just this step's commit)
3. Read the code with fresh eyes — design issues, mismatch with intent, missed edge cases
4. Report a **structured verdict**:

```
verdict: pass | changes-needed
issues:
  - src/auth.ts:42 — `parseEmail` doesn't handle null input, will throw at runtime
  - src/auth.ts:58 — missing error response for invalid email, returns 200 silently
```

`pass` → parent dispatches the next step. `changes-needed` → parent re-dispatches the implementer with the issues as the task. The reviewer itself doesn't loop — it reports once, the parent decides.

The key shift: the reviewer doesn't run linters or tests. The implementer already committed — hooks passed — so mechanical failures are already caught. The reviewer is a judgment layer on top, catching the things tools miss — and its output is structured so the parent agent can act on it without interpreting free-form prose.

## See also

- [03-agent-patterns.md](./03-agent-patterns.md) — where verification fits in plan-and-execute
- [05-reliability-techniques.md](./05-reliability-techniques.md) — schema-level enforcement complements behavioral verification
- [08-local-tooling.md](./08-local-tooling.md) — how existing tools wire up verification
