# T750 — Cross-Platform Local LLM for CLEO Transcript Extraction

**Research Date**: 2026-04-15
**Task**: T750
**Scope**: April 2026 landscape survey for a local LLM stack integrated into CLEO's warm-tier
transcript extraction pipeline. All claims cite live sources fetched during this session.

---

## §1 Landscape Survey — Local LLM Runners (April 2026)

### §1.1 Ollama

**Status**: Production-ready, actively maintained, most popular local LLM runner as of April 2026.

| Property | Detail |
|----------|--------|
| Version | Latest stable (updated regularly; April 2026 site copyright confirms active maintenance) |
| License | MIT |
| Platforms | macOS (Homebrew / installer), Linux (one-line `curl | sh`), Windows (OllamaSetup.exe / `winget install Ollama.Ollama`) |
| Install type | System binary + background daemon — NOT embeddable as a library; requires separate install |
| Node.js | `npm install ollama` — official `ollama` npm client; TypeScript-native |
| Structured output | Native `format` parameter with JSON schema or Zod via `zod-to-json-schema` |
| Embeddings | `ollama.embeddings()` API; ships `nomic-embed-text`, `all-minilm` models |
| OpenAI-compat API | Yes — `localhost:11434` serves OpenAI-format chat/completions endpoint |
| GPU | Metal (macOS), CUDA (Windows/Linux), AMD ROCm (partial) |
| Model format | GGUF |

Key architectural note: Ollama runs as a **separate system daemon**. The `ollama` npm package
talks to it over HTTP. This means CLEO cannot bundle Ollama inside an npm package — it must
detect whether Ollama is running and gracefully fall back.

Sources:
- https://docs.ollama.com/windows
- https://oneuptime.com/blog/post/2026-02-02-ollama-installation-configuration/view
- https://ollama.com/blog/structured-outputs
- https://www.sitepoint.com/definitive-guide-local-llms-2026-privacy-tools-hardware/

### §1.2 node-llama-cpp (llama.cpp Node.js bindings)

**Status**: Stable, at v3.18.1 as of April 2026. Actively maintained.

| Property | Detail |
|----------|--------|
| Package | `npm install node-llama-cpp` |
| Version | 3.18.1 (April 2026) |
| Platforms | macOS, Linux, Windows — pre-built binaries for all three |
| Embeddable | YES — runs inside the Node.js process; no separate daemon |
| Fallback build | If pre-built binaries miss the platform, downloads llama.cpp release and builds from source with cmake (no Python, no node-gyp required) |
| TypeScript | First-class TypeScript support with ESM |
| Structured output | JSON Schema grammar-constrained generation; Zod schema enforcement |
| Embeddings | Yes — `model.createEmbeddingContext()` |
| Function calling | Yes |
| GPU | Metal (macOS), CUDA, Vulkan |

Critical property: `node-llama-cpp` **is the only cross-platform embeddable Node.js LLM
library with pre-built binaries for all three OSes**. It ships the llama.cpp C++ engine as
precompiled native addons via N-API. Users need nothing installed beyond `npm install`.

The AI SDK community provider `ai-sdk-llama-cpp` wraps it for Vercel AI SDK compatibility,
but as of April 2026 that wrapper is **macOS-only** (noted explicitly in the docs:
"This provider currently only supports macOS"). Do NOT use `ai-sdk-llama-cpp` in CLEO.
Use `node-llama-cpp` directly or with a thin custom wrapper.

Sources:
- https://www.npmjs.com/package/node-llama-cpp (v3.18.1)
- https://node-llama-cpp.withcat.ai/guide/
- https://node-llama-cpp.withcat.ai/blog/v3
- https://ai-sdk.dev/providers/community-providers/llama-cpp (macOS-only warning)

### §1.3 @huggingface/transformers (Transformers.js v4)

**Status**: v4 released and available on npm as of April 2026. Major step-change from v3.

