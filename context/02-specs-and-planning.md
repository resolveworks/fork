# Specs and planning

The first two phases of the core loop ([01-core-loop.md](./01-core-loop.md)). Both produce **files**, not transient prompt text. The file-ness is the point — humans can edit them, agents re-read them, and they survive across sessions and context resets.

## Specs

### What goes in a spec

Addy Osmani's six structural elements for AI-agent specs, refined across thousands of practitioners:

1. **Commands** — Executable commands with full flags (e.g., `npm test --silent`)
2. **Testing** — Framework details, test file locations, coverage expectations
3. **Project structure** — Explicit directory organization
4. **Code style** — *Real examples* demonstrating preferred conventions, not abstract rules
5. **Git workflow** — Branch naming, commit formats, PR requirements
6. **Boundaries** — Three-tier: "always do" / "ask first" / "never do"

Plus the feature-specific content:
- Problem statement and acceptance criteria
- Architecture decisions (with rationale, not just "use X")
- Data models / schemas
- Testing strategy for *this feature*
- Non-goals — what's explicitly out of scope

### What makes specs fail

"Most agent files fail because they're too vague." Concrete vs. vague:

| Vague | Concrete |
|---|---|
| "Use modern React" | "React 18.3 with hooks; no class components; functional state via `useReducer` for forms" |
| "Follow our style" | (paste a 20-line example from the codebase) |
| "Handle errors properly" | "All async functions throw on failure; the top-level handler in `errors.ts` catches and reports" |
| "Don't break anything" | "Never modify files in `legacy/`; never change public API signatures in `api/v1/`" |

### Two specs, not one

The pattern that works in practice:

- **Project-level spec** — lives at the repo root as `AGENTS.md` or `CLAUDE.md`. Loaded into *every* session. Contains rules that apply globally: commands, structure, style, conventions, boundaries.
- **Feature-level spec** — lives in `specs/<slug>.md` or similar. Loaded for the feature being worked on. Contains problem statement, acceptance criteria, design.

The project-level spec is the answer to "what would I tell a senior engineer joining on their first day?" The feature-level spec is "what does this specific change need to do?"

## Plans

### What a plan is

A plan turns a feature-spec into an ordered list of *implementable steps*. Each step:

- Names the file(s) it touches
- States in one line what changes
- Has an acceptance criterion (test passes, type-checks, etc.)
- Is small enough that a 7B model can do it without loading half the codebase

The plan itself is a file. This is the central insight you've already arrived at on this repo. Plans-as-files unlock:

- Human edits before execution
- Re-reading by the implementer on each step (no need to re-derive)
- Status tracking (which steps are done, which failed, which are blocked)
- Resumability across sessions

### Plan format that works

A schema-shaped plan is more useful than freeform prose, because the implementer can iterate over steps mechanically. Example structure:

```markdown
# Plan: <slug>

## Goal
<one sentence>

## Spec
<link to specs/<slug>.md>

## Steps
1. [ ] **<file>** — <what changes>
   - Acceptance: <how we know it worked>
2. [ ] **<file>** — <what changes>
   - Acceptance: <how we know it worked>
...

## Risks
<things to watch for>
```

The checkboxes give state. After each step the implementer marks it done and (if needed) appends notes. The plan file becomes the execution log.

### Micro-specs

"Micro-specs are focused specification documents targeting single features or components — keeping LLM context manageable while enabling rapid iteration."

This is the unit you actually work in. Don't write one giant plan for the whole feature; write one plan per logical chunk that fits in a single small-model session. A feature with five chunks → five plan files. The agent only ever loads one at a time.

### Plans for derpy models specifically

When the executor is a small/local model, the plan has to do work the model can't:

- **Spell out file paths exactly.** Don't say "the auth handler" — say `src/auth/handler.ts`.
- **Spell out function signatures.** Don't say "add a validation function" — say `function validateEmail(input: string): Result<Email, ValidationError>`.
- **Spell out imports.** If a step needs `zod`, list it in the step.
- **Resolve naming up front.** Pick names in the plan, don't leave them to the model.

The general rule: anything the small model would have to *infer* should instead be *stated* in the plan. Inference is where derpy models go wrong.

## Roles in this phase

The Plan-then-Execute literature is clear that **weak planners are the bottleneck**. The cost-quality math:

- Strong planner + weak executor → quality depends on planner quality; cost is moderate
- Weak planner + strong executor → executor wastes effort fixing planner mistakes
- Weak planner + weak executor → reliable only on small, well-scoped chunks

So if you have access to a stronger model at all (cloud, API, or a heavier local model), use it for planning, not implementation. If you're fully local on small models, the plan must lean on the *human* and on stronger external tooling (search, docs, type-checkers) to compensate.

## See also

- [03-agent-patterns.md](./03-agent-patterns.md) — architectural patterns for planner/executor systems
- [07-context-engineering.md](./07-context-engineering.md) — AGENTS.md as the project-level spec
- [09-applying-to-fork.md](./09-applying-to-fork.md) — turning fork's `tasks/` dir into plan files
