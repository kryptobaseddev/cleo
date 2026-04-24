/**
 * Transport-agnostic interface for LLM providers.
 *
 * Ported from PSYCHE src/llm/backend.py. Credentials are baked into the
 * underlying SDK client at backend construction time (see registry.ts),
 * so these method signatures deliberately do not accept api_key / api_base.
 *
 * @task T1388 (T1386-W2)
 * @epic T1386
 */

import type { z } from 'zod';

// --- Normalized data shapes ---

/** Normalized tool call from any provider. */
export interface ToolCallResult {
  id: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string | null;
}

/** Normalized completion result returned by provider backends. */
export interface CompletionResult {
  content: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  finishReason: string;
  toolCalls: ToolCallResult[];
  thinkingContent: string | null;
  thinkingBlocks: Array<Record<string, unknown>>;
  reasoningDetails: Array<Record<string, unknown>>;
  rawResponse?: unknown;
}

/** A single chunk in a streaming response from a backend. */
export interface StreamChunk {
  content: string;
  isDone: boolean;
  finishReason?: string | null;
  outputTokens?: number | null;
}

/** Factory function for creating a default CompletionResult. */
export function makeCompletionResult(
  partial: Partial<CompletionResult> & Pick<CompletionResult, 'content'>,
): CompletionResult {
  return {
    content: partial.content,
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    cacheCreationInputTokens: partial.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: partial.cacheReadInputTokens ?? 0,
    finishReason: partial.finishReason ?? 'stop',
    toolCalls: partial.toolCalls ?? [],
    thinkingContent: partial.thinkingContent ?? null,
    thinkingBlocks: partial.thinkingBlocks ?? [],
    reasoningDetails: partial.reasoningDetails ?? [],
    rawResponse: partial.rawResponse,
  };
}

// --- Provider backend interface ---

/** Common parameters for complete() and stream() calls. */
export interface BackendCallParams {
  model: string;
  messages: Array<Record<string, unknown>>;
  maxTokens: number;
  temperature?: number | null;
  stop?: string[] | null;
  tools?: Array<Record<string, unknown>> | null;
  toolChoice?: string | Record<string, unknown> | null;
  responseFormat?: (new (...args: unknown[]) => unknown) | Record<string, unknown> | null;
  thinkingBudgetTokens?: number | null;
  thinkingEffort?: string | null;
  maxOutputTokens?: number | null;
  extraParams?: Record<string, unknown> | null;
}

/**
 * Transport-agnostic interface for LLM providers.
 *
 * Implementations: AnthropicBackend, OpenAIBackend, GeminiBackend.
 */
export interface ProviderBackend {
  complete(params: BackendCallParams): Promise<CompletionResult>;
  stream(params: BackendCallParams): AsyncGenerator<StreamChunk>;
}

// Zod re-export for structured schemas used in response_format
export type { z };
