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
/**
 * Default API base URL per builtin provider — the SSoT for "where does this
 * provider actually live".
 *
 * ## Why this exists (gh#1216)
 *
 * {@link deriveApiWire} returned `baseUrl: null` for every OpenAI-compatible
 * provider except Codex, and a null base URL makes the OpenAI SDK default to
 * `api.openai.com`. So an OpenRouter key was sent to OpenAI, which rejected it
 * with its own canonical 401 pointing the user at platform.openai.com — an
 * error message that blames the key rather than the routing. The same fault
 * applied to deepseek, xai, groq and moonshot: the documented providers were
 * unusable out of the box, with no config surface that fixed it.
 *
 * The base URLs were not unknown. They were recorded in THREE places —
 * the hand-written builtin profiles, the generated models.dev catalog, and an
 * inline map inside `cli-ops.ts` — and consumed by none of the one path that
 * decides where a request is sent. This constant is that path's source, and
 * `cli-ops` now reads it too so the two cannot drift.
 *
 * Values include the API version segment, matching what the transports expect
 * as `baseURL` and what the builtin profiles already carry.
 *
 * Absent providers resolve to `null` deliberately: `anthropic`, `bedrock` and
 * `gemini` do not speak chat-completions against a URL we choose here, and
 * `openai` itself is the SDK's own default.
 *
 * @task T12132 (gh#1216)
 */
export const DEFAULT_PROVIDER_BASE_URLS: Readonly<Partial<Record<ModelTransport, string>>> =
  Object.freeze({
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com/v1',
    xai: 'https://api.x.ai/v1',
    groq: 'https://api.groq.com/openai/v1',
    moonshot: 'https://api.moonshot.cn/v1',
    ollama: 'http://localhost:11434/v1',
    'kimi-code': 'https://api.kimi.com/coding',
  });

/**
 * The default API base URL for a provider, or `null` when the transport
 * supplies its own.
 *
 * @param provider - Resolved provider transport.
 * @returns Absolute base URL including the version segment, or `null`.
 *
 * @task T12132 (gh#1216)
 */
export function defaultBaseUrlFor(provider: ModelTransport): string | null {
  return DEFAULT_PROVIDER_BASE_URLS[provider] ?? null;
}

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
  //
  // gh#1216: this returned `null` for ALL of them, and a null base URL makes
  // the OpenAI SDK default to api.openai.com — so an OpenRouter key went to
  // OpenAI and came back with OpenAI's own 401 blaming the key. `openai`
  // itself is absent from the table and still resolves to null, which is
  // correct: the SDK's default is right for it.
  return { apiMode: 'chat_completions', baseUrl: defaultBaseUrlFor(provider) };
}
