/**
 * Runtime config planning and retry/fallback selection.
 *
 * Ported from PSYCHE src/llm/runtime.py (236 LOC).
 *
 * Owns:
 * - Resolution of ModelConfig (no ConfiguredModelSettings in CLEO — direct ModelConfig)
 * - Per-attempt planning (AttemptPlan) including primary/fallback selection
 * - Per-call effective config construction
 * - Retry attempt tracking via simple mutable ref (simpler than AsyncLocalStorage)
 *
 * Langfuse: no-op (telemetry not wired in CLEO).
 *
 * @task T1398 (T1386-W12)
 * @epic T1386
 */

import { clientForModelConfig } from './registry.js';
import type { ProviderClient, ReasoningEffortType } from './types.js';
import type { ModelConfig, ModelTransport } from './types-config.js';

/** Per-attempt plan produced by planAttempt. */
export interface AttemptPlan {
  readonly provider: ModelTransport;
  readonly model: string;
  readonly client: ProviderClient;
  readonly thinkingBudgetTokens: number | null | undefined;
  readonly reasoningEffort: ReasoningEffortType;
  readonly selectedConfig: ModelConfig;
}

/**
 * Simple mutable attempt counter — simpler than AsyncLocalStorage.
 * Tenacity wraps the call closure which captures this ref.
 */
export interface AttemptRef {
  value: number;
}

/** Create a new attempt ref starting at 1. */
export function makeAttemptRef(): AttemptRef {
  return { value: 1 };
}

/**
 * Pick the effective config for this attempt.
 * Primary config on all attempts except the last, which swaps to fallback (if any).
 */
export function selectModelConfigForAttempt(
  modelConfig: ModelConfig,
  attempt: number,
  retryAttempts: number,
): ModelConfig {
  if (
    attempt !== retryAttempts ||
    modelConfig.fallback === null ||
    modelConfig.fallback === undefined
  ) {
    return modelConfig;
  }
  const fb = modelConfig.fallback;
  return {
    model: fb.model,
    transport: fb.transport,
    fallback: null,
    apiKey: fb.apiKey,
    baseUrl: fb.baseUrl,
    temperature: fb.temperature,
    top_p: fb.top_p,
    top_k: fb.top_k,
    frequencyPenalty: fb.frequencyPenalty,
    presencePenalty: fb.presencePenalty,
    seed: fb.seed,
    thinkingEffort: fb.thinkingEffort,
    thinkingBudgetTokens: fb.thinkingBudgetTokens,
    providerParams: fb.providerParams,
    maxOutputTokens: fb.maxOutputTokens,
    stopSequences: fb.stopSequences,
    cachePolicy: fb.cachePolicy,
  };
}

/**
 * Build the AttemptPlan for the current attempt.
 */
export function planAttempt(params: {
  runtimeModelConfig: ModelConfig;
  attempt: number;
  retryAttempts: number;
  callThinkingBudgetTokens: number | null | undefined;
  callReasoningEffort: ReasoningEffortType;
}): AttemptPlan {
  const {
    runtimeModelConfig,
    attempt,
    retryAttempts,
    callThinkingBudgetTokens,
    callReasoningEffort,
  } = params;

  const selected = selectModelConfigForAttempt(runtimeModelConfig, attempt, retryAttempts);
  const provider = selected.transport;
  const client = clientForModelConfig(provider, selected);

  const isPrimary = selected === runtimeModelConfig;
  const attemptThinkingBudget = isPrimary
    ? callThinkingBudgetTokens
    : selected.thinkingBudgetTokens;
  const attemptReasoningEffort: ReasoningEffortType = isPrimary
    ? callReasoningEffort
    : (selected.thinkingEffort as ReasoningEffortType);

  return {
    provider,
    model: selected.model,
    client,
    thinkingBudgetTokens: attemptThinkingBudget,
    reasoningEffort: attemptReasoningEffort,
    selectedConfig: selected,
  };
}

/**
 * Build the effective ModelConfig passed to the executor / request_builder.
 *
 * Per-call kwargs (temperature, stop_seqs, thinking_*) win when set.
 * maxOutputTokens is forced to null so the per-call maxTokens kwarg is authoritative.
 */
export function effectiveConfigForCall(params: {
  selectedConfig: ModelConfig | null;
  provider: ModelTransport;
  model: string;
  temperature: number | null | undefined;
  stopSeqs: string[] | null | undefined;
  thinkingBudgetTokens: number | null | undefined;
  reasoningEffort: ReasoningEffortType;
}): ModelConfig {
  const {
    selectedConfig,
    provider,
    model,
    temperature,
    stopSeqs,
    thinkingBudgetTokens,
    reasoningEffort,
  } = params;

  if (!selectedConfig) {
    return {
      model,
      transport: provider,
      temperature: temperature ?? null,
      stopSequences: stopSeqs ?? null,
      thinkingBudgetTokens: thinkingBudgetTokens ?? null,
      thinkingEffort: reasoningEffort ?? null,
    };
  }

  const updates: Partial<ModelConfig> = { maxOutputTokens: null };
  if (temperature !== null && temperature !== undefined) updates.temperature = temperature;
  if (stopSeqs !== null && stopSeqs !== undefined) updates.stopSequences = stopSeqs;
  if (thinkingBudgetTokens !== null && thinkingBudgetTokens !== undefined)
    updates.thinkingBudgetTokens = thinkingBudgetTokens;
  if (reasoningEffort !== null && reasoningEffort !== undefined)
    updates.thinkingEffort = reasoningEffort;

  return { ...selectedConfig, ...updates };
}

/**
 * Bump temperature from 0.0 → 0.2 on retry attempts for variety.
 */
export function effectiveTemperature(
  temperature: number | null | undefined,
  currentAttempt: number,
): number | null | undefined {
  if (temperature === 0 && currentAttempt > 1) return 0.2;
  return temperature;
}