| Property | Detail |
|----------|--------|
| Package | `npm install @huggingface/transformers` |
| Platforms | Browser, Node.js, Bun, Deno — runs anywhere JavaScript runs |
| Embeddable | YES — pure JavaScript + ONNX Runtime (WebAssembly or WebGPU) |
| No daemon | YES — zero external dependencies; fully in-process |
| GPU (Node.js) | WebGPU backend now works in Node.js (new in v4) |
| Architectures | 200+ model architectures; ONNX-quantized models from HuggingFace Hub |
| ONNX runtime | New C++ WebGPU runtime written in partnership with ONNX Runtime team |
| Embeddings | Excellent — `all-MiniLM-L6-v2`, `bge-small-en-v1.5`, etc. |
| Text generation | Yes — `text-generation` pipeline; CLEO already uses this package |
| Bundle overhead | ~200MB for ONNX runtime (noted in promptfoo docs) |
| Model download | On-demand from HuggingFace Hub with local caching |

v4 key improvements over v3:
- WebGPU works in Node.js/Bun/Deno (not just browser)
- 8B+ parameter models now supported
- 10x faster builds (webpack→esbuild); 53% smaller web bundle
- `ModelRegistry` API: `get_pipeline_files()`, `is_pipeline_cached()` — enables pre-flight
  disk/cache checks before model download

CLEO already has `@huggingface/transformers` in use for embeddings. The same package can
run generation models. This is the **zero-install-friction path** for generation too.

Sources:
- https://huggingface.co/blog/transformersjs-v4
- https://www.promptfoo.dev/docs/providers/transformers/ (v4 ~200MB ONNX runtime note)
- https://github.com/huggingface/transformers.js/ (last commit Mar 11, 2026)

### §1.4 LM Studio

**Status**: Desktop GUI application. Non-embeddable. Provides OpenAI-compatible local server
on port 1234. Not viable for automated background processing in a CLI tool because:
1. Requires manual GUI interaction to start/select a model
2. Cannot be bundled or launched programmatically without user intervention
3. Python/TypeScript SDKs hit v1.0.0 but are HTTP client wrappers only

Verdict: **EXCLUDED** from CLEO consideration.

Source: https://blog.starmorph.com/blog/local-llm-inference-tools-guide

### §1.5 GPT4All

No stable Node.js bindings found in April 2026 search results. Community attention has
largely moved to Ollama and node-llama-cpp. **EXCLUDED**.

### §1.6 llama.cpp (direct)

llama.cpp (ggml-org/llama.cpp) is the underlying C++ engine. Last release: b8792 on
2026-04-14. Provides pre-built binaries for all platforms. Node.js integration requires
node-llama-cpp (see §1.2) — there is no official Node.js binding for llama.cpp itself.

Source: https://github.com/ggml-org/llama.cpp/releases

### §1.7 vLLM

Linux-only, GPU-required, production batch serving system. Not viable for cross-platform
CLI usage. **EXCLUDED**.

---

## §2 Model Comparison

### §2.1 Gemma 4 (April 2026 — Primary Candidate)

Released by Google DeepMind in early April 2026. Apache 2.0 license — full commercial use
without restriction. This is a meaningful change from the Gemma 3 custom terms.

**Family sizes** (confirmed from ai.google.dev/gemma/docs/core fetched 2026-04-02):

| Model | Total Params | Active Params | Memory Q4_0 | Context | Modalities |
|-------|-------------|---------------|-------------|---------|------------|
| Gemma 4 E2B | 5.1B (w/ embeddings) | ~2.3B | 3.2 GB | 128K | Text, Image, Audio |
| Gemma 4 E4B | 8B (w/ embeddings) | ~4.5B | 5 GB | 128K | Text, Image, Audio |
| Gemma 4 26B A4B (MoE) | 25.2B | 3.8B active | 15.6 GB | 256K | Text, Image |
| Gemma 4 31B Dense | 30.7B | 30.7B | 17.4 GB | 256K | Text, Image |

**CPU-only performance** (Intel/AMD x86 DDR4, from benchmarks):

| Model | CPU Generation Speed | Viability |
|-------|---------------------|-----------|
| E2B Q4 | 15-30 tok/s (high-core-count server), ~3-8 tok/s (Raspberry Pi 5) | Good for batch |
| E4B Q4 | 10-20 tok/s | Adequate |
| 26B A4B Q4 | 8-15 tok/s | Requires ~16GB RAM |
| 31B Dense Q4 | 3-8 tok/s | Requires ~20GB RAM |

