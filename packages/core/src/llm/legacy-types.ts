/**
 * Legacy executor type shims — kept for backwards compatibility.
 *
 * These types were previously in executor.ts alongside cleoLlmCallInner.
 * They are retained here because tool-loop.ts, history-adapters.ts, and
 * structured-output.ts still reference them.
 *
 * TODO(T9298 W5): migrate all consumers to LlmTransport / NormalizedResponse
 * and delete this file.
 *
 * @module llm/legacy-types
 * @deprecated Use {@link LlmTransport} / {@link NormalizedResponse} instead.
 * @task T9292
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { LLMCallResponse, LLMStreamChunk } from './types.js';
import type { ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// ProviderBackend shims (backends removed in T9289 W2c)
// ---------------------------------------------------------------------------

/** Normalized tool call from any provider. @deprecated */
export interface ToolCallResult {
  id: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string | null;
}

/** Normalized completion result returned by provider backends. @deprecated */
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

/** A single chunk in a streaming response from a backend. @deprecated */
export interface StreamChunk {
  content: string;
  isDone: boolean;
  finishReason?: string | null;
  outputTokens?: number | null;
}

/** Transport-agnostic interface for LLM providers. @deprecated */
export interface ProviderBackend {
  complete(params: BackendCallParams): Promise<CompletionResult>;
  stream(params: BackendCallParams): AsyncGenerator<StreamChunk>;
}

/** Common parameters for complete() and stream() calls. @deprecated */
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

/** Factory function for creating a default CompletionResult. @deprecated */
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

// ---------------------------------------------------------------------------
// Response bridge helpers (used by callers of the old executor API)
// ---------------------------------------------------------------------------

function _toolCallResultToDict(tc: ToolCallResult): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: tc.id,
    name: tc.name,
    input: tc.input,
  };
  if (tc.thoughtSignature !== null && tc.thoughtSignature !== undefined) {
    result['thought_signature'] = tc.thoughtSignature;
  }
  return result;
}

/**
 * Bridge a backend CompletionResult to the public LLMCallResponse shape.
 * @deprecated Use {@link NormalizedResponse} directly.
 */
export function completionResultToResponse(result: CompletionResult): LLMCallResponse<unknown> {
  return {
    content: result.content,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    finishReasons: result.finishReason ? [result.finishReason] : [],
    toolCallsMade: result.toolCalls.map(_toolCallResultToDict),
    iterations: 0,
    thinkingContent: result.thinkingContent,
    thinkingBlocks: result.thinkingBlocks,
    reasoningDetails: result.reasoningDetails,
  };
}

/**
 * Bridge a backend StreamChunk to the public LLMStreamChunk shape.
 * @deprecated
 */
export function streamChunkToResponseChunk(chunk: {
  content: string;
  isDone: boolean;
  finishReason?: string | null;
  outputTokens?: number | null;
}): LLMStreamChunk {
  return {
    content: chunk.content,
    isDone: chunk.isDone,
    finishReasons: chunk.finishReason ? [chunk.finishReason] : [],
    outputTokens: chunk.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// ExecuteParams — used internally by the legacy request-builder helpers
// ---------------------------------------------------------------------------

/** Parameters for executeCompletion and executeStream. @deprecated */
export interface ExecuteParams {
  messages: Array<Record<string, unknown>>;
  maxTokens: number;
  tools?: Array<Record<string, unknown>> | null;
  toolChoice?: string | Record<string, unknown> | null;
  responseFormat?: (new (...args: unknown[]) => unknown) | Record<string, unknown> | null;
  stop?: string[] | null;
  cachePolicy?: string | null;
  extraParams?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// LlmCallInnerParams — kept for type compatibility on call sites that still
// reference it. TODO(T9298 W5): remove.
// ---------------------------------------------------------------------------

import type { ProviderClient, ReasoningEffortType } from './types.js';
import type { ModelConfig } from './types-config.js';

/** @deprecated Parameters for cleoLlmCallInner (removed). */
export interface LlmCallInnerParams {
  provider: ModelTransport;
  model: string;
  prompt: string;
  maxTokens: number;
  responseModel?: (new (...args: unknown[]) => unknown) | null;
  jsonMode?: boolean;
  temperature?: number | null;
  stopSeqs?: string[] | null;
  reasoningEffort?: ReasoningEffortType;
  verbosity?: 'low' | 'medium' | 'high' | null;
  thinkingBudgetTokens?: number | null;
  stream?: boolean;
  clientOverride?: ProviderClient | null;
  tools?: Array<Record<string, unknown>> | null;
  toolChoice?: string | Record<string, unknown> | null;
  messages?: Array<Record<string, unknown>> | null;
  selectedConfig?: ModelConfig | null;
}
