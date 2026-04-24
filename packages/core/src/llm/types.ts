/**
 * Public response/stream/iteration types for the CLEO LLM API.
 *
 * Ported from Honcho src/llm/types.py — all public shapes used by
 * callers of `cleoLlmCall()`. Langfuse decorators removed; provider
 * client union adapted for TypeScript SDK packages.
 *
 * @task T1387 (T1386-W1)
 * @epic T1386
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import type { OpenAI } from 'openai';
import type { z } from 'zod';

// --- Reasoning effort / verbosity literals ---

/** OpenAI GPT-5 reasoning effort levels. */
export type ReasoningEffortType =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | null
  | undefined;

/** Output verbosity levels for supported models. */
export type VerbosityType = 'low' | 'medium' | 'high' | null | undefined;

/** Supported provider transport names. */
export type ModelTransport = 'anthropic' | 'openai' | 'gemini';

/** Raw SDK client union used by the provider-selection layer. */
export type ProviderClient =
  | Anthropic
  | OpenAI
  | import('@google/generative-ai').GoogleGenerativeAI
  | Record<string, unknown>; // fallback for gemini aio client shape

// --- Iteration tracking ---

/**
 * Data passed to iteration callbacks after each tool execution loop iteration.
 */
export interface IterationData {
  /** 1-indexed iteration number. */
  iteration: number;
  /** List of tool names called in this iteration. */
  toolCalls: string[];
  /** Input tokens used in this iteration's LLM call. */
  inputTokens: number;
  /** Output tokens generated in this iteration's LLM call. */
  outputTokens: number;
  /** Tokens read from cache in this iteration. */
  cacheReadTokens: number;
  /** Tokens written to cache in this iteration. */
  cacheCreationTokens: number;
}

/** Callback fired after each tool iteration with usage data. */
export type IterationCallback = (data: IterationData) => void;

// --- Response shapes ---

/**
 * Response object for a completed LLM call.
 *
 * Note:
 *   Uncached input tokens = inputTokens - cacheReadInputTokens + cacheCreationInputTokens
 *   (cache_creation costs 25% more, cache_read costs 90% less)
 */
export interface LLMCallResponse<T = string> {
  content: T;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  finishReasons: string[];
  toolCallsMade: Array<Record<string, unknown>>;
  /** Number of LLM calls made in the tool execution loop. */
  iterations: number;
  thinkingContent: string | null;
  /** Full thinking blocks with signatures for multi-turn replay (Anthropic only). */
  thinkingBlocks: Array<Record<string, unknown>>;
  /** OpenRouter reasoning_details for Gemini models — preserved across turns. */
  reasoningDetails: Array<Record<string, unknown>>;
}

/** A single chunk in a streaming LLM response. */
export interface LLMStreamChunk {
  content: string;
  isDone: boolean;
  finishReasons: string[];
  outputTokens?: number | null;
}

/**
 * Streaming response wrapper carrying metadata from a completed tool loop.
 *
 * Lets callers read toolCallsMade / token counts / thinkingContent from the
 * tool-execution phase while still iterating the final streamed answer.
 */
export class StreamingResponseWithMetadata implements AsyncIterable<LLMStreamChunk> {
  readonly toolCallsMade: Array<Record<string, unknown>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly thinkingContent: string | null;
  readonly iterations: number;

  private readonly _stream: AsyncIterable<LLMStreamChunk>;

  constructor(params: {
    stream: AsyncIterable<LLMStreamChunk>;
    toolCallsMade: Array<Record<string, unknown>>;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    thinkingContent?: string | null;
    iterations?: number;
  }) {
    this._stream = params.stream;
    this.toolCallsMade = params.toolCallsMade;
    this.inputTokens = params.inputTokens;
    this.outputTokens = params.outputTokens;
    this.cacheCreationInputTokens = params.cacheCreationInputTokens;
    this.cacheReadInputTokens = params.cacheReadInputTokens;
    this.thinkingContent = params.thinkingContent ?? null;
    this.iterations = params.iterations ?? 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<LLMStreamChunk> {
    return this._stream[Symbol.asyncIterator]();
  }
}

// Re-export zod for structured output schemas
export type {
  /** @deprecated Use LLMCallResponse<T> */
  LLMCallResponse as HonchoLLMCallResponse,
  LLMStreamChunk as HonchoLLMCallStreamChunk,
  z,
};
