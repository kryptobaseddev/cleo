/**
 * Public LLM entrypoint: `cleoLlmCall`.
 *
 * Ported from Honcho src/llm/api.py (366 LOC). Orchestrates:
 * - Runtime config resolution from ModelConfig.
 * - Per-attempt planning (primary vs fallback selection).
 * - Retry with exponential backoff via p-retry.
 * - Tool-loop delegation when tools are supplied.
 * - Single-call delegation to the executor otherwise.
 *
 * Langfuse / Sentry decorators removed (no-op telemetry in CLEO).
 *
 * @task T1400 (T1386-W14)
 * @epic T1386
 */

import pRetry from 'p-retry';

import { cleoLlmCallInner } from './executor.js';
import { effectiveTemperature, makeAttemptRef, planAttempt } from './runtime.js';
import { executeToolLoop } from './tool-loop.js';
import type {
  IterationCallback,
  LLMCallResponse,
  LLMStreamChunk,
  ReasoningEffortType,
  StreamingResponseWithMetadata,
  VerbosityType,
} from './types.js';
import type { ModelConfig } from './types-config.js';

export interface CleoLlmCallParams {
  modelConfig: ModelConfig;
  prompt: string;
  maxTokens: number;
  trackName?: string | null;
  responseModel?: (new (...args: unknown[]) => unknown) | null;
  jsonMode?: boolean;
  temperature?: number | null;
  stopSeqs?: string[] | null;
  reasoningEffort?: ReasoningEffortType;
  verbosity?: VerbosityType;
  thinkingBudgetTokens?: number | null;
  enableRetry?: boolean;
  retryAttempts?: number;
  stream?: boolean;
  streamFinalOnly?: boolean;
  tools?: Array<Record<string, unknown>> | null;
  toolChoice?: string | Record<string, unknown> | null;
  toolExecutor?: ((name: string, input: Record<string, unknown>) => Promise<unknown>) | null;
  maxToolIterations?: number;
  messages?: Array<Record<string, unknown>> | null;
  maxInputTokens?: number | null;
  traceName?: string | null;
  iterationCallback?: IterationCallback | null;
}

/**
 * Make an LLM call with retry, optional backup failover, and optional tool loop.
 *
 * Backup provider/model (if configured on the primary ModelConfig's `fallback`)
 * is used on the final retry attempt (default retry_attempts=3).
 */
export async function cleoLlmCall(
  params: CleoLlmCallParams,
): Promise<
  LLMCallResponse<unknown> | AsyncGenerator<LLMStreamChunk> | StreamingResponseWithMetadata
> {
  const {
    modelConfig,
    prompt,
    maxTokens,
    responseModel = null,
    jsonMode = false,
    temperature = null,
    stopSeqs = null,
    reasoningEffort = null,
    verbosity = null,
    thinkingBudgetTokens = null,
    enableRetry = true,
    retryAttempts = 3,
    stream = false,
    streamFinalOnly = false,
    tools = null,
    toolChoice = null,
    toolExecutor = null,
    maxToolIterations = 10,
    messages = null,
    iterationCallback = null,
  } = params;

  if (stream && tools && tools.length > 0 && !streamFinalOnly) {
    throw new Error(
      'Streaming is not supported with tool calling. ' +
        'Set stream=false when using tools, or use streamFinalOnly=true ' +
        'to stream only the final response after tool calls.',
    );
  }

  const attemptRef = makeAttemptRef();

  function getAttemptPlan() {
    return planAttempt({
      runtimeModelConfig: modelConfig,
      attempt: attemptRef.value,
      retryAttempts,
      callThinkingBudgetTokens: thinkingBudgetTokens,
      callReasoningEffort: reasoningEffort,
    });
  }

  async function callWithProviderSelection(): Promise<
    LLMCallResponse<unknown> | AsyncGenerator<LLMStreamChunk>
  > {
    const plan = getAttemptPlan();

    if (stream) {
      const r = await cleoLlmCallInner({
        provider: plan.provider,
        model: plan.model,
        prompt,
        maxTokens,
        responseModel,
        jsonMode,
        temperature: effectiveTemperature(temperature, attemptRef.value),
        stopSeqs,
        reasoningEffort: plan.reasoningEffort,
        verbosity,
        thinkingBudgetTokens: plan.thinkingBudgetTokens,
        stream: true,
        clientOverride: plan.client,
        tools,
        toolChoice,
        messages,
        selectedConfig: plan.selectedConfig,
      });
      return r;
    }

    const r = await cleoLlmCallInner({
      provider: plan.provider,
      model: plan.model,
      prompt,
      maxTokens,
      responseModel,
      jsonMode,
      temperature: effectiveTemperature(temperature, attemptRef.value),
      stopSeqs,
      reasoningEffort: plan.reasoningEffort,
      verbosity,
      thinkingBudgetTokens: plan.thinkingBudgetTokens,
      stream: false,
      clientOverride: plan.client,
      tools,
      toolChoice,
      messages,
      selectedConfig: plan.selectedConfig,
    });
    return r as LLMCallResponse<unknown>;
  }

  function beforeRetryCallback(_err: Error, attemptNumber: number): void {
    const next = attemptNumber + 1;
    attemptRef.value = next;
  }

  let decoratedCall = callWithProviderSelection;

  if (enableRetry) {
    const retryCall = () =>
      pRetry(callWithProviderSelection, {
        retries: retryAttempts - 1,
        minTimeout: 4000,
        maxTimeout: 10000,
        factor: 2,
        onFailedAttempt: (failedAttemptError) => {
          beforeRetryCallback(
            failedAttemptError as unknown as Error,
            failedAttemptError.attemptNumber,
          );
        },
      });
    decoratedCall = retryCall as typeof callWithProviderSelection;
  }

  // Tool-less path: call once and return
  if (!tools || tools.length === 0 || !toolExecutor) {
    return decoratedCall();
  }

  // Tool loop path
  return executeToolLoop({
    prompt,
    maxTokens,
    messages,
    tools,
    toolChoice,
    toolExecutor,
    maxToolIterations,
    responseModel,
    jsonMode,
    temperature,
    stopSeqs,
    verbosity,
    enableRetry,
    retryAttempts,
    maxInputTokens: params.maxInputTokens ?? null,
    getAttemptPlan,
    attemptRef,
    beforeRetryCallback,
    streamFinal: streamFinalOnly,
    iterationCallback,
  });
}
