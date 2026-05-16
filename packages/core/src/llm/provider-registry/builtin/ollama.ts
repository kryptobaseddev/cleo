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
 */
export const ollamaProfile: ProviderProfile = {
  name: 'ollama',
  displayName: 'Ollama (local)',
  authTypes: ['api_key'],
  baseUrl: 'http://localhost:11434',
  defaultModel: 'llama3',
  aliases: ['ollama-local'],
  envVars: ['OLLAMA_API_KEY', 'OLLAMA_BASE_URL'],
  supportsThinkingBudget: false,
};
