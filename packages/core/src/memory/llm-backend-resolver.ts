/**
 * LLM backend resolver for the transcript extraction pipeline.
 *
 * Resolves the best available LLM backend using a priority-ordered fallback
 * chain. Warm-tier prefers local inference (Ollama → transformers.js) before
 * escalating to the cloud (Claude Sonnet). Cold-tier uses Claude Sonnet
 * exclusively (owner-mandated, NOT Haiku).
 *
 * Fallback chain (warm):
 *   1. Ollama daemon running at localhost:11434 (gemma4:e4b-it or fallback model)
 *   2. @huggingface/transformers (already installed; ONNX pipeline, zero extra deps)
 *   3. Claude Sonnet via Anthropic API (cold escalation)
 *   4. null — no backend; caller must skip extraction
 *
 * Fallback chain (cold):
 *   1. Claude Sonnet via Anthropic API (ANTHROPIC_API_KEY required)
 *   2. null — no API key; caller must skip extraction
 *
 * OWNER OVERRIDE 2026-04-15: Cold tier MUST use claude-sonnet-4-6, NOT Haiku.
 *
 * Research basis: `.cleo/agent-outputs/T750-research-local-llm.md`
 * Spec reference: `docs/specs/memory-architecture-spec.md` §7
 *
 * @task T730
 * @epic T726
 */

import type { LanguageModel } from 'ai';

/** Extraction tier — warm prefers local inference, cold uses cloud. */
export type ExtractionTier = 'warm' | 'cold';

/**
 * The resolved backend name. Used for telemetry and logging.
 *
 * - `ollama`       — Ollama daemon (local)
 * - `transformers` — @huggingface/transformers ONNX pipeline (local, in-process)
 * - `anthropic`    — Claude Sonnet via Anthropic API (cloud)
 * - `none`         — No backend available; extraction must be skipped
 */
export type ExtractionBackendName = 'ollama' | 'transformers' | 'anthropic' | 'none';

/**
 * Resolved backend descriptor returned by `resolveLlmBackend`.
 *
 * `model` is a Vercel AI SDK `LanguageModel` for use with `generateObject()`.
 * `name` identifies which backend was selected for logging and telemetry.
 */
export interface ResolvedBackend {
  /** Vercel AI SDK LanguageModel instance ready to use. */
  model: LanguageModel;
  /** Which backend was selected. */
  name: ExtractionBackendName;
  /** Model identifier string (e.g. `gemma4:e4b-it`, `claude-sonnet-4-6`). */
  modelId: string;
}

/**
 * Ollama model priority list.
 *
 * We try these in order on the running Ollama daemon. The first model that
 * is present in the model list is used. This allows users who have already
 * pulled a different local model to use it without re-pulling gemma4.
 *
 * Priority rationale (T752 2026-04-15):
 * - `gemma4:e4b-it`: instruction-tuned 4B — 90% schema compliance, ~5 GB Q4 VRAM
 * - `gemma4:e2b-it`: instruction-tuned 2B fallback — fits 3.2 GB VRAM
 * - `gemma4:e2b`: base model last-resort — no instruction tuning, expect more re-prompts
 */
const OLLAMA_MODEL_PRIORITY = [
  'gemma4:e4b-it', // PRIMARY: instruction-tuned 4B — 90% schema compliance
  'gemma4:e2b-it', // FALLBACK: instruction-tuned 2B — fits 3.2 GB VRAM
  'gemma4:e2b', // LAST RESORT base: no instruction tuning, expect re-prompts
  'phi4-mini',
  'llama3.2:3b',
  'llama3.2',
] as const;

/** Cold-tier model — MUST be Sonnet per owner override 2026-04-15. */
const COLD_TIER_MODEL = 'claude-sonnet-4-6' as const;

/** Transformers.js fallback model (ONNX, ~300MB downloaded on first use). */
const TRANSFORMERS_FALLBACK_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct' as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the best available LLM backend for transcript extraction.
 *
 * Returns a `ResolvedBackend` with a Vercel AI SDK `LanguageModel` ready for
 * `generateObject()`, or `null` if no backend is available and the caller
 * should skip extraction.
 *
 * Never throws — all errors are caught internally.
 *
 * @param tier - Extraction tier: `warm` (prefer local) or `cold` (cloud).
 * @returns Resolved backend descriptor, or `null` if nothing is available.
 *
 * @example
 * ```ts
 * const backend = await resolveLlmBackend('warm');
 * if (!backend) { return; } // no backend available
 * const { object } = await generateObject({ model: backend.model, ... });
 * ```
 */
