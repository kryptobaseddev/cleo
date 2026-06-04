/**
 * Wire-protocol derivation for the SSoT descriptor (E9 · T11745).
 *
 * Maps a resolved `(provider, authType)` pair to the {@link ApiMode} + default
 * `baseUrl` it implies. This is the single function that encodes the
 * provider→protocol knowledge that USED to live, duplicated, inside three
 * transport factories (`session-factory.transportForProvider`,
 * `api.ts:_transportForConfig`, `tool-loop.ts:_transportForProvider`) and the
 * inline codex block in `role-executor.ts`.
 *
 * Hoisting it here lets the resolver stamp `apiMode`/`baseUrl` onto the
 * {@link ResolvedLLMDescriptor} so the single {@link import('./model-runner.js').ModelRunner}
 * can construct ANY provider's transport from descriptor data alone.
 *
 * @module llm/api-mode
 * @task T11745
 * @task T11761
 * @epic T11745
 */

import type { ApiMode } from '@cleocode/contracts';
import { CODEX_OAUTH_BASE_URL } from './transports/codex-oauth-headers.js';
import type { ModelTransport } from './types-config.js';

/**
 * The wire-protocol facts implied by a resolved provider/credential pair.
 *
 * @task T11745
 */
export interface DerivedApiWire {
  /** Wire protocol the provider speaks for this credential. */
  readonly apiMode: ApiMode;
  /**
   * Provider-default base URL implied by the apiMode, or `null` when the
   * transport supplies its own default (no override needed). Currently only
   * the codex ChatGPT-backend path implies a non-default base URL; everything
   * else lets the transport / credential's own `baseUrl` win.
   */
  readonly baseUrl: string | null;
}

/**
 * Derive the {@link ApiMode} and implied default base URL for a resolved
 * provider + auth scheme.
 *
 * Mirrors the branch order of the legacy `transportForProvider` factories so
 * the descriptor carries EXACTLY the protocol each factory would have picked:
 *
 *  - `anthropic` → `anthropic_messages`
 *  - `bedrock`   → `bedrock_converse`
 *  - `gemini`    → `chat_completions` (Gemini speaks the OpenAI-compat shape
 *                  via the gemini transport, but its apiMode tag is
 *                  chat-completions)
 *  - `ollama`    → `ollama_native`
 *  - `openai` + OAuth → `codex_responses` (ChatGPT backend; implies
 *                  {@link CODEX_OAUTH_BASE_URL})
 *  - everything else → `chat_completions` (OpenAI-compatible)
 *
 * The `kimi-code` provider speaks the Anthropic Messages protocol against its
 * own coding endpoint, so it is tagged `anthropic_messages`.
 *
 * @param provider - Resolved provider transport.
 * @param authType - Resolved credential auth scheme (`null` when no credential).
 * @returns The derived wire facts.
 * @task T11745
 */
export function deriveApiWire(
  provider: ModelTransport,
  authType: 'api_key' | 'oauth' | 'aws_sdk' | null,
): DerivedApiWire {
  if (provider === 'anthropic') {
    return { apiMode: 'anthropic_messages', baseUrl: null };
  }
  if (provider === 'kimi-code') {
    // Kimi Code speaks the Anthropic Messages protocol against its own endpoint.
    return { apiMode: 'anthropic_messages', baseUrl: null };
  }
  if (provider === 'bedrock') {
    return { apiMode: 'bedrock_converse', baseUrl: null };
  }
  if (provider === 'gemini') {
    return { apiMode: 'chat_completions', baseUrl: null };
  }
  if (provider === 'ollama') {
    return { apiMode: 'ollama_native', baseUrl: null };
  }
  if (provider === 'openai' && authType === 'oauth') {
    // ChatGPT-issued OAuth tokens authenticate against the Codex backend via
    // the Responses API — NOT api.openai.com.
    return { apiMode: 'codex_responses', baseUrl: CODEX_OAUTH_BASE_URL };
  }
  // openai (api_key), openrouter, deepseek, xai, groq, moonshot, … →
  // OpenAI-compatible chat-completions.
  return { apiMode: 'chat_completions', baseUrl: null };
}
