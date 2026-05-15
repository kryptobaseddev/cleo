/**
 * Single-call executor: the inner LLM-call path without tool-loop orchestration.
 *
 * Ported from PSYCHE src/llm/executor.py (226 LOC). Handles one backend call
 * (complete or stream), building the effective ModelConfig and delegating to
 * the now-inlined request-builder logic.
 *
 * Used by:
 * - api.ts (public entrypoint, for both tool-less and tool-enabled paths)
 * - tool-loop.ts (each iteration calls this)
 *
 * @task T1395 (T1386-W9)
 * @task T9289 (W2c — retire ProviderBackend; inline backend types + request-builder)
 * @epic T1386
 */

import { CLIENTS } from './registry.js';
import { effectiveConfigForCall } from './runtime.js';
import type {
  LLMCallResponse,
  LLMStreamChunk,
  ProviderClient,
  ReasoningEffortType,
} from './types.js';
import type { ModelConfig, ModelTransport, PromptCachePolicy } from './types-config.js';

// ---------------------------------------------------------------------------
// Inlined ProviderBackend types (formerly backend.ts — T9289)
// TODO(T9292 W3): migrate callers to LlmTransport/NormalizedResponse
// ---------------------------------------------------------------------------

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

/** Transport-agnostic interface for LLM providers. */
export interface ProviderBackend {
  complete(params: BackendCallParams): Promise<CompletionResult>;
  stream(params: BackendCallParams): AsyncGenerator<StreamChunk>;
}

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

// ---------------------------------------------------------------------------
// Inlined request-builder helpers (formerly request-builder.ts — T9289)
// TODO(T9292 W3): delete after executor migrates to LlmTransport
// ---------------------------------------------------------------------------

/** Parameters for executeCompletion and executeStream. */
export interface ExecuteParams {
  messages: Array<Record<string, unknown>>;
  maxTokens: number;
  tools?: Array<Record<string, unknown>> | null;
  toolChoice?: string | Record<string, unknown> | null;
  responseFormat?: (new (...args: unknown[]) => unknown) | Record<string, unknown> | null;
  stop?: string[] | null;
  cachePolicy?: PromptCachePolicy | null;
  extraParams?: Record<string, unknown> | null;
}

/** Flatten ModelConfig optional knobs into extra_params dict. */
function buildConfigExtraParams(config: ModelConfig): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (config.top_p !== null && config.top_p !== undefined) extra['top_p'] = config.top_p;
  if (config.top_k !== null && config.top_k !== undefined) extra['top_k'] = config.top_k;
  if (config.frequencyPenalty !== null && config.frequencyPenalty !== undefined)
    extra['frequency_penalty'] = config.frequencyPenalty;
  if (config.presencePenalty !== null && config.presencePenalty !== undefined)
    extra['presence_penalty'] = config.presencePenalty;
  if (config.seed !== null && config.seed !== undefined) extra['seed'] = config.seed;
  if (config.providerParams) Object.assign(extra, config.providerParams);
  return extra;
}

function executeCompletion(
  backend: ProviderBackend,
  config: ModelConfig,
  params: ExecuteParams,
): Promise<CompletionResult> {
  const effectiveMaxTokens = config.maxOutputTokens ?? params.maxTokens;

  const mergedExtra: Record<string, unknown> = {
    ...buildConfigExtraParams(config),
    ...(params.extraParams ?? {}),
  };
  if (params.cachePolicy !== null && params.cachePolicy !== undefined) {
    mergedExtra['cache_policy'] = params.cachePolicy;
  }

  return backend.complete({
    model: config.model,
    messages: params.messages,
    maxTokens: effectiveMaxTokens,
    temperature: config.temperature,
    stop: params.stop ?? config.stopSequences,
    tools: params.tools,
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
    thinkingBudgetTokens: config.thinkingBudgetTokens,
    thinkingEffort: config.thinkingEffort,
    maxOutputTokens: effectiveMaxTokens,
    extraParams: mergedExtra,
  });
}

function executeStream(
  backend: ProviderBackend,
  config: ModelConfig,
  params: ExecuteParams,
): AsyncGenerator<StreamChunk> {
  const effectiveMaxTokens = config.maxOutputTokens ?? params.maxTokens;

  const mergedExtra: Record<string, unknown> = {
    ...buildConfigExtraParams(config),
    ...(params.extraParams ?? {}),
  };
  if (params.cachePolicy !== null && params.cachePolicy !== undefined) {
    mergedExtra['cache_policy'] = params.cachePolicy;
  }

  return backend.stream({
    model: config.model,
    messages: params.messages,
    maxTokens: effectiveMaxTokens,
    temperature: config.temperature,
    stop: params.stop ?? config.stopSequences,
    tools: params.tools,
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
    thinkingBudgetTokens: config.thinkingBudgetTokens,
    thinkingEffort: config.thinkingEffort,
    maxOutputTokens: effectiveMaxTokens,
    extraParams: mergedExtra,
  });
}

// ---------------------------------------------------------------------------
// Stub ProviderBackend factory (formerly backendForProvider in registry.ts)
// Always throws — callers should migrate to LlmTransport in W3.
// ---------------------------------------------------------------------------

/**
 * @deprecated MoonshotBackend removed (T9286 W1d). All backends removed (T9289 W2c).
 * Use LlmTransport implementations instead. Callers will be migrated in W3.
 */
function backendForProviderStub(provider: ModelTransport): ProviderBackend {
  throw new Error(
    `backendForProvider: no backend for '${provider}'. Migrate to LlmTransport (W3).`,
  );
}

// ---------------------------------------------------------------------------
// executor.ts public API
// ---------------------------------------------------------------------------

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
 *
 * TODO(T9292 W3): migrate to ConcreteExecutor / LlmTransport.
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

  const _client: ProviderClient | undefined = clientOverride ?? CLIENTS[provider];
  if (!_client) {
    throw new Error(`Missing client for provider: ${provider}`);
  }

  const effectiveMsgs: Array<Record<string, unknown>> = messages ?? [
    { role: 'user', content: prompt },
  ];

  const backend = backendForProviderStub(provider);

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
