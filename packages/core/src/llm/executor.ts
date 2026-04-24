/**
 * Single-call executor: the inner LLM-call path without tool-loop orchestration.
 *
 * Ported from Honcho src/llm/executor.py (226 LOC). Handles one backend call
 * (complete or stream), building the effective ModelConfig and delegating to
 * request-builder. Result/stream chunk types are bridged to public shapes here.
 *
 * Used by:
 * - api.ts (public entrypoint, for both tool-less and tool-enabled paths)
 * - tool-loop.ts (each iteration calls this)
 *
 * @task T1395 (T1386-W9)
 * @epic T1386
 */

import type { CompletionResult, ToolCallResult } from './backend.js';
import { backendForProvider, CLIENTS } from './registry.js';
import { executeCompletion, executeStream } from './request-builder.js';
import { effectiveConfigForCall } from './runtime.js';
import type {
  LLMCallResponse,
  LLMStreamChunk,
  ProviderClient,
  ReasoningEffortType,
} from './types.js';
import type { ModelConfig, ModelTransport } from './types-config.js';

function toolCallResultToDict(tc: ToolCallResult): Record<string, unknown> {
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

/** Bridge a backend CompletionResult to the public LLMCallResponse shape. */
export function completionResultToResponse(result: CompletionResult): LLMCallResponse<unknown> {
  return {
    content: result.content,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    finishReasons: result.finishReason ? [result.finishReason] : [],
    toolCallsMade: result.toolCalls.map(toolCallResultToDict),
    iterations: 0,
    thinkingContent: result.thinkingContent,
    thinkingBlocks: result.thinkingBlocks,
    reasoningDetails: result.reasoningDetails,
  };
}

/** Bridge a backend StreamChunk to the public LLMStreamChunk shape. */
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

/** Parameters for cleoLlmCallInner. */
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

/**
 * One backend call. No retry, no fallback, no tool loop.
 *
 * The outer api.ts `cleoLlmCall` handles retry + fallback + tool orchestration on top.
 */
export async function cleoLlmCallInner(
  params: LlmCallInnerParams & { stream: true },
): Promise<AsyncGenerator<LLMStreamChunk>>;
export async function cleoLlmCallInner(
  params: LlmCallInnerParams & { stream?: false },
): Promise<LLMCallResponse<unknown>>;
export async function cleoLlmCallInner(
  params: LlmCallInnerParams,
): Promise<LLMCallResponse<unknown> | AsyncGenerator<LLMStreamChunk>>;
export async function cleoLlmCallInner(
  params: LlmCallInnerParams,
): Promise<LLMCallResponse<unknown> | AsyncGenerator<LLMStreamChunk>> {
  const {
    provider,
    model,
    prompt,
    maxTokens,
    responseModel,
    jsonMode = false,
    temperature,
    stopSeqs,
    reasoningEffort,
    verbosity,
    thinkingBudgetTokens,
    stream = false,
    clientOverride,
    tools,
    toolChoice,
    messages,
    selectedConfig,
  } = params;

  const client = clientOverride ?? CLIENTS[provider];
  if (!client) {
    throw new Error(`Missing client for provider: ${provider}`);
  }

  const effectiveMsgs: Array<Record<string, unknown>> = messages ?? [
    { role: 'user', content: prompt },
  ];

  const backend = backendForProvider(provider, client);

  const effectiveConfig = effectiveConfigForCall({
    selectedConfig: selectedConfig ?? null,
    provider,
    model,
    temperature: temperature ?? null,
    stopSeqs: stopSeqs ?? null,
    thinkingBudgetTokens: thinkingBudgetTokens ?? null,
    reasoningEffort: reasoningEffort ?? null,
  });

  const callExtras: Record<string, unknown> = {
    json_mode: jsonMode,
    verbosity: verbosity ?? null,
  };

  if (stream) {
    async function* _stream(): AsyncGenerator<LLMStreamChunk> {
      const streamIter = executeStream(backend, effectiveConfig, {
        messages: effectiveMsgs,
        maxTokens,
        tools: tools ?? null,
        toolChoice: toolChoice ?? null,
        responseFormat: responseModel ?? null,
        cachePolicy: effectiveConfig.cachePolicy ?? null,
        extraParams: callExtras,
      });
      for await (const chunk of streamIter) {
        yield streamChunkToResponseChunk(chunk);
      }
    }
    return _stream();
  }

  const result = await executeCompletion(backend, effectiveConfig, {
    messages: effectiveMsgs,
    maxTokens,
    tools: tools ?? null,
    toolChoice: toolChoice ?? null,
    responseFormat: responseModel ?? null,
    cachePolicy: effectiveConfig.cachePolicy ?? null,
    extraParams: callExtras,
  });

  return completionResultToResponse(result);
}
