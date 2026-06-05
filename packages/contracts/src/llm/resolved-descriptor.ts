/**
 * `ResolvedLLMDescriptor` — the SSoT resolution envelope (E9 · T11745 step 0).
 *
 * The Phase-2 `ResolvedLLM` (see `operations/llm.ts`) carries only
 * `{ provider, model, client, credential }`. That is enough for the
 * Anthropic-only legacy path but loses the *wire-protocol* facts a single
 * {@link import('./normalized-response.js').LlmTransport} factory needs to
 * construct ANY provider's transport without re-deriving them inline:
 *
 *  - `apiMode`      — which wire protocol the provider speaks (the load-bearing
 *                     field: codex routes purely on `apiMode === 'codex_responses'`).
 *  - `baseUrl`      — per-provider endpoint (codex ChatGPT backend, Ollama
 *                     localhost, Moonshot/OpenRouter).
 *  - `authType`     — drives the header builder (OAuth bearer vs `x-api-key`).
 *  - `capabilities` — tools/json/vision/thinking, so a runner can pick the
 *                     right call shape.
 *
 * This interface is the descriptor those fields hang off. It is intentionally
 * **types-only** (no runtime) so it satisfies the contracts-purity gate
 * (Gate 10). The runtime-precise variant (with concrete SDK client unions)
 * lives in `@cleocode/core/llm/role-resolver` (`ResolvedLLM`) and extends the
 * descriptor surface there.
 *
 * @module llm/resolved-descriptor
 * @task T11745
 * @task T11761
 * @epic T11745
 */

import type { CredentialResultWire, ModelTransport, ResolutionSource } from '../operations/llm.js';
import type { ApiMode } from './provider-id.js';

/**
 * Coarse model-capability flags carried by a {@link ResolvedLLMDescriptor}.
 *
 * These are advisory hints for a model-runner so it can pick the right call
 * shape (e.g. skip a tools payload for a provider that cannot use them). All
 * fields are optional — an absent field means "unknown", and the runner MUST
 * degrade gracefully (treat unknown as the conservative default).
 *
 * @task T11745
 */
export interface ModelCaps {
  /** Provider/model supports function/tool calling. */
  readonly tools?: boolean;
  /** Provider/model supports structured JSON / constrained output. */
  readonly json?: boolean;
  /** Provider/model supports image input. */
  readonly vision?: boolean;
  /** Provider/model supports Anthropic-style extended thinking budget. */
  readonly thinking?: boolean;
}

/**
 * Fully-resolved, transport-agnostic LLM descriptor.
 *
 * This is the single envelope every LLM resolver SHOULD return and every
 * model-runner SHOULD consume. It carries enough wire-protocol provenance
 * (`apiMode`, `baseUrl`, `authType`) that a runner can construct the correct
 * transport / language-model for ANY provider — including codex's
 * ChatGPT-backend Responses API — without inline per-call branching.
 *
 * The `credential` field uses the wire-level {@link CredentialResultWire}
 * (provider + apiKey + source + authType) so this contract stays
 * SDK-/runtime-free. Core narrows it to the richer
 * `import('@cleocode/core/llm/credentials').CredentialResult` where needed.
 *
 * @task T11745
 * @task T11761
 */
export interface ResolvedLLMDescriptor {
  /** LLM provider transport that was resolved. */
  readonly provider: ModelTransport;
  /** Full model identifier. ALWAYS from registry/role-config — never a literal. */
  readonly model: string;
  /**
   * Resolved credential. `null` when no tier produced a token — callers MUST
   * handle the graceful-degradation path.
   */
  readonly credential: CredentialResultWire | null;
  /** Which config path produced this resolution. */
  readonly source: ResolutionSource;
  /** When `roles[role].credentialLabel` was set, the label that was used. */
  readonly credentialLabel?: string;
  /**
   * Wire protocol spoken by the resolved provider/credential pair.
   *
   * The load-bearing addition: a runner branches on this — `'codex_responses'`
   * → ChatGPT-backend Responses API, `'anthropic_messages'` → Anthropic SDK,
   * `'ollama_native'` → Ollama, `'bedrock_converse'` → Bedrock, everything else
   * → OpenAI-compatible chat-completions.
   */
  readonly apiMode: ApiMode;
  /**
   * Per-provider API endpoint override. `null` when the provider's registry
   * default should be used. Carries the codex ChatGPT backend URL, the Ollama
   * localhost URL, and proxy/on-prem overrides.
   */
  readonly baseUrl: string | null;
  /**
   * Scheme used to present the credential. Drives the header builder — OAuth
   * bearer (codex, anthropic-oauth) vs `x-api-key`/`Authorization: Bearer`
   * from an API key. `null` when no credential was resolved.
   */
  readonly authType: 'api_key' | 'oauth' | 'aws_sdk' | null;
  /**
   * Coarse capability hints so a runner can pick the right call shape.
   * Optional — absent means "unknown".
   */
  readonly capabilities?: ModelCaps;
  /** Bedrock / Gemini region. `null` when not applicable. */
  readonly region?: string | null;
}
