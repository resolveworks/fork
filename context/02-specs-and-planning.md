# Planning

The phase between "human knows what they want" and "model writes code." Its job is to produce a **plan file** — a durable artifact the implementer reads to do its work.

This file used to split spec and plan into two artifacts. In practice, for most setups (and for fork specifically), a single plan file plus the project's `AGENTS.md` is enough. The split into spec+plan is one school's preference, not field consensus. See the end of this file for when the split actually pays off.

## What a plan is

An ordered list of *implementable steps*. Each step:

- Names the file(s) it touches
- States in one line what changes
- Has an acceptance criterion (test passes, type-checks, etc.)
- Is small enough that a small model can do it without loading half the codebase

The plan is a **file**, not transient prompt text. File-ness unlocks:

- Human edits before execution
- Re-reading on each dispatch (no need to re-derive)
- Resumability across sessions

The plan does **not** track anything. It's read-only data — a list of steps. The parent agent reads it, picks a step, dispatches the implementer. There's no "current step", no "done marker", no retry counter anywhere.

## Plan format

Simple. Numbered list of steps. No frontmatter, no checkboxes, no status markers.

```markdown
# Plan: <slug>

## Goal
<one sentence>

## Steps
1. **<file>** — <what changes>
   - acceptance: <how we know it worked>
2. **<file>** — <what changes>
   - acceptance: <how we know it worked>
...

## Risks
<things to watch for>
```

The parent agent passes step N's text to the implementer. The implementer doesn't see the other steps. The plan is read from the outside, never written.

## What makes plans fail

The same failure mode as specs in the broader literature: **too vague**.

| Vague | Concrete |
|---|---|
| "Add validation" | "`src/auth.ts` — add `validateEmail(input: string): Result<Email, ValidationError>` using zod" |
| "Hook it up" | "`src/server.ts` — call `validateEmail` in the `/signup` POST handler; 400 on error" |
| "Fix the tests" | "`src/auth.test.ts` — add 3 cases: empty string → error, missing @ → error, valid → ok" |
| "Handle errors properly" | "All async functions throw on failure; top-level handler in `errors.ts` reports" |

The general rule: anything the small model would have to *infer* should instead be *stated* in the plan. Inference is where derpy models go wrong.

## Micro-plans

"Micro-specs are focused specification documents targeting single features or components — keeping LLM context manageable while enabling rapid iteration."

This is the unit you actually work in. Don't write one giant plan for a whole feature; write one plan per logical chunk that fits in a single small-model session. A feature with five chunks → five plan files. The implementer only ever loads one at a time.

## What plans for derpy models must include

When the executor is a small/local model, the plan has to do work the model can't:

- **Spell out file paths exactly.** Don't say "the auth handler" — say `src/auth/handler.ts`.
- **Spell out function signatures.** Don't say "add a validation function" — give the signature.
- **Spell out imports.** If a step needs `zod`, list it in the step.
- **Resolve naming up front.** Pick names in the plan, don't leave them to the model.
- **State acceptance.** Concrete shell command or test name, not "make sure it works."

## Roles around the plan

The Plan-then-Execute literature is clear that **weak planners are the bottleneck**. The cost-quality math:

- Strong planner + weak executor → quality depends on planner quality; cost is moderate
- Weak planner + strong executor → executor wastes effort fixing planner mistakes
- Weak planner + weak executor → reliable only on small, well-scoped chunks

So if you have access to a stronger model at all (cloud, API, or a heavier local model), use it for planning, not implementation. If you're fully local on small models, the plan must lean on the *human* and on stronger external tooling (search, docs, type-checkers) to compensate.

## When to split into spec + plan

The two-file split (separate `specs/<slug>.md` for problem/constraints, separate `plans/<slug>.md` for steps) pays off when:

- A human is reviewing and editing intent and execution separately
- Different agents need different views (e.g., reviewer reads the spec to check acceptance; implementer reads the plan to make changes)
- A feature is large enough that one plan won't hold all the steps

For most workflows — and for fork — one plan file is enough. The plan's "Goal" section carries the intent; the steps carry the execution.

## See also

- [03-agent-patterns.md](./03-agent-patterns.md) — architectural patterns for planner/executor systems
- [07-context-engineering.md](./07-context-engineering.md) — AGENTS.md as the project-level rules
- [09-applying-to-fork.md](./09-applying-to-fork.md) — turning fork's `tasks/` dir into plan files
