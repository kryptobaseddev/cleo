/**
 * Transport registry barrel — maps ApiMode to transport class.
 *
 * Centralises all transport exports so consumer modules can import from a
 * single path (`./transports/index.js`) rather than from individual files.
 *
 * ApiMode → Transport mapping (canonical, per ADR-072):
 * - `anthropic_messages` → {@link AnthropicTransport}
 * - `bedrock_converse`   → {@link BedrockTransport}
 * - `chat_completions`   → {@link ChatCompletionsTransport} (generic OpenAI-compat)
 * - `codex_responses`    → {@link CodexResponsesTransport}
 * - `gemini`             → {@link GeminiTransport} (native Gemini SDK)
 * - `ollama_native`      → {@link OllamaTransport}
 *
 * (The legacy native-OpenAI-SDK `OpenAITransport` was removed under T11832 —
 * it was unreachable, superseded by `ChatCompletionsTransport` on the live
 * ModelRunner path; the `usesMaxCompletionTokens` predicate moved to
 * `llm/model-metadata.ts`.)
 *
 * Note: `GeminiTransport` uses the native `@google/generative-ai` SDK and
 * speaks `chat_completions` when proxied via Gemini's OpenAI-compat shim,
 * but uses `gemini_native` internally. For the OpenAI-compat path use
 * `ChatCompletionsTransport` with a Gemini profile.
 *
 * @module llm/transports
 * @task T9355 (Task A — Ollama transport, D-ph4-05 closure)
 * @epic T9354
 */

export type { AnthropicTransportOptions } from './anthropic.js';
export { AnthropicTransport } from './anthropic.js';
export type { BedrockTransportOptions } from './bedrock.js';
export { BedrockTransport } from './bedrock.js';
export type { ChatCompletionsTransportOptions } from './chat-completions.js';
export { ChatCompletionsTransport } from './chat-completions.js';
export type { CodexResponsesTransportOptions } from './codex-responses.js';
export { CodexResponsesTransport } from './codex-responses.js';
export type { GeminiTransportOptions } from './gemini.js';
export { GeminiTransport } from './gemini.js';
export type { OllamaTransportOptions } from './ollama.js';
export { OLLAMA_DEFAULT_BASE_URL, OllamaTransport } from './ollama.js';
