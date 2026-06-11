/**
 * Builtin provider profile for Ollama.
 *
 * Ollama is a local/self-hosted LLM runtime that exposes a `/api/chat`
 * endpoint speaking its own NDJSON streaming protocol (`ollama_native`
 * ApiMode). It is NOT an OpenAI-compatible shim — use {@link OllamaTransport}
 * from `packages/core/src/llm/transports/ollama.ts`.
 *
 * Key characteristics:
 * - No API key required for local deployments (empty-string placeholder).
 * - Base URL defaults to `http://localhost:11434` (the well-known Ollama port).
 * - Tool calling uses the same OpenAI wire shape for REQUEST but returns
 *   `arguments` as an object (not a JSON string) in the RESPONSE.
 * - No prompt-caching support.
 *
 * @task T9355 (Task A — Ollama transport, D-ph4-05 closure)
 * @epic T9354
 */

import type { ProviderProfile } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// ProviderProfile
// ---------------------------------------------------------------------------

/**
 * Ollama provider profile.
 *
 * Registers the `ollama` canonical name and `ollama-local` alias so that
 * `cleo llm test ollama` and `getProviderProfile('ollama-local')` both
 * resolve to this profile.
 *
 * The profile declares `apiMode: 'ollama_native'` which is used by the
 * session factory to select {@link OllamaTransport} at runtime.
 *
 * `authTypes: ['api_key']` is listed for compatibility with the credential
 * store API, but local Ollama deployments do not require an actual key —
 * users may leave it empty or store a token for remote/proxied deployments.
 *
 * ## Default model selection (DHQ-081 · T11978 · T11990)
 *
 * `defaultModel` is `gemma4:e4b` (standard/frontier tasks, requires ≥ 8 GB RAM).
 * `defaultAuxModel` is `gemma4:e2b` (fast/aux tasks, requires ≥ 4 GB RAM).
 *
 * Tags live-verified on ollama.com/library/gemma4 2026-06-11:
 *   - gemma4:e2b  = 7.2 GB download (Q4_K_M), edge 2B effective params
 *   - gemma4:e4b  = 9.6 GB download (Q4_K_M), edge 4B effective params
 *   - gemma4:12b  = 7.6 GB download (QAT), 12B params, 256k context
 *
 * The cross-provider selector (`cross-provider-selector.ts`) gates model selection
 * on `os.totalmem()` and falls through to `qwen2:0.5b` only as a proof-of-life
 * last resort when RAM is below 4 GB. These are the provider-registry SSoT
 * constants; the selector reads them via `getProviderProfile('ollama')`.
 *
 * If the catalog does not yet have a `gemma4` family entry, the resolver logs a
 * hint to run `cleo llm refresh-catalog`.
 */
export const ollamaProfile: ProviderProfile = {
  name: 'ollama',
  displayName: 'Ollama (local)',
  authTypes: ['api_key'],
  baseUrl: 'http://localhost:11434',
  defaultModel: 'gemma4:e4b',
  aliases: ['ollama-local'],
  // Hermes-parity routing/catalog fields (T11756). Local on-device tier.
  tier: 'local',
  defaultAuxModel: 'gemma4:e2b',
  defaultMaxTokens: 2048,
  envVars: ['OLLAMA_API_KEY', 'OLLAMA_BASE_URL'],
  supportsThinkingBudget: false,
};
