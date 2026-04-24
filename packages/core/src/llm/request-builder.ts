/**
 * Low-level request assembly: flatten a ModelConfig into backend calls.
 *
 * Ported from PSYCHE src/llm/request_builder.py. Does NOT own: retry,
 * fallback, tool loop, provider selection. Those live in api.ts, tool-loop.ts,
 * runtime.ts.
 *
 * @task T1394 (T1386-W8)
 * @epic T1386
 */

import type { CompletionResult, ProviderBackend, StreamChunk } from './backend.js';
import type { ModelConfig, PromptCachePolicy } from './types-config.js';

/** Flatten ModelConfig optional knobs into extra_params dict. */
export function buildConfigExtraParams(config: ModelConfig): Record<string, unknown> {
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

/**
 * Execute a non-streaming LLM completion via the backend.
 */
export async function executeCompletion(
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

/**
 * Execute a streaming LLM call via the backend.
 */
export function executeStream(
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
