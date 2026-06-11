---
id: t11982-local-model-fit
tasks: [T11982]
kind: feat
summary: "feat(T11982): local-model fit ranking + cleo llm fit (wizard building block)"
---

Adds RAM/VRAM-aware local model fit ranking as a wizard building block for the Ollama setup wizard (T11983).

- **`packages/core/src/llm/local-model-fit.ts`** — new module: hardware detection (RAM via `os.totalmem`/`/proc/meminfo` MemAvailable on Linux; VRAM via `nvidia-smi`/`rocm-smi`/Apple Silicon unified-memory heuristic; graceful null on failure); curated open-weight model candidate table (`LOCAL_MODEL_CANDIDATES`) with per-model `minRamGb`/`recommendedRamGb`/`minVramGb`/`recommendedVramGb`; `rankLocalModelFit()` returning a `LocalModelFitEnvelope` with hardware summary, Ollama liveness, pulled-model list, and 2–3 ranked recommendations; hard 4 GB floor (no recommendation below this; `qwen2:0.5b` deliberately excluded from the table). Ollama liveness re-uses `probeOllamaAlive` from `cross-provider-selector.ts`; model list via HTTP `/api/tags` (no shell-out).
- **`packages/cleo/src/cli/commands/llm.ts`** — `cleo llm fit` subcommand added (inline `defineCommand`, not `makeLlmSubcommand` because the impl is bespoke). Outputs human-readable hardware summary + ranked model list with pull commands on TTY; LAFS JSON envelope with `--json`.
- **Vendor decision**: inspected `github.com/AlexsJones/llmfit` (Go, MIT). Vendored the IDEA (RAM-threshold gating + VRAM boost + ranked output) as a TS-native re-implementation. Did not add the Go binary or a cross-language dependency — thresholds are calibrated independently from Ollama docs and Hugging Face model cards.
- **Gate-13 clean**: no transport/SDK construction, no `process.env.*_API_KEY` reads, no new `resolveLLMFor*` exports. Model ID literals live exclusively in `LOCAL_MODEL_CANDIDATES` (the data table), not in logic.