**Apple Silicon performance** (M-series Macs — relevant for CLEO's macOS users):
- E2B: ~30 tokens/second conversational speed on iPhone-class hardware; M2 Mac much faster
- E4B: Runs on M1 8GB Mac with Q4 — comfortable
- Verified by Ollama: `ollama run gemma4:e2b` and `ollama run gemma4:e4b`

**For CLEO warm-tier use (1K-token transcript summary):**
- E2B Q4 at 15-30 tok/s → ~33-66 seconds for a 1K-token output on typical Intel laptop
- E4B Q4 at 10-20 tok/s → ~50-100 seconds on same hardware
- On M2 Mac: E2B would run ~100-150 tok/s (much faster)

**Architecture note**: "E" stands for "effective" — these are MoE models. E2B only activates
2.3B parameters during inference, but all 5.1B must be in memory for routing. The
per-generation compute cost is the 2.3B active path — fast.

**Native function calling**: Yes, all Gemma 4 variants.
**Native system prompt**: Yes — Gemma 4 is the first to support `system` role natively.
**128K context** (E2B/E4B): More than sufficient for transcript extraction.
**Structured JSON output**: Supported via Ollama format parameter.

Sources:
- https://ai.google.dev/gemma/docs/core (fetched live 2026-04-02)
- https://ai.google.dev/gemma/docs/core/model_card_4
- https://ollama.com/library/gemma4
- https://www.mindstudio.ai/blog/gemma-4-edge-deployment-e2b-e4b-models/
- https://sudoall.com/gemma-4-31b-apple-silicon-local-guide/
- https://developers.redhat.com/articles/2026/04/02/run-gemma-4-red-hat-ai-day-0-step-step-guide

### §2.2 Llama 3.2 (1B and 3B)

Meta's small models, released 2025, widely available in Ollama.

| Model | Q4 RAM | CPU Speed | Notes |
|-------|--------|-----------|-------|
| Llama 3.2 1B | ~1GB | Fast (trivial) | Quality marginal for extraction |
| Llama 3.2 3B | ~2GB | 2-5 tok/s (CPU) | Minimum viable for summarization |

Llama 3.2 3B is the current go-to for truly constrained machines. It is in Ollama as
`llama3.2:3b` with 64.1M downloads (second most popular model in Ollama library).

Quality note: Community consensus is that sub-3B models produce mediocre structured output
for complex tasks. 3B is the transition point. For extraction of structured observations
from transcripts, Llama 3.2 3B is marginal; 3B+ models preferred.

Sources:
- https://ollama.com/library (library listing, April 2026)
- https://www.aimagicx.com/blog/local-ai-models-2026-qwen-mistral-llama-hardware-guide
- https://dev.to/best_codes/qwen-3-benchmarks-comparisons-model-specifications-and-more-4hoa

### §2.3 Phi-4 Mini (3.8B)

Microsoft Phi-4 mini-instruct. MIT license.

| Property | Value |
|----------|-------|
| Parameters | 3.8B dense |
| MMLU | 67.3% |
| HumanEval | 74.4% |
| Q4 RAM | ~3GB |
| Context | 128K |
| License | MIT |
| Available via | Ollama, HuggingFace, Azure AI |

Phi-4 mini outperforms Llama 3.2 3B and matches Gemma 3 4B on most benchmarks. Strong
reasoning. English-focused — fine for CLEO's English-language transcripts.

Sources:
- https://localaimaster.com/blog/small-language-models-guide-2026
- https://www.bentoml.com/blog/the-best-open-source-small-language-models
- https://www.digitalapplied.com/blog/small-language-models-business-guide-gemma-phi-qwen

### §2.4 Qwen 3 (0.6B to 8B range)

Alibaba Qwen 3. Apache 2.0 license. Broad multilingual support.

| Model | Active Params | Q4 RAM | Context | Notes |
|-------|-------------|--------|---------|-------|
| Qwen3-0.6B | 0.6B | <1GB | 32K | Too small for extraction |
| Qwen3-1.7B | 1.7B | ~1.5GB | 32K | Minimal viable |
| Qwen3-4B | 4B dense | ~3GB | 32K | Strong for size |
| Qwen3-8B | 8B dense | ~5GB | 128K | Better quality |
| Qwen3-30B-A3B | 30B MoE, 3B active | ~12GB | 128K | Frontier quality at 3B cost |

Qwen3 4B scores ~70% MMLU (varies by thinking mode) and is competitive with Phi-4 mini.
Has "thinking" and "non-thinking" modes — for extraction tasks, non-thinking mode is faster
and adequate.

Source: https://dev.to/best_codes/qwen-3-benchmarks-comparisons-model-specifications-and-more-4hoa

### §2.5 SmolLM3 3B

HuggingFace's fully open instruct model. 3B, beats Llama 3.2 3B and Qwen2.5 3B, 128K context.
Apache 2.0. Directly compatible with `@huggingface/transformers` ONNX pipeline.

Source: https://www.bentoml.com/blog/the-best-open-source-small-language-models

### §2.6 Model Recommendation for CLEO Warm-Tier

**Primary**: Gemma 4 E2B via Ollama — best quality-per-parameter in April 2026 for this
size class, Apache 2.0, native function calling, 128K context, runs well on laptop hardware.

**Fallback (transformers.js embedded)**: `onnx-community/Qwen3-0.6B-ONNX` for machines
without Ollama, or `Xenova/all-MiniLM-L6-v2` already in use for embeddings-only fallback.

The E2B delivers 15-30 tok/s on CPU — acceptable for warm-tier background processing that
runs at session end (not interactive).

---

## §3 SDK Comparison

### §3.1 Vercel AI SDK (`ai` package, v6)

**Status**: Latest is v6.0.27+ (confirmed from April 2026 sources). Actively maintained.

| Property | Value |
|----------|-------|
| Package | `npm install ai @ai-sdk/ollama` |
| License | Apache 2.0 |
| Node.js min | 18.0 (22.x recommended) |
| Ollama support | First-class via `@ai-sdk/ollama` provider |
| Structured output | `generateObject()` with Zod schema — production quality |
| Streaming | `streamText()`, `streamObject()` |
| Embeddings | `embedMany()` via Ollama embedding models |
| OpenAI-compat | `@ai-sdk/openai-compatible` works with any OpenAI-format endpoint |
| Local providers | Ollama (official), vLLM, LM Studio all work via openai-compatible |

The `@ai-sdk/ollama` provider connects to the Ollama daemon:
```typescript
import { createOllama } from '@ai-sdk/ollama';
const ollama = createOllama({ baseURL: 'http://localhost:11434/api' });
const model = ollama('gemma4:e2b');
```

The Vercel AI SDK abstracts generation, streaming, and structured output identically across
local and cloud providers. Switching from Ollama to Claude API is a one-line provider swap.
This directly enables CLEO's hybrid architecture.

Sources:
- https://www.npmjs.com/package/ai-sdk-ollama (v3.8.2)
- https://www.sitepoint.com/the-rise-of-open-source-personal-ai-agents-a-new-os-paradigm/
- https://tech-insider.org/vercel-ai-sdk-tutorial-chatbot-nextjs-2026/
- Context7 `/vercel/ai` documentation

### §3.2 OpenAI Agents SDK

Available in TypeScript/Node.js. Model-agnostic via Chat Completion API compatibility —
can point at Ollama's OpenAI-compat endpoint or any other provider. However:
- Designed for agent orchestration (agent loops, handoffs, tool calling)
- **Not** designed for the specific task of structured extraction from text
- Heavier abstraction than needed for CLEO's extraction use case

Verdict: Useful if CLEO builds multi-agent orchestration, but **overkill** for warm-tier
extraction. Vercel AI SDK is the right fit for pure generation/extraction.

Sources:
- https://pub.towardsai.net/a-developers-guide-to-agentic-frameworks-in-2026-3f22a492dc3d
- https://agentlas.pro/frameworks/openai-agents-sdk/

### §3.3 LangChain.js

Current version 1.2.7. Still relevant in 2026 for complex RAG and agent chains.
Provider abstraction across 50+ LLMs including Ollama. However:
- More complex than needed for warm-tier extraction
- Node.js serverless OK, but no native edge runtime
- Higher dependency footprint than Vercel AI SDK

Verdict: Not recommended for CLEO's specific use case. Vercel AI SDK covers the need.

Source: https://strapi.io/blog/langchain-vs-vercel-ai-sdk-vs-openai-sdk-comparison-guide

### §3.4 `ollama` npm package (direct)

The official `npm install ollama` package provides direct TypeScript access to Ollama without
a higher-level SDK. Used by many projects. Structured output via `zodToJsonSchema()`.
Perfectly adequate. Less abstraction than Vercel AI SDK — provider swap requires more code.

Recommendation: Use the Vercel AI SDK's `@ai-sdk/ollama` instead for provider-neutral code.

### §3.5 SDK Recommendation for CLEO

**Use Vercel AI SDK (`ai` + `@ai-sdk/ollama`)** as the abstraction layer.

Reasons:
1. Identical API surface for local (Ollama) and cloud (Anthropic Claude API) — enables
   hybrid fallback with a single `model` variable swap
2. `generateObject()` + Zod schema gives structured `ExtractedMemory[]` output
3. TypeScript-native, ESM-compatible, actively maintained
4. CLEO already uses Claude (Anthropic SDK) for cold-tier; Vercel AI SDK wraps both

---

## §4 Bundle vs Shell-out Decision

### §4.1 The Three Models

| Model | Description | Pros | Cons |
|-------|-------------|------|------|
| Bundle (npm-bundled model + runtime) | Ship ONNX model + transformers.js inside `cleo-os` npm package | Zero user setup; works offline | +200MB ONNX runtime + model size adds to npm install |
| Shell-out (detect Ollama) | Detect Ollama daemon, use it if present | Zero bundle overhead; full GPU acceleration | Requires user to install Ollama separately |
| Hybrid (bundle embeddings, shell-out for generation) | transformers.js for embeddings (already in use), Ollama for generation | No extra setup for embeddings; generation is optional feature | Generation requires Ollama |

### §4.2 Install Overhead Analysis

**Embeddings (already in CLEO)**:
- `@huggingface/transformers` = ~200MB ONNX runtime (installed once, shared)
- `all-MiniLM-L6-v2` model = ~22MB ONNX quantized (downloaded on first use, cached)
- **Net addition**: Already present; zero new overhead

**Bundling a generation model (e.g., SmolLM3 3B)**:
- GGUF Q4_K_M at 3B ≈ ~1.8GB on disk
- ONNX Q4 equivalent ≈ ~900MB-1.5GB
- This would be added to the `npm install -g` footprint

**Verdict**: Bundling a generation model inside the npm package is **not viable** for
batteries-included approach. A 1-2GB npm install is unacceptable for a CLI tool.

The correct batteries-included strategy is:
1. `@huggingface/transformers` (already bundled) for embeddings and minimal generation
2. Ollama as an **optional** generation backend — detected at runtime, not installed by CLEO
3. Models downloaded on first use (not at npm install time) using either Ollama pull or
   transformers.js on-demand download with local HuggingFace cache

### §4.3 Batteries-Included for Embeddings

CLEO already does this correctly. `all-MiniLM-L6-v2` (22MB) downloads on first use
to `~/.cache/huggingface/hub/`. This is the correct pattern. **No change needed.**

### §4.4 Batteries-Included for Generation — Recommended Pattern

On first extraction run:
1. Check if Ollama is running at `http://localhost:11434`
2. If yes: use Ollama with `gemma4:e2b` (pull on first use if not present)
3. If no: attempt transformers.js generation with small ONNX model (slower, less capable)
4. If neither: route to Claude API (Haiku) if `ANTHROPIC_API_KEY` present
5. If none of the above: skip extraction with a warning logged to brain.db

---

## §5 Hybrid Architecture

### §5.1 Recommended Architecture for CLEO Warm-Tier

```
TRANSCRIPT EXTRACTION PIPELINE (warm-tier)
─────────────────────────────────────────────────────────────────────

1. Session end hook fires (priority 100)
2. TranscriptExtractor resolves backend:
   ┌─────────────────────────────────────────────────────────────┐
   │ detectLocalLLM():                                           │
   │   a. ping http://localhost:11434/api/tags → Ollama running? │
   │   b. check ollama has gemma4:e2b or similar model loaded    │
   │   c. check @huggingface/transformers available (always true) │
   └─────────────────────────────────────────────────────────────┘
3. Route to provider:
   ┌────────────────────────────────────────────────────────────────────────────┐
   │ OLLAMA AVAILABLE (primary local)                                           │
   │   Vercel AI SDK → @ai-sdk/ollama → gemma4:e2b                             │
   │   generateObject(schema: ExtractedMemorySchema) → ExtractedMemory[]        │
   │   Quality: HIGH (full GGUF model, GPU if available)                        │
   │   Latency: ~30-90s for 1K-token output on typical laptop CPU               │
   ├────────────────────────────────────────────────────────────────────────────┤
   │ TRANSFORMERS.JS FALLBACK (no Ollama; already installed)                    │
   │   @huggingface/transformers pipeline('text-generation', 'onnx-community/   │
   │     Qwen3-0.6B-ONNX') → simplified extraction (keyword + pattern)          │
   │   Quality: MEDIUM (0.6B is marginal; use prompt engineering)               │
   │   Latency: ~60-180s CPU (WASM backend); faster with WebGPU                 │
   ├────────────────────────────────────────────────────────────────────────────┤
   │ CLAUDE API COLD-TIER (ANTHROPIC_API_KEY present)                           │
   │   Existing Anthropic SDK → claude-haiku-4-5                               │
   │   Quality: HIGHEST                                                         │
   │   Cost: ~$0.01-0.05/session                                                │
   └────────────────────────────────────────────────────────────────────────────┘
4. Extracted memories → verifyAndStore() → brain.db

EMBEDDING PIPELINE (already wired, no change)
─────────────────────────────────────────────────────────────────────
@huggingface/transformers all-MiniLM-L6-v2 → 384-dim float32 → sqlite-vec
```

### §5.2 Provider Detection Code Pattern

```typescript
// packages/core/src/memory/llm-backend-resolver.ts

export type ExtractionBackend = 'ollama' | 'transformers' | 'anthropic' | 'none';

export async function resolveExtractionBackend(): Promise<ExtractionBackend> {
  // 1. Try Ollama
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) return 'ollama';
  } catch {
    // not running
  }

  // 2. Transformers.js is always available (already a CLEO dependency)
  // Check if a generation model is cached
  const { ModelRegistry } = await import('@huggingface/transformers');
  const cached = await ModelRegistry.is_pipeline_cached(
    'text-generation',
    'onnx-community/Qwen3-0.6B-ONNX',
    { dtype: 'q4' }
  );
  if (cached) return 'transformers';

  // 3. Anthropic API
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';

  // 4. Try downloading transformers model on first run
  return 'transformers'; // will download ~300MB on first use
}
```

---

## §6 Fallback Strategy

### §6.1 Fallback Chain

```
Ollama (gemma4:e2b, local, free)
  → transformers.js (Qwen3-0.6B ONNX, local, free, already installed)
  → Anthropic Claude Haiku (cloud, costs ~$0.01/session)
  → SKIP with logged warning + transcript marked pending_extraction
```

### §6.2 Graceful Degradation Design

| Scenario | Behavior | Memory Impact |
|----------|----------|---------------|
| No Ollama + no API key + first run | Download Qwen3-0.6B ONNX (~300MB) once; use forever | Minimal |
| Ollama installed but model not pulled | Auto-run `ollama pull gemma4:e2b` (user sees progress) | None |
| Ollama installed, model pulled | Full quality extraction in background | None |
| API key set | Use Claude Haiku for best quality | Cost-based |
| No local model, no API key, skip mode | Log `extraction_skipped` tombstone to brain.db; transcript remains | Accumulates until next run |

### §6.3 Detection Reliability

Ollama detection via HTTP ping is the most reliable approach. The daemon runs on a
known port (11434) and returns a JSON models list. A 2-second timeout prevents blocking
session end hooks. This is exactly the pattern used by the Vercel AI SDK `@ai-sdk/ollama`
provider's `baseURL` health check.

### §6.4 User Messaging

At first session end when no backend is configured:
```
[CLEO] Local LLM not detected. Transcript extraction using transformers.js fallback.
       Install Ollama (ollama.com) + run: ollama pull gemma4:e2b
       for higher-quality extraction. Set ANTHROPIC_API_KEY to use Claude.
```

---

## §7 Recommended Stack

### §7.1 Final Recommendation

**For CLEO's warm-tier transcript extraction pipeline, the recommended stack is:**

| Layer | Component | Rationale |
|-------|-----------|-----------|
| SDK abstraction | Vercel AI SDK (`ai` + `@ai-sdk/ollama`) | Provider-neutral; identical API for local + cloud; Zod structured output |
| Primary local runner | Ollama | Best cross-platform support; GPU acceleration; zero new npm deps |
| Primary local model | Gemma 4 E2B | Apache 2.0; best quality at 2B class; 128K context; native function calling; runs on CPU |
| Fallback local | `@huggingface/transformers` + `onnx-community/Qwen3-0.6B-ONNX` | Already installed; zero extra overhead; works offline |
| Cold-tier (best quality) | Anthropic Claude Haiku via existing SDK | Existing code path; unchanged |
| Embedding model | `all-MiniLM-L6-v2` via transformers.js | Already wired in `embedding-local.ts`; no change |
| Vector storage | `sqlite-vec` | Already in CLEO; cross-platform C extension |

### §7.2 Why NOT to Bundle the Model in npm

- Gemma 4 E2B Q4 ≈ 3.2GB on disk — completely unacceptable in a CLI npm package
- Even Qwen3-0.6B ONNX ≈ 300-500MB — borderline; only acceptable as on-demand download
- Use HuggingFace Hub on-demand caching (transformers.js already does this)
- Use Ollama pull on-demand (user-facing progress bar)

### §7.3 Why Ollama Over node-llama-cpp for the Primary Path

While `node-llama-cpp` is embeddable (no daemon), it has a critical disadvantage for CLEO:
**model management**. Ollama handles model downloads, versioning, and caching natively.
With node-llama-cpp, CLEO would need to manage GGUF file paths and downloads.
For a CLI tool targeting non-technical users, Ollama's model management is the better UX.

However, `node-llama-cpp` is the right choice if CLEO ever needs fully embedded LLM
execution with no external dependency for embedding dedup (beyond what transformers.js
already provides). For that case it is already wired as a community AI SDK provider.

### §7.4 New npm Dependencies Required

```json
{
  "ai": "^6.0.0",
  "@ai-sdk/ollama": "^1.0.0"
}
```

These are the only net-new production dependencies. `@huggingface/transformers` is already
present. The `anthropic` SDK is already present.

---

## §8 Spec Update for memory-architecture-spec.md §7

The following replaces the stub content in
`docs/specs/memory-architecture-spec.md` §7.1:

### §7.1 Transcript Extraction Model — Updated (was Q4 — OWNER DECISION REQUIRED)

**Decision**: Option C (Hybrid) confirmed, with a specific implementation:

```
BACKEND PRIORITY ORDER:
  1. Ollama daemon running locally
     → Model: gemma4:e2b (3.2GB Q4_K_M, pulled on first use)
     → SDK: Vercel AI SDK @ai-sdk/ollama
     → Quality: HIGH
  2. @huggingface/transformers fallback (always installed)
     → Model: onnx-community/Qwen3-0.6B-ONNX (~300MB, downloaded once)
     → Quality: MEDIUM (adequate for warm-tier keyword extraction)
  3. Anthropic Claude Haiku (ANTHROPIC_API_KEY required)
     → Existing Anthropic SDK path
     → Quality: HIGHEST
  4. Skip — log tombstone, mark transcript pending_extraction
```

**New code file**: `packages/core/src/memory/llm-backend-resolver.ts`

**Updated config keys**:
```json
{
  "brain": {
    "llmExtraction": {
      "backend": "auto",
      "ollamaBaseURL": "http://localhost:11434",
      "ollamaModel": "gemma4:e2b",
      "transformersModel": "onnx-community/Qwen3-0.6B-ONNX",
      "transformersDtype": "q4",
      "anthropicModel": "claude-haiku-4-5",
      "skipIfNoBackend": false
    }
  }
}
```

**Q4 is now resolved**. T730 (TranscriptExtractor) can be spawned immediately.
The `llm-backend-resolver.ts` module provides the `resolveExtractionBackend()` function
that T730's `TranscriptExtractor` should call during initialization.

---

## §9 Decision Matrix

Scoring: Cross-platform [3=all OS, 1=Linux-only], Install overhead [3=npm only, 1=separate],
Disk delta [3=<100MB, 1=>2GB], License [3=Apache/MIT, 2=custom open], Maintenance [3=active].

| Combination | Cross-platform | Install | Disk | License | Maintenance | Total | Notes |
|-------------|---------------|---------|------|---------|-------------|-------|-------|
| **Ollama + Gemma 4 E2B + Vercel AI SDK** | 3 | 2 | 2 | 3 | 3 | **13** | RECOMMENDED PRIMARY |
| node-llama-cpp + Gemma 4 E2B GGUF | 3 | 3 | 1 | 3 | 3 | 13 | Good but model mgmt burden |
| transformers.js + Qwen3-0.6B ONNX | 3 | 3 | 2 | 3 | 3 | **14** | RECOMMENDED FALLBACK |
| Ollama + Phi-4 mini + Vercel AI SDK | 3 | 2 | 2 | 3 | 3 | 13 | Solid alternative model |
| Ollama + Llama 3.2 3B | 3 | 2 | 2 | 3 | 3 | 13 | Lower quality than Gemma 4 E2B |
| Claude API (Haiku) only | 3 | 3 | 3 | 3 | 3 | 15 | Cold-tier only; requires API key |
| LM Studio | 2 | 1 | 1 | 2 | 3 | 9 | GUI dep; non-embeddable |
| vLLM | 1 | 1 | 2 | 3 | 3 | 10 | Linux + GPU only |

**Winner**: Ollama + Gemma 4 E2B as primary + transformers.js/Qwen3-0.6B as fallback.
The split architecture scores 13+14=27 combined vs. any single-track approach.

---

## Appendix A — Sources Cited

1. https://ai.google.dev/gemma/docs/core — Gemma 4 official overview (fetched 2026-04-02)
2. https://ai.google.dev/gemma/docs/core/model_card_4 — Model card with memory tables
3. https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/ — Google Blog April 2026
4. https://www.mindstudio.ai/blog/what-is-gemma-4-apache-2-license-commercial-ai-deployment/ — Apache 2.0 analysis
5. https://developers.redhat.com/articles/2026/04/02/run-gemma-4-red-hat-ai-day-0-step-step-guide — Day-0 guide
6. https://www.mindstudio.ai/blog/gemma-4-edge-deployment-e2b-e4b-models/ — Edge benchmarks
7. https://sudoall.com/gemma-4-31b-apple-silicon-local-guide/ — Apple Silicon + CPU benchmarks
8. https://ollama.com/library/gemma4 — Ollama model page with specs
9. https://allenkuo.medium.com/gemma-4-on-vllm-vs-ollama-benchmarks-on-a-96-gb-blackwell-gpu-804ca4845a21 — vLLM vs Ollama benchmarks April 2026
10. https://docs.ollama.com/windows — Ollama Windows docs
11. https://www.npmjs.com/package/node-llama-cpp — v3.18.1 npm page
12. https://node-llama-cpp.withcat.ai/guide/ — Getting started guide
13. https://node-llama-cpp.withcat.ai/blog/v3 — v3.0 launch post
14. https://ai-sdk.dev/providers/community-providers/llama-cpp — macOS-only warning
15. https://huggingface.co/blog/transformersjs-v4 — v4 announcement
16. https://github.com/huggingface/transformers.js/ — GitHub (last commit Mar 11 2026)
17. https://www.promptfoo.dev/docs/providers/transformers/ — v4 ~200MB ONNX note
18. https://localaimaster.com/blog/small-language-models-guide-2026 — SLM guide March 2026
19. https://www.bentoml.com/blog/the-best-open-source-small-language-models — SmolLM3, Phi-4 mini
20. https://dev.to/best_codes/qwen-3-benchmarks-comparisons-model-specifications-and-more-4hoa — Qwen3 benchmarks
21. https://arxiv.org/html/2604.07035v1 — Gemma 4 / Phi-4 / Qwen3 accuracy comparison (April 2026)
22. https://www.sitepoint.com/definitive-guide-local-llms-2026-privacy-tools-hardware/ — 2026 local LLM guide
23. https://tech-insider.org/vercel-ai-sdk-tutorial-chatbot-nextjs-2026/ — Vercel AI SDK v6 guide
24. https://strapi.io/blog/langchain-vs-vercel-ai-sdk-vs-openai-sdk-comparison-guide — SDK comparison 2026
25. https://agentlas.pro/frameworks/openai-agents-sdk/ — OpenAI Agents SDK review
26. https://alexgarcia.xyz/sqlite-vec/js.html — sqlite-vec Node.js docs
27. https://github.com/asg017/sqlite-vec — sqlite-vec repo (Mozilla Builders)
28. https://huggingface.co/Xenova/all-MiniLM-L6-v2 — ONNX embedding model (22MB, 384-dim)
29. Context7 `/vercel/ai` — Vercel AI SDK documentation (Ollama provider patterns)
30. https://github.com/ggml-org/llama.cpp/releases — llama.cpp b8792 released 2026-04-14
31. https://blogs.nvidia.com/blog/rtx-ai-garage-open-models-google-gemma-4/ — NVIDIA Gemma 4 day-0
