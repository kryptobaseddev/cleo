/**
 * LLM operations contract types for the CLEO LLM abstraction layer.
 *
 * These are the wire-format types for the new `cleoLlmCall()` API surface
 * ported from PSYCHE's llm/ layer. They live in contracts so that packages
 * outside core can reference them without importing the full SDK.
 *
 * @task T1399 (T1386-W13)
 * @epic T1386
 */

/** Supported provider transport names. */
export type ModelTransport = 'anthropic' | 'openai' | 'gemini' | 'moonshot';

/** Cache policy mode for prompt prefix caching. */
export type PromptCachePolicyMode = 'gemini_cached_content';

/** Prompt caching policy descriptor. */
export interface PromptCachePolicy {
  /** Cache mode — only 'gemini_cached_content' currently supported. */
  mode: PromptCachePolicyMode;
  /** TTL in seconds for the cached content (default: 300). */
  ttlSeconds?: number;
  /** Key version for cache invalidation. */
  keyVersion?: string;
}

/** Model configuration for a single provider. */
export interface ModelConfig {
  /** Provider SDK transport. */
  transport: ModelTransport;
  /** Full model identifier string (e.g. 'claude-sonnet-4-6', 'gpt-4o', 'gemini-pro'). */
  model: string;
  /** Override API key (uses env defaults if null). */
  apiKey?: string | null;
  /** Override base URL for proxy providers. */
  baseUrl?: string | null;
  /** Sampling temperature. */
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  seed?: number | null;
  /** OpenAI reasoning effort level. */
  thinkingEffort?: string | null;
  /** Anthropic extended thinking budget tokens. */
  thinkingBudgetTokens?: number | null;
  /** Provider-specific passthrough params. */
  providerParams?: Record<string, unknown> | null;
  /** Override max output tokens (null = use per-call maxTokens). */
  maxOutputTokens?: number | null;
  /** Stop sequences. */
  stopSequences?: string[] | null;
  /** Prompt caching policy. */
  cachePolicy?: PromptCachePolicy | null;
  /** Fallback model config used on final retry attempt. */
  fallback?: Omit<ModelConfig, 'fallback'> | null;
}

/** Parameters for a single LLM call. */
export interface LLMCallParams {
  modelConfig: ModelConfig;
  prompt: string;
  maxTokens: number;
  /** Optional pre-built message list (overrides prompt string). */
  messages?: Array<Record<string, unknown>> | null;
  temperature?: number | null;
  stopSeqs?: string[] | null;
  jsonMode?: boolean;
  reasoningEffort?: string | null;
  verbosity?: 'low' | 'medium' | 'high' | null;
  thinkingBudgetTokens?: number | null;
  enableRetry?: boolean;
  retryAttempts?: number;
  stream?: boolean;
  streamFinalOnly?: boolean;
  tools?: Array<Record<string, unknown>> | null;
  toolChoice?: string | Record<string, unknown> | null;
  maxToolIterations?: number;
  maxInputTokens?: number | null;
  traceName?: string | null;
  trackName?: string | null;
}

/** Tool call parameters from the LLM. */
export interface ToolCallParams {
  id: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string | null;
}

/** Tool execution result to feed back to the LLM. */
export interface ToolResult {
  toolId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

/** Result of a completed LLM call. */
export interface LLMCallResult<T = string> {
  content: T;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  finishReasons: string[];
  toolCallsMade: ToolCallParams[];
  iterations: number;
  thinkingContent: string | null;
  thinkingBlocks: Array<Record<string, unknown>>;
  reasoningDetails: Array<Record<string, unknown>>;
}
