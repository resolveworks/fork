# Knowledge base: coding with small/dumb local models

A curated synthesis of what actually works (and what doesn't) when you're using local LLMs in the 3B–30B range to do real coding work. The goal is to inform the design of this repo (`fork`) — a pi extension that splits work between subagents — but the patterns are general.

## Why this exists

Local models in the small-to-medium range are derpy. They lose track, hallucinate APIs, fumble tool calls, drown in long context, and pick the wrong abstraction. But the field has spent 2024–2026 figuring out how to get useful work out of them anyway. The recipes converge. This knowledge base distills the convergence.

## TL;DR

The pattern that has won is **plan → small chunks → verify**, with each step happening in a fresh, narrow context window. Quality comes from constraining the system, not from the model being smart.

Six concrete levers in order of impact:

1. **Narrow the task.** One function, one chunk, one plan step — not "implement the feature."
2. **Externalize the plan as a file.** Plans are artifacts the human can edit and agents re-read, not transient prompt text. Keep them read-only — the parent agent picks which step to dispatch next, the plan itself doesn't need to remember anything.
3. **Verify with external signals.** Tests, type-checks, linters > self-critique. A 2023 result still holds: pure self-review *lowers* accuracy.
4. **Use schemas to pin reliability.** Constrained decoding makes a 7B model emit valid JSON 99% of the time. Reliability ≠ smartness.
5. **Engineer the context.** AGENTS.md / CLAUDE.md at the repo root carries project rules. Each subagent call gets only project rules + the one step + named files.
6. **Don't expect tool-calling miracles below 7B.** Sub-7B models effectively cannot reliably chain tool calls. Plan around it.

## Files in this knowledge base

| File | Topic |
|---|---|
| [01-core-loop.md](./01-core-loop.md) | The proven loop end-to-end: spec → plan → chunk → verify |
| [02-specs-and-planning.md](./02-specs-and-planning.md) | Plan file shape; micro-plans; what to spell out for derpy models |
| [03-agent-patterns.md](./03-agent-patterns.md) | Plan-and-Execute, ReWOO, LLMCompiler; and the mixing-models caveat |
| [04-verification.md](./04-verification.md) | Two-layer verification: pre-commit hooks (mechanical, per step) + reviewer (judgment, per step); structured verdicts |
| [05-reliability-techniques.md](./05-reliability-techniques.md) | Constrained decoding, schemas, the reasoning trade-off |
| [06-small-models.md](./06-small-models.md) | What SLMs can and can't do; the 7B tool-calling cliff |
| [07-context-engineering.md](./07-context-engineering.md) | AGENTS.md, hierarchical context, what to load when |
| [08-local-tooling.md](./08-local-tooling.md) | Cline + LM Studio, Aider, Continue concrete settings |
| [09-applying-to-fork.md](./09-applying-to-fork.md) | Synthesis: what this repo should look like |
| [sources.md](./sources.md) | All references |

Start with [01-core-loop.md](./01-core-loop.md) if you read one file. Read [09-applying-to-fork.md](./09-applying-to-fork.md) before changing this repo's code.
