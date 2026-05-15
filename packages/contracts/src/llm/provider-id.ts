/**
 * Provider identity and API protocol types for the unified LLM provider architecture.
 *
 * These types anchor the Phase 4 contract layer (ADR-072). All downstream code
 * that references a provider by name or by wire-protocol uses these types.
 *
 * @module llm/provider-id
 * @task T9281
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §Type lock-in
 */

/**
 * Canonical wire-level API protocol supported by a provider.
 *
 * Closed 4-value union. Providers that speak multiple protocols (e.g. OpenAI
 * supports both chat_completions and codex_responses) declare separate
 * ProviderProfiles, one per ApiMode.
 *
 * Adding a fifth value is a major breaking change — confirm in ADR-072 before doing so.
 *
 * @see ADR-072 §Type lock-in
 */
export type ApiMode =
  | 'chat_completions' // OpenAI, OpenRouter, Groq, DeepSeek, Moonshot, xAI, Gemini-via-OR
  | 'anthropic_messages' // Native Anthropic SDK — full prompt-cache + thinking
  | 'codex_responses' // OpenAI Responses API (Codex CLI, xAI-responses)
  | 'bedrock_converse'; // AWS Bedrock ConversationAPI

/**
 * Fixed set of builtin provider identifiers shipped with CLEO core.
 *
 * Plugin providers registered at runtime may use any non-empty string —
 * see {@link ProviderId}.
 *
 * MIGRATION NOTE: The legacy `ModelTransport` ('anthropic'|'openai'|'gemini'|'moonshot')
 * is re-typed as `Extract<ProviderId, BuiltinProviderId>` for one release cycle
 * (deprecated, then removed).
 */
export type BuiltinProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'moonshot'
  | 'openrouter'
  | 'bedrock'
  | 'deepseek'
  | 'xai'
  | 'groq'
  | 'kimi-code';

/**
 * Provider identity string.
 *
 * Builtin providers use the fixed literals in {@link BuiltinProviderId}.
 * Plugin providers registered at runtime via `ProviderRegistry` may use any
 * non-empty string. The open string union allows plugins without forcing
 * exhaustive switch checks in transport code (match arms should include a
 * default/unknown branch).
 *
 * @see ADR-072 §Type lock-in
 */
export type ProviderId = BuiltinProviderId | (string & Record<never, never>);
