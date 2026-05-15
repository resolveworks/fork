# Small models: what they can and can't do

A reality check on the capability tier you're actually working with. "Small" here means roughly 1B–30B parameters, runnable on consumer hardware. Below that is hobby territory; above that you're effectively running medium models.

## The capability cliff at 7B

The single most important number to internalize:

> **Below 7B, models effectively cannot do reliable tool calling.**

From a 2026 Llama-3B benchmark: sub-7B models show "low or zero tool invocation rates, confabulated responses in place of tool use, and catastrophic failure on multi-step tool chains." The failure isn't subtle — many of them effectively cannot do it at all, not just do it badly.

The reason given: tool calling requires roughly five cognitive tasks running in parallel (understand goal, select tool, format args, predict result, plan next step). Small models drop one before they start.

### Reliability threshold for production

The same source recommends a **70% tool-call success rate** as the floor for production use. Below that, your retry-and-recover overhead exceeds the win from automation.

Real numbers across sizes (approximate, from the Llama family at Q4):
- 1B: <10% tool-call success
- 3B: 20–40%
- 7B: 50–70%
- 7B fine-tuned (ToolACE-8B etc.): 80–90%
- 13–30B: 75–90%
- 30B+ fine-tuned: 90%+

The takeaway: **either use 7B+ models, or fine-tune for tool calling, or avoid tool-calling architectures entirely.**

## What does work at small scale

The agentic-AI research has been clear: SLMs work well for **narrow, repetitive, low-variation tasks** with constrained output. The NVIDIA position paper's framing: "agentic systems typically involve specialized tasks repetitively and with little variation."

What this looks like in practice:

| Task type | Sub-7B | 7–13B | 13–30B |
|---|---|---|---|
| Generate boilerplate from template | works | works | works |
| Fill in JSON schema (constrained) | works | works | works |
| Implement a function with given signature | hit-or-miss | works | works |
| Pick one of N options (enum tool call) | works | works | works |
| Free-form code generation | fails | hit-or-miss | works |
| Multi-file refactor | fails | hit-or-miss | hit-or-miss |
| Architectural decisions | fails | fails | hit-or-miss |
| Debug from stack trace | hit-or-miss | works | works |

The pattern: small models are **competent technicians** when the design is done. They're not designers.

## Sweet-spot models (as of 2026)

For local coding:

- **Phi-4-mini 3.8B** — fits 8GB systems; 15-20 tok/s on M1 MacBook Air. Useful for boilerplate and constrained outputs, not for tool calling.
- **Llama 3.3 8B / Mistral Small 3 7B** — Q5_K_M runs 30–50 tok/s on M2/M3 or RTX 4060. Decent tool calling with fine-tunes.
- **Qwen 2.5 Coder 7B / DeepSeek Coder V2 7B** — laptops with 16GB RAM via Ollama. Coding-specific.
- **Qwen3-Coder 30B MoE (3B active)** — flagship local coding model. 262K context. Runs on RTX 3060 12GB at Q4.
- **DeepSeek-V3.1 (large MoE)** — pushes the envelope; needs serious hardware.

The Qwen3-Coder 30B is the current default for "I want one model that handles coding work locally."

## Fine-tuning vs raw

For structured output (tool calling), training methodology matters more than parameter count. A well-fine-tuned 7B model often beats a general-purpose 13B model at tool calling.

This means: if you have a recurring narrow task (e.g., "always output a plan in this schema"), fine-tuning a smaller model on examples often beats prompting a bigger one. The xLAM and ToolACE datasets are reference points for this.

You probably don't want to fine-tune for an experimental setup. But know that this is the path that production small-model agent systems usually take.

## Quantization realities

Quantization is how you fit a model on consumer hardware. The trade-offs:

- **Q4** — ~60% VRAM reduction, ~2% quality loss. The default for most consumer setups.
- **Q5_K_M** — middle ground; ~50% VRAM, ~1% loss.
- **Q8** — ~30% VRAM reduction, ~0.5% quality loss. Use if you have the RAM.

For tool calling specifically, quantization hurts more than for general text generation. The structured output is sensitive to the exact token distributions, and quantization perturbs them. If you're tool-calling-heavy, run higher precision.

## Practical failure modes (catalog)

What you'll actually see when a small model fails:

1. **Hallucinated APIs.** Imports modules that don't exist, calls functions with wrong signatures. Fix: constrain via plan, verify via type-check.
2. **Wrong tool entirely.** Picks a similar-looking tool. Fix: fewer tools per prompt, enums over free text.
3. **Right tool, wrong args.** Parameter confusion. Fix: flatter schemas, fewer required params, examples.
4. **Output past the structured part.** Emits valid JSON then keeps going. Fix: stop sequences, constrained decoding.
5. **Repetition loops.** "Step 1, step 1, step 1…" Fix: repetition penalty, max-tokens cap.
6. **Lost the thread mid-task.** Forgets what it was doing. Fix: shorter chunks, plan file re-read each step.
7. **Pleased-to-please.** Agrees with the user even when wrong. Fix: external verification, never trust self-review.
8. **Context drowning.** Quality degrades sharply past some threshold (often well before stated context window). Fix: load less, summarize history.

## What this means for the workflow

The constraint isn't "make the model smarter." It's "give the model fewer chances to be dumb." Concretely:

- Each call should have **one** decision to make
- Each call should have **all** the context to make that decision (and no more)
- Each call should produce output in **a strict format** that downstream consumers can rely on
- Each call's output should be **verified externally** before it's accepted

This is what the rest of this knowledge base is about.

## See also

- [05-reliability-techniques.md](./05-reliability-techniques.md) — constrained decoding for the structured-output problem
- [08-local-tooling.md](./08-local-tooling.md) — concrete configurations for the models above
- [09-applying-to-fork.md](./09-applying-to-fork.md) — designing fork for these capability limits
