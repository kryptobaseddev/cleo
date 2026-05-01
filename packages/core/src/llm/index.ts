/**
 * CLEO LLM layer barrel — exports the public API surface.
 *
 * IMPORTANT (R8): This barrel MUST NOT export types that conflict with
 * the Vercel AI SDK exports used by packages/core/src/memory/llm-backend-resolver.ts.
 * The new raw-SDK orchestration layer and the Vercel AI SDK path are orthogonal.
 *
 * @task T1400 (T1386-W14)
 * @epic T1386
 */

export type { CleoLlmCallParams } from './api.js';
// Public entrypoint
export { cleoLlmCall } from './api.js';
// Backend interface (for extensibility)
export type { CompletionResult, ProviderBackend, StreamChunk, ToolCallResult } from './backend.js';
export { makeCompletionResult } from './backend.js';
// Backends (for direct use / custom wiring)
export { AnthropicBackend } from './backends/anthropic.js';
export { GeminiBackend } from './backends/gemini.js';
export { OpenAIBackend, usesMaxCompletionTokens } from './backends/openai.js';
export type { GeminiCacheHandle } from './caching.js';
// Caching
export { buildCacheKey, geminiCacheStore, InMemoryGeminiCacheStore } from './caching.js';
// Conversation utilities
export { countMessageTokens, truncateMessagesToFit } from './conversation.js';
export type {
  CredentialResolveOptions,
  CredentialResult,
  CredentialSource,
} from './credentials.js';
// Credential resolver (T1677)
export {
  clearAnthropicKeyCache,
  defaultTransportApiKey,
  resolveAnthropicApiKey,
  resolveAnthropicApiKeySource,
  resolveCredentials,
  resolveModelCredentials,
  storeAnthropicApiKey,
} from './credentials.js';
// Executor (inner call, for testing)
export { cleoLlmCallInner, completionResultToResponse } from './executor.js';
// History adapters
export {
  AnthropicHistoryAdapter,
  GeminiHistoryAdapter,
  OpenAIHistoryAdapter,
} from './history-adapters.js';
// Registry (for testing/DI)
export { backendForProvider, CLIENTS, clientForModelConfig, getBackend } from './registry.js';
// Runtime
export type { AttemptPlan } from './runtime.js';
export { effectiveTemperature, makeAttemptRef, planAttempt } from './runtime.js';
export type { StructuredOutputFailurePolicy } from './structured-output.js';
// Structured output utilities
export {
  attemptStructuredOutputRepair,
  emptyStructuredOutput,
  executeStructuredOutputCall,
  repairResponseModelJson,
  StructuredOutputError,
  validateStructuredOutput,
} from './structured-output.js';
// Response / stream types (scoped names to avoid collision with Vercel AI SDK)
export type {
  IterationCallback,
  IterationData,
  LLMCallResponse,
  LLMStreamChunk,
  ModelTransport,
  ProviderClient,
  ReasoningEffortType,
  VerbosityType,
} from './types.js';
export { StreamingResponseWithMetadata } from './types.js';
// Config types (re-exported from contracts)
export type {
  DaemonLLMConfig,
  LlmConfig,
  LlmProviderEntry,
  ModelConfig,
  PromptCachePolicy,
} from './types-config.js';
