# Local tooling

What people actually use to run local-model coding workflows, and the concrete settings that matter. These are the tools you'll want to either compose with, or copy patterns from.

## The stack shape

A working local stack has four components:

```
┌──────────────────────────┐
│  Coding agent / IDE      │   Cline, Aider, Continue, OpenCode
├──────────────────────────┤
│  Model server            │   LM Studio, Ollama, llama.cpp, vLLM
├──────────────────────────┤
│  Model weights           │   Qwen3-Coder, DeepSeek, Llama, Phi
├──────────────────────────┤
│  Hardware                │   GPU (Nvidia/AMD), Apple Silicon, CPU
└──────────────────────────┘
```

Each layer has multiple options. The most common combinations:

- **Cline + LM Studio + Qwen3-Coder 30B** — Mac-friendly, easy setup
- **Cline + Ollama + Qwen2.5 Coder 7B** — Linux/Windows, lower spec
- **Aider + DeepSeek API** — cheap cloud (not technically local but same workflow)
- **Continue.dev + Ollama** — VS Code-native
- **OpenCode + Ollama** — terminal-only, minimal

## Cline + LM Studio + Qwen3-Coder 30B (reference setup)

The "let me code with a local model" setup that has converged. Documented by the Cline team.

### LM Studio settings

- **Context length:** 262,144 (the model's max)
- **KV Cache Quantization:** **DISABLED** — critical. Enabled cache "will persist context between tasks and create unpredictable behavior."
- **Quantization:** 4-bit (Q4_K_M typical) for most consumer hardware

### Cline settings

- **Provider:** LM Studio
- **Model:** `qwen/qwen3-coder-30b`
- **Context window:** 262,144 tokens
- **"Use compact prompt": ENABLED** — this is the single most important toggle. Cline's compact prompt is ~10% the size of the full system prompt.

### What "compact prompt" disables

- MCP tools (no external tool integration)
- Focus Chain (Cline's task-tracking feature)
- MTP features

These are real losses, but the trade is necessary. Full Cline prompts blow out small-model context budgets immediately. Local models cannot run Cline as designed for cloud frontier models — they need the diet version.

### Practical limits

- **Single file size:** Qwen3-Coder 30B via Ollama starts failing past ~300 lines per file in context. Split large files or pass summaries.
- **Context warmup:** Initial load takes time. Reload model if quality degrades mid-session.
- **Long sessions:** "Long-context inference gradually slows as context grows." Phase work, reset session at logical boundaries.

### When to fall back to cloud

- Repos exceeding local context budget
- Multi-hour sessions where degradation accumulates
- Tasks needing strong reasoning (architecture, debugging gnarly issues)

## Aider with local models

Aider is the most "Unix philosophy" of the coding tools: small, scriptable, file-based. Works well with local models because its prompts are already compact.

### Setup with DeepSeek API

```bash
aider --model deepseek/deepseek-chat
```

Requires `DEEPSEEK_API_KEY`. DeepSeek Chat V3 has historically led aider's code-editing benchmark.

### Setup with Ollama

```bash
aider --model ollama/qwen2.5-coder:7b
```

For 7B-tier models, Aider is gentler than Cline because it doesn't use a complex tool-calling system. It uses edit-block format that even small models can follow.

### Advanced model settings

Aider has per-model settings for context-window size, edit format (diff vs. whole-file), and a few other knobs. For a non-default model, define it in `.aider.model.metadata.json` or pass `--edit-format`.

For very small models (3–7B), try `--edit-format whole` (replace whole file) rather than `--edit-format diff` (apply a diff). Whole-file is easier for small models to produce correctly even if it costs more tokens.

## Continue.dev

A VS Code / JetBrains extension. Better for autocomplete than agentic work. Configuration in `~/.continue/config.json`.

For local setups:
- Pair Continue with Ollama for autocomplete (small model, e.g., DeepSeek Coder V2 7B)
- Use larger models (Qwen3-Coder 30B via LM Studio) for chat
- Qwen models advertise 1M token context windows; useful in theory, less so in practice with quantized local serving

## OpenCode

A terminal-only coding agent in the Aider tradition. Pairs naturally with Ollama for a minimal "local Claude Code" workflow. Less polished but works without an editor integration.

## Tool calling: what actually works locally

Reality check from the 2026 local-tool-calling evaluations:

| Setup | Tool call success rate |
|---|---|
| Qwen3-Coder 30B + LM Studio | 80–90% |
| Qwen2.5 Coder 7B + Ollama | 60–75% |
| DeepSeek Coder V2 7B + Ollama | 70–80% |
| Llama 3.3 8B + Ollama | 50–70% |
| Phi-4-mini 3.8B | <50%, often <30% |

Below the 70% threshold, plan around limited tool calling — either keep tools out of the loop (use editing formats like Aider's), or use very few, very simple tools.

## Hardware reference points

Real-world hardware → model fits:

| Hardware | Comfortable | Stretches |
|---|---|---|
| 8GB RAM laptop (no GPU) | Phi-4-mini Q4 | nothing bigger reliable |
| 16GB MacBook M1/M2 | Qwen2.5 Coder 7B Q4 | Qwen3-Coder 30B MoE struggling |
| 24GB MacBook M2/M3 Pro | Qwen3-Coder 30B Q4 | DeepSeek smaller variants |
| RTX 3060 12GB | Qwen3-Coder 30B Q4 | larger MoE |
| RTX 4070 12GB | Qwen3-Coder 30B Q5 | |
| RTX 5070 Ti 16GB | larger dense models 13B | 70B MoE quantized |
| 64GB+ unified memory | DeepSeek-V3.1 variants | frontier-local |

## Settings cheat sheet (for any local setup)

- Quantization: Q4_K_M default, Q5_K_M if you have RAM, Q8 if you're tool-calling-heavy
- KV cache quantization: **off** unless you've validated it doesn't break your workflow
- Temperature: 0.0–0.3 for coding (lower = more deterministic, what you usually want)
- Repetition penalty: 1.05–1.1 to suppress loops
- Max tokens: cap aggressively per response; small models meander otherwise
- Stop sequences: define them; saves tokens and prevents post-output garbage
- Context window: set to *actual* usable size, not the advertised max

## See also

- [05-reliability-techniques.md](./05-reliability-techniques.md) — why these settings matter
- [06-small-models.md](./06-small-models.md) — capability profiles per model
