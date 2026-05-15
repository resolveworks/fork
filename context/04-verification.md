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

## Building a reviewer for coding work

Concrete external signals for code:

1. **Compile / type-check.** Cheapest and highest signal. Run on every diff.
2. **Tests.** The plan should generate or include the tests. Failures feed back as text.
3. **Lint.** Catches style drift and some classes of bugs.
4. **Run the code.** For scripts, just run it. For services, hit the endpoint.
5. **Diff against spec.** A reviewer agent reads the diff *with the spec loaded* and checks acceptance criteria. This is where soft signals enter — but they're anchored against a written spec, not vibes.

Layer them. Compile first (instant). Lint next (fast). Tests (slower). Reviewer agent last (slowest, most context).

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

## Concrete shape (per chunk)

The reviewer's job, on one dispatch:

1. Read the diff (or apply it and inspect)
2. Run type-check / lint / tests as shell commands
3. Read the code with fresh eyes — check for design issues, mismatch with intent, missed edge cases
4. Report: pass, or the specific failures (mechanical and judgment-based)

That's it — one pass, one report. The parent agent (or human) decides whether to re-dispatch the implementer with the errors, accept the diff anyway, or give up. The reviewer itself doesn't loop.

The point: most failures get caught by shell commands (type-check, lint, tests). Those are non-LLM, fast, and cheap. The reviewer is mostly a wrapper around running them and aggregating output — but it also brings fresh eyes, which mechanical checks alone miss.

## See also

- [03-agent-patterns.md](./03-agent-patterns.md) — where verification fits in plan-and-execute
- [05-reliability-techniques.md](./05-reliability-techniques.md) — schema-level enforcement complements behavioral verification
- [08-local-tooling.md](./08-local-tooling.md) — how existing tools wire up verification
