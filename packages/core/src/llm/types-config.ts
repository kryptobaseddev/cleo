/**
 * ModelConfig and related types for the CLEO LLM layer.
 *
 * These types are defined here to avoid circular import issues and because
 * the contracts package exports them under the `ops` namespace. For external
 * consumers, the contracts package provides the canonical versions.
 *
 * @task T1386
 */

/** Supported provider transport names. */
export type ModelTransport = 'anthropic' | 'openai' | 'gemini';

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
  /** Full model identifier string. */
  model: string;
  /** Override API key (uses env defaults if null). */
  apiKey?: string | null;
  /** Override base URL for proxy providers. */
  baseUrl?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  seed?: number | null;
  thinkingEffort?: string | null;
  thinkingBudgetTokens?: number | null;
  providerParams?: Record<string, unknown> | null;
  maxOutputTokens?: number | null;
  stopSequences?: string[] | null;
  cachePolicy?: PromptCachePolicy | null;
  fallback?: Omit<ModelConfig, 'fallback'> | null;
}

/** Parameters for a single LLM call. */
export interface LLMCallParams {
  modelConfig: ModelConfig;
  prompt: string;
  maxTokens: number;
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

/** Tool call result descriptor. */
export interface ToolCallParams {
  id: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string | null;
}

/** Tool execution result. */
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