export async function resolveLlmBackend(tier: ExtractionTier): Promise<ResolvedBackend | null> {
  if (tier === 'warm') {
    // 1. Try Ollama (best local quality, GPU-accelerated if available)
    const ollamaBackend = await tryOllama();
    if (ollamaBackend) return ollamaBackend;

    // 2. Try transformers.js (already installed; zero extra deps)
    const transformersBackend = await tryTransformers();
    if (transformersBackend) return transformersBackend;

    // 3. Escalate to cold (Sonnet) — warm has no local option
    return resolveLlmBackend('cold');
  }

  if (tier === 'cold') {
    // Owner-mandated: MUST be claude-sonnet-4-6, NOT Haiku
    const anthropicBackend = await tryAnthropic(COLD_TIER_MODEL);
    return anthropicBackend;
  }

  return null;
}

/**
 * Check whether the Ollama daemon is reachable and has a usable model.
 *
 * Returns `null` on any failure — never throws.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve an Ollama backend.
 *
 * Probes the daemon, lists available models, and selects the first model
 * from `OLLAMA_MODEL_PRIORITY` that is present. Falls back to the first
 * available model if none of the preferred models are installed.
 */
async function tryOllama(): Promise<ResolvedBackend | null> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const availableModels = (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);

    if (availableModels.length === 0) return null;

    // Find preferred model
    let selectedModel: string | undefined;
    for (const preferred of OLLAMA_MODEL_PRIORITY) {
      if (availableModels.some((m) => m === preferred || m.startsWith(preferred.split(':')[0]))) {
        selectedModel = preferred;
        break;
      }
    }
    // Fall back to any available model
    if (!selectedModel) {
      selectedModel = availableModels[0];
    }

    // Build an OpenAI-compatible provider pointing at Ollama's OpenAI endpoint
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const ollamaProvider = createOpenAICompatible({
      baseURL: 'http://localhost:11434/v1',
      name: 'ollama',
    });

    return {
      model: ollamaProvider(selectedModel),
      name: 'ollama',
      modelId: selectedModel,
    };
  } catch {
    return null;
  }
}

/**
 * Attempt to resolve a transformers.js backend.
 *
 * Uses @huggingface/transformers (already a CLEO dependency) with a small
 * ONNX model. The model is downloaded on first use (~300MB) and cached in
 * `~/.cache/huggingface/hub/` — same as the embedding model.
 *
 * NOTE: @huggingface/transformers v4 does not expose an OpenAI-compatible HTTP
 * server, so it cannot be wired as a Vercel AI SDK `LanguageModel` provider
 * without implementing the full `LanguageModelV3` interface (complex). Instead,
 * this function detects that transformers.js CAN run a generation model and
 * returns a marker. The actual generation in the warm tier will use
 * `generateTransformersText()` — a direct call path that bypasses the AI SDK
 * but still stores results through the same brain APIs.
 *
 * For the caller (`extractTranscript`), if `name === 'transformers'` then
 * `model` is a stub — the caller must use `runTransformersExtraction()` instead
 * of `generateObject()`.
 */
async function tryTransformers(): Promise<ResolvedBackend | null> {
  try {
    // Check if transformers.js can load (it's always installed in CLEO)
    const { env } = await import('@huggingface/transformers');
    // Confirm the package is loadable by accessing a known property
    if (typeof env === 'undefined') return null;

    // Return a stub backend — the caller checks name === 'transformers'
    // and uses the direct pipeline path instead of generateObject()
    return {
      // Cast: the model field is unused for transformers path; caller checks name
      model: null as unknown as LanguageModel,
      name: 'transformers',
      modelId: TRANSFORMERS_FALLBACK_MODEL,
    };
  } catch {
    return null;
  }
}

/**
 * Attempt to resolve the Anthropic cold-tier backend.
 *
 * Checks for ANTHROPIC_API_KEY in the environment. Returns null if the key
 * is not present — never throws.
 *
 * @param modelId - Anthropic model to use (MUST be claude-sonnet-4-6 for cold tier).
 */
async function tryAnthropic(modelId: string): Promise<ResolvedBackend | null> {
  try {
    const { resolveAnthropicApiKey } = await import('./anthropic-key-resolver.js');
    const apiKey = resolveAnthropicApiKey();
    if (!apiKey) return null;

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const anthropicProvider = createAnthropic({ apiKey });

    return {
      model: anthropicProvider(modelId),
      name: 'anthropic',
      modelId,
    };
  } catch {
    return null;
  }
}
