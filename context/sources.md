# Sources

All references collected from the research. Grouped by topic; cited inline in the other files.

## Spec-driven development / workflows

- [Addy Osmani — My LLM coding workflow going into 2026](https://addyosmani.com/blog/ai-coding-workflow/)
- [Addy Osmani — How to write a good spec for AI agents](https://addyosmani.com/blog/good-spec/)
- [mosofsky/spec-then-code (GitHub)](https://github.com/mosofsky/spec-then-code)
- [Thoughtworks — Spec-driven development: 2025 engineering practices](https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices)
- [Mattia D'Argenio — The Spec-to-Code Workflow](https://medium.com/@mattia.darge/the-spec-to-code-workflow-building-software-using-only-llms-5e025cd28de0)
- [Jerome VDL — Spec-driven development, Back to the Future?!](https://jeromevdl.medium.com/spec-driven-development-back-to-the-future-d71fde8d47cf)

## Planner / executor patterns

- [LangChain — Plan-and-Execute Agents](https://www.langchain.com/blog/planning-agents)
- [akitaonrails — Is it worth ($$) mixing 2 models? (Planner + Executor)](https://akitaonrails.com/en/2026/04/25/llm-benchmarks-vale-a-pena-misturar-2-modelos/)
- [akitaonrails/llm-coding-benchmark (GitHub)](https://github.com/akitaonrails/llm-coding-benchmark/blob/master/docs/success_report.multi_model.md)
- [arxiv 2509.08646 — Architecting Resilient LLM Agents: Plan-then-Execute](https://arxiv.org/abs/2509.08646)
- [Agent Patterns docs — Plan & Solve](https://agent-patterns.readthedocs.io/en/stable/patterns/plan-and-solve.html)
- [Agent Patterns docs — LLM Compiler](https://agent-patterns.readthedocs.io/en/stable/patterns/llm-compiler.html)
- [Agent Patterns docs — ReWOO](https://agent-patterns.readthedocs.io/en/stable/patterns/rewoo.html)
- [doug.is — Planner/Executor: A Systematic Approach](https://www.doug.is/thinking/about/development/plannerexecutor-a-systematic-approach-to-llm-guided-development)
- [Emergent Mind — Planner-Executor Agentic Framework](https://www.emergentmind.com/topics/planner-executor-agentic-framework)
- [IBM — What is ReWOO?](https://www.ibm.com/think/topics/rewoo)
- [arxiv 2305.18323 — ReWOO: Decoupling Reasoning from Observations](https://arxiv.org/abs/2305.18323)

## Verification / self-correction

- [Medium — Agent Loops: generate → evaluate → revise (Jaideep Ray)](https://medium.com/better-ml/verbal-reinforcement-in-agent-loops-generate-evaluate-revise-042d7ba634e0)
- [Emergent Mind — Online Self-Correction Loop](https://www.emergentmind.com/topics/online-self-correction-loop)
- [DEV — Stop LLMs from Lying: Self-Correcting Agents with the Reflection Pattern](https://dev.to/programmingcentral/stop-llms-from-lying-build-self-correcting-agents-with-the-reflection-pattern-1df)
- [Vadim's blog — The Research on LLM Self-Correction](https://vadim.blog/the-research-on-llm-self-correction)
- [teacherpeterpan/self-correction-llm-papers (GitHub)](https://github.com/teacherpeterpan/self-correction-llm-papers)
- [MIT Press TACL — When Can LLMs Actually Correct Their Own Mistakes?](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00713/125177/When-Can-LLMs-Actually-Correct-Their-Own-Mistakes)
- [OpenAI — LLM Critics Help Catch LLM Bugs (PDF)](https://cdn.openai.com/llm-critics-help-catch-llm-bugs-paper.pdf)
- [arxiv 2510.16062 — Can LLMs Correct Themselves?](https://arxiv.org/html/2510.16062v1)

## Structured output / constrained decoding

- [Aidan Cooper — A Guide to Structured Outputs Using Constrained Decoding](https://www.aidancooper.co.uk/constrained-decoding/)
- [Let's Data Science — How Structured Outputs and Constrained Decoding Work](https://letsdatascience.com/blog/structured-outputs-making-llms-return-reliable-json)
- [arxiv 2501.10868 — JSONSchemaBench: Evaluating Constrained Decoding](https://arxiv.org/html/2501.10868v3)
- [Saibo-creator/Awesome-LLM-Constrained-Decoding (GitHub)](https://github.com/Saibo-creator/Awesome-LLM-Constrained-Decoding)
- [Brics Econ — Constrained Decoding for LLMs](https://brics-econ.org/constrained-decoding-for-llms-how-json-regex-and-schema-control-improve-output-reliability)
- [Dataiku — Taming LLM Outputs: Guide to Structured Text Generation](https://www.dataiku.com/stories/blog/your-guide-to-structured-text-generation)

## Small language models (SLMs) for agentic systems

- [arxiv 2506.02153 — Small Language Models are the Future of Agentic AI (NVIDIA)](https://arxiv.org/abs/2506.02153)
- [arxiv 2510.03847 — SLMs for Agentic Systems: A Survey](https://arxiv.org/abs/2510.03847)
- [arxiv 2510.07772 — Systematic Decomposition of Complex LLM Tasks](https://arxiv.org/html/2510.07772v1)
- [Amazon Science — Task decomposition and smaller LLMs](https://www.amazon.science/blog/how-task-decomposition-and-smaller-llms-can-make-ai-more-affordable)
- [Cobus Greyling — Why SLMs Are Revolutionising Agentic Workflows](https://cobusgreyling.medium.com/why-small-language-models-slms-are-revolutionising-agentic-workflows-209e265d5a12)
- [Aisera — SLM Agents: Why Small Language Models are the Future of AI](https://aisera.com/blog/small-language-model-agents/)

## Small model tool calling

- [DEV — Why Small LLMs Fail at Tool Calling: Llama 3B Benchmark](https://dev.to/anak_wannaphaschaiyong_11/why-small-llms-fail-at-tool-calling-the-shocking-discovery-from-our-llama-3b-benchmark-5lg)
- [JD Hodges — I Tested 13 Local LLMs on Tool Calling: 2026 Eval Results](https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/)
- [Ridgerun AI — Introducing Juniper: Fine-Tuned Small Local Model for Function Calling](https://www.ridgerun.ai/post/introducing-juniper-fine-tuned-small-local-model-for-function-calling)
- [Hugging Face — Fine-tuning LLMs for Function Calling with xLAM](https://huggingface.co/learn/cookbook/function_calling_fine_tuning_llms_on_xlam)
- [arxiv 2512.07497 — How Do LLMs Fail In Agentic Scenarios?](https://arxiv.org/pdf/2512.07497)
- [Wandb — Fine-tuning LLMs for function-calling](https://wandb.ai/wandb/function-calling-finetuning/reports/Fine-tuning-LLMs-for-function-calling--VmlldzoxMjgxMTgxMg)

## Local tooling

- [Cline — Local coding stack with Qwen3 Coder 30B](https://cline.bot/blog/local-models)
- [Cline — Three Ways to Code for Free (v3.26.6)](https://cline.bot/blog/cline-v3-26-6-three-ways-to-code-for-free)
- [Aider — DeepSeek docs](https://aider.chat/docs/llms/deepseek.html)
- [Aider — Advanced model settings](https://aider.chat/docs/config/adv-model-settings.html)
- [Vlad Iliescu — Aider and Continue with o3-mini and DeepSeek-R1](https://vladiliescu.net/configuring-aider-continue-with-o3-mini-and-deepseek-r1/)
- [SitePoint — Local AI Coding Assistant: VS Code + Ollama + Continue](https://www.sitepoint.com/local-ai-coding-assistant-vscode-ollama-continue/)
- [Sergio Azevedo — My Local AI Setup on the M4 Pro: Qwen 3.6 and Cline](https://sergioazevedo.me/my-local-ai-setup-on-the-m4-pro-a-journey-with-qwen-3-6/)
- [DEV — Qwen3-Coder-Next: Complete 2026 Guide](https://dev.to/sienna/qwen3-coder-next-the-complete-2026-guide-to-running-powerful-ai-coding-agents-locally-1k95)
- [DEV — Every AI Coding CLI in 2026](https://dev.to/soulentheo/every-ai-coding-cli-in-2026-the-complete-map-30-tools-compared-4gob)

## Local model selection

- [KDnuggets — Top 5 Small AI Coding Models You Can Run Locally](https://www.kdnuggets.com/top-5-small-ai-coding-models-that-you-can-run-locally)
- [Sitepoint — Best Local LLM Models 2026: Developer Comparison](https://www.sitepoint.com/best-local-llm-models-2026/)
- [Labellerr — 5 Open-Source Coding LLMs You Can Run Locally in 2026](https://www.labellerr.com/blog/best-coding-llms/)
- [Hugging Face blog — Best Open-Source LLM Models in 2026](https://huggingface.co/blog/daya-shankar/open-source-llms)
- [Pooya Golchian — Local AI Coding Models 2026](https://pooya.blog/blog/local-ai-coding-models-ollama-qwen-deepseek-2026/)
- [n8n Blog — How to Run a Local LLM 2025](https://blog.n8n.io/local-llm/)
- [mslinn — Best Local LLMs for Coding](https://www.mslinn.com/llm/coding-llms.html)
- [BentoML — Navigating Open-Source LLMs](https://www.bentoml.com/blog/navigating-the-world-of-open-source-large-language-models)

## Context engineering

- [Augment Code — How to Build Your AGENTS.md (2026)](https://www.augmentcode.com/guides/how-to-build-agents-md)
- [Hivetrail — AGENTS.md vs CLAUDE.md](https://hivetrail.com/blog/agents-md-vs-claude-md-cross-tool-standard)
- [Martin Fowler — Context Engineering for Coding Agents](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)
- [Agensi — Context Engineering for AI Agents | SKILL.md Guide](https://www.agensi.io/learn/context-engineering-ai-agents)
- [Packmind — Context Engineering for Teams](https://packmind.com/context-engineering-ai-coding/how-to-implement-context-engineering/)
- [arxiv 2508.08322 — Context Engineering for Multi-Agent LLM Code Assistants](https://arxiv.org/html/2508.08322v1)
- [arxiv 2510.21413 — Context Engineering for AI Agents in OSS](https://arxiv.org/html/2510.21413v1)
- [arxiv 2601.20404 — On the Impact of AGENTS.md Files](https://arxiv.org/html/2601.20404v2)

## TDD with LLMs

- [arxiv 2402.13521 — Test-Driven Development for Code Generation](https://arxiv.org/abs/2402.13521)
- [IEEE — Test-Driven Development and LLM-based Code Generation (ASE 2024)](https://ieeexplore.ieee.org/document/10764936/)
- [OpenReview — Tests as Instructions: TDD Benchmark for LLM Code Gen](https://openreview.net/forum?id=sqciWyTm70)
- [Codemanship — Why TDD Works So Well in AI-Assisted Programming](https://codemanship.wordpress.com/2026/01/09/why-does-test-driven-development-work-so-well-in-ai-assisted-programming/)
- [Rogério Chaves — Complete guide for TDD with LLMs](https://rchavesferna.medium.com/the-complete-guide-for-tdd-with-llms-1dfea9041998)
- [arxiv 2601.03878 — Understanding Specification-Driven Code Generation with LLMs](https://arxiv.org/html/2601.03878v1)
