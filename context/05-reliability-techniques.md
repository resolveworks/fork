# Reliability techniques

How to get reliable outputs from a model that isn't reliable on its own. The dominant technique is **constrained decoding** — forcing the output to conform to a schema during generation. There are tradeoffs.

## Constrained decoding

### What it is

At each generation step, an LLM produces a probability distribution over the next token. Constrained decoding **filters that distribution** to only tokens that keep the output valid under a formal grammar (derived from a JSON Schema, regex, or BNF). Invalid tokens are masked out entirely.

The result: the model literally cannot produce malformed output. Not "rarely produces" — *cannot*.

### What it buys you

- **Schema validity rates above 99%** with small models (1–12B) using guided decoding
- Near-zero parsing failures, which is the dominant production failure mode for tool calling
- Reliable downstream pipelines — every field is where it's supposed to be, every time

Reference points:
- XGrammar (default backend for vLLM, SGLang, TensorRT-LLM as of March 2026): <40µs per token, near-zero overhead for JSON generation
- Pydantic-derived schemas work directly with major inference engines

### The trade-off

**Strict format constraints can impair reasoning.** Research shows that the more restrictive the output grammar, the more the model's complex, multi-step reasoning ability degrades. The intuition: the model is essentially "thinking in JSON tokens" instead of in natural language, and the linguistic tokens that would carry its reasoning are masked out.

The practical implication: don't constrain *everything*. Pattern that works:

1. Let the model think in free text (chain-of-thought, scratchpad)
2. Constrain only the final structured output (the tool call, the JSON payload, the plan step format)

This is what OpenAI's "structured outputs" mode and Anthropic's tool-use schema both effectively do.

## Schemas as design contracts

Even without constrained decoding, schemas serve as design contracts:

- The plan format is a schema (sections, checklist items)
- The implementer's output (diffs) has a schema (file path + content)
- The reviewer's output has a schema (pass/fail + errors)

The agent doesn't need fancy decoding to benefit — just clear formats with examples. With a small model, *include the schema and an example in the prompt*. Don't trust the model to invent the format.

## Other reliability levers

### Tool-call shape

For sub-7B models, the tool-call schema matters enormously. Best practices from the field:

- **Flat schemas** beat nested. Avoid deep objects.
- **Required parameters only**. Optional params confuse small models.
- **Enums beat free-text** wherever possible (e.g. agent name as enum, not string)
- **Short parameter names** with descriptive descriptions
- **One tool per call**. Multi-tool prompts cause 7B-ish models to fumble.

### Few-shot examples

For any structured output, include 1–2 worked examples in the prompt. Small models latch onto example format much more reliably than abstract format descriptions. Examples are nearly free in tokens compared to the cost of a malformed output.

### Output prefixing

If the format is "first a header, then JSON", prefix the assistant's response with `## Plan\n\n` or similar in the prompt. This is a soft constraint (no decoder-level enforcement) but works well with cooperative models.

### Stop sequences

Define stop sequences aggressively. If the format ends with `</plan>`, set that as a stop sequence. Prevents the model from running on and emitting garbage after the structured part.

### Repetition penalties

Small models loop. A modest repetition penalty (1.05–1.1) cuts down on the "step 1, step 1, step 1…" failure mode without distorting valid output.

## Reliability budget

A useful frame: every prompt has a "reliability budget" — total complexity the model can handle before it starts making errors. You spend budget on:

- Length of input context
- Complexity of the output schema
- Number of decisions the model must make
- Ambiguity in the task

You can reclaim budget by:

- Cutting context to just what's needed
- Constraining the output
- Pre-deciding for the model (in the plan)
- Sharpening the task description

For small models, you have a *small* budget. Spend it on the decisions you actually need the model to make. Everything else should be pinned.

## When *not* to constrain

- During exploratory chain-of-thought (free text helps reasoning)
- When the format isn't well-defined yet (schema-design phase)
- When the task is open-ended and "correctness" doesn't map to a structure

The rule: **constrain the I/O boundary, free the interior**.

## See also

- [06-small-models.md](./06-small-models.md) — what fails at sub-7B and why schemas help
- [03-agent-patterns.md](./03-agent-patterns.md) — schemas in planner/executor interfaces
- [04-verification.md](./04-verification.md) — schema validation as an external verification signal
