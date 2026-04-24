/**
 * Agentic/tool orchestration — the multi-iteration tool execution loop.
 *
 * Ported from Honcho src/llm/tool_loop.py (491 LOC). Uses p-retry for
 * exponential backoff. Tool calls are SEQUENTIAL (not parallel) per spec.
 *
 * Key invariants:
 * - Tool calls are sequential, never parallel
 * - Empty-response retry max 1
 * - tool_choice 'required'/'any' → 'auto' after iter 0
 * - MAX_TOOL_ITERATIONS = 100, MIN_TOOL_ITERATIONS = 1
 *
 * @task T1397 (T1386-W11)
 * @epic T1386
 */

import pRetry from 'p-retry';
import type { CompletionResult } from './backend.js';
import { truncateMessagesToFit } from './conversation.js';
import { cleoLlmCallInner } from './executor.js';
import { historyAdapterForProvider } from './registry.js';
import type { AttemptPlan, AttemptRef } from './runtime.js';
import { effectiveTemperature } from './runtime.js';
import type {
  IterationCallback,
  IterationData,
  LLMCallResponse,
  LLMStreamChunk,
  StreamingResponseWithMetadata,
  VerbosityType,
} from './types.js';
import type { ModelTransport } from './types-config.js';

export const MIN_TOOL_ITERATIONS = 1;
export const MAX_TOOL_ITERATIONS = 100;

type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<unknown>;

interface ToolLoopParams {
  prompt: string;
  maxTokens: number;
  messages: Array<Record<string, unknown>> | null;
  tools: Array<Record<string, unknown>>;
  toolChoice: string | Record<string, unknown> | null | undefined;
  toolExecutor: ToolExecutor;
  maxToolIterations: number;
  responseModel: (new (...args: unknown[]) => unknown) | null | undefined;
  jsonMode: boolean;
  temperature: number | null | undefined;
  stopSeqs: string[] | null | undefined;
  verbosity: VerbosityType;
  enableRetry: boolean;
  retryAttempts: number;
  maxInputTokens: number | null | undefined;
  getAttemptPlan: () => AttemptPlan;
  attemptRef: AttemptRef;
  beforeRetryCallback: (err: Error, attemptNumber: number) => void;
  streamFinal?: boolean;
  iterationCallback?: IterationCallback | null;
}

function formatAssistantToolMessage(
  provider: ModelTransport,
  content: unknown,
  toolCalls: Array<Record<string, unknown>>,
  thinkingBlocks?: Array<Record<string, unknown>> | null,
  reasoningDetails?: Array<Record<string, unknown>> | null,
): Record<string, unknown> {
  const adapter = historyAdapterForProvider(provider);
  const result: CompletionResult = {
    content,
    toolCalls: toolCalls.map((tc) => ({
      id: String(tc['id'] ?? ''),
      name: String(tc['name'] ?? ''),
      input: (tc['input'] as Record<string, unknown>) ?? {},
      thoughtSignature: tc['thought_signature'] as string | null | undefined,
    })),
    thinkingBlocks: thinkingBlocks ?? [],
    reasoningDetails: reasoningDetails ?? [],
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    finishReason: 'stop',
    thinkingContent: null,
  };
  return adapter.formatAssistantToolMessage(result);
}

function appendToolResults(
  provider: ModelTransport,
  toolResults: Array<{
    toolId: string;
    toolName: string;
    result: unknown;
    isError?: boolean;
  }>,
  conversationMessages: Array<Record<string, unknown>>,
): void {
  const adapter = historyAdapterForProvider(provider);
  conversationMessages.push(...adapter.formatToolResults(toolResults));
}

async function streamFinalResponse(params: {
  winningPlan: AttemptPlan;
  prompt: string;
  maxTokens: number;
  conversationMessages: Array<Record<string, unknown>>;
  responseModel: (new (...args: unknown[]) => unknown) | null | undefined;
  jsonMode: boolean;
  temperature: number | null | undefined;
  stopSeqs: string[] | null | undefined;
  verbosity: VerbosityType;
  enableRetry: boolean;
  retryAttempts: number;
  attemptRef: AttemptRef;
  beforeRetryCallback: (err: Error, attemptNumber: number) => void;
}): Promise<AsyncGenerator<LLMStreamChunk>> {
  const {
    winningPlan,
    prompt,
    maxTokens,
    conversationMessages,
    responseModel,
    jsonMode,
    temperature,
    stopSeqs,
    verbosity,
    enableRetry,
    retryAttempts,
    attemptRef,
    beforeRetryCallback,
  } = params;

  const setupStream = async (): Promise<AsyncGenerator<LLMStreamChunk>> => {
    const r = await cleoLlmCallInner({
      provider: winningPlan.provider,
      model: winningPlan.model,
      prompt,
      maxTokens,
      responseModel: responseModel ?? null,
      jsonMode,
      temperature: effectiveTemperature(temperature, attemptRef.value),
      stopSeqs: stopSeqs ?? null,
      reasoningEffort: winningPlan.reasoningEffort,
      verbosity: verbosity ?? null,
      thinkingBudgetTokens: winningPlan.thinkingBudgetTokens,
      stream: true,
      clientOverride: winningPlan.client,
      tools: null,
      toolChoice: null,
      messages: conversationMessages,
      selectedConfig: winningPlan.selectedConfig,
    });
    return r;
  };

  if (enableRetry) {
    return pRetry(setupStream, {
      retries: retryAttempts - 1,
      minTimeout: 4000,
      maxTimeout: 10000,
      factor: 2,
      onFailedAttempt: (error) => {
        beforeRetryCallback(error as Error, error.attemptNumber);
      },
    });
  }
  return setupStream();
}

/**
 * Run the iterative tool calling loop for agentic LLM interactions.
 */
export async function executeToolLoop(
  params: ToolLoopParams,
): Promise<LLMCallResponse<unknown> | StreamingResponseWithMetadata> {
  const {
    prompt,
    maxTokens,
    messages,
    tools,
    toolExecutor,
    maxToolIterations,
    responseModel,
    jsonMode,
    temperature,
    stopSeqs,
    verbosity,
    enableRetry,
    retryAttempts,
    maxInputTokens,
    getAttemptPlan,
    attemptRef,
    beforeRetryCallback,
    streamFinal = false,
    iterationCallback,
  } = params;
  const { toolChoice } = params;

  if (maxToolIterations < MIN_TOOL_ITERATIONS || maxToolIterations > MAX_TOOL_ITERATIONS) {
    throw new Error(
      `maxToolIterations must be in [${MIN_TOOL_ITERATIONS}, ${MAX_TOOL_ITERATIONS}]; got ${maxToolIterations}`,
    );
  }

  const conversationMessages: Array<Record<string, unknown>> = messages
    ? [...messages]
    : [{ role: 'user', content: prompt }];

  let iteration = 0;
  const allToolCalls: Array<Record<string, unknown>> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let emptyResponseRetries = 0;
  let effectiveToolChoice = toolChoice;

  while (iteration < maxToolIterations) {
    // Reset attempt counter so each iteration starts with the primary provider
    attemptRef.value = 1;

    if (maxInputTokens !== null && maxInputTokens !== undefined) {
      const truncated = truncateMessagesToFit(conversationMessages, maxInputTokens);
      conversationMessages.length = 0;
      conversationMessages.push(...truncated);
    }

    const callWithMessages = async (): Promise<LLMCallResponse<unknown>> => {
      const plan = getAttemptPlan();
      const r = await cleoLlmCallInner({
        provider: plan.provider,
        model: plan.model,
        prompt,
        maxTokens,
        responseModel: responseModel ?? null,
        jsonMode,
        temperature: effectiveTemperature(temperature, attemptRef.value),
        stopSeqs: stopSeqs ?? null,
        reasoningEffort: plan.reasoningEffort,
        verbosity: verbosity ?? null,
        thinkingBudgetTokens: plan.thinkingBudgetTokens,
        stream: false,
        clientOverride: plan.client,
        tools: tools ?? null,
        toolChoice: effectiveToolChoice ?? null,
        messages: [...conversationMessages],
        selectedConfig: plan.selectedConfig,
      });
      return r as LLMCallResponse<unknown>;
    };

    let response: LLMCallResponse<unknown>;
    if (enableRetry) {
      response = await pRetry(callWithMessages, {
        retries: retryAttempts - 1,
        minTimeout: 4000,
        maxTimeout: 10000,
        factor: 2,
        onFailedAttempt: (error) => {
          beforeRetryCallback(error as Error, error.attemptNumber);
        },
      });
    } else {
      response = await callWithMessages();
    }

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    totalCacheCreationTokens += response.cacheCreationInputTokens;
    totalCacheReadTokens += response.cacheReadInputTokens;

    if (!response.toolCallsMade || response.toolCallsMade.length === 0) {
      // Empty response retry (max 1)
      if (
        typeof response.content === 'string' &&
        !response.content.trim() &&
        emptyResponseRetries < 1 &&
        iteration < maxToolIterations - 1
      ) {
        emptyResponseRetries++;
        conversationMessages.push({
          role: 'user',
          content:
            'Your last response was empty. Provide a concise answer to the original query using the available context.',
        });
        iteration++;
        continue;
      }

      if (streamFinal) {
        const winningPlan = getAttemptPlan();
        const stream = await streamFinalResponse({
          winningPlan,
          prompt,
          maxTokens,
          conversationMessages: [...conversationMessages],
          responseModel,
          jsonMode,
          temperature,
          stopSeqs,
          verbosity,
          enableRetry,
          retryAttempts,
          attemptRef,
          beforeRetryCallback,
        });

        // Import StreamingResponseWithMetadata dynamically to avoid circular deps
        const { StreamingResponseWithMetadata } = await import('./types.js');
        return new StreamingResponseWithMetadata({
          stream,
          toolCallsMade: allToolCalls,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheCreationInputTokens: totalCacheCreationTokens,
          cacheReadInputTokens: totalCacheReadTokens,
          thinkingContent: response.thinkingContent,
          iterations: iteration + 1,
        });
      }

      return {
        ...response,
        toolCallsMade: allToolCalls,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationInputTokens: totalCacheCreationTokens,
        cacheReadInputTokens: totalCacheReadTokens,
        iterations: iteration + 1,
      };
    }

    const currentProvider = getAttemptPlan().provider;

    const assistantMessage = formatAssistantToolMessage(
      currentProvider,
      response.content,
      response.toolCallsMade,
      response.thinkingBlocks,
      response.reasoningDetails,
    );
    conversationMessages.push(assistantMessage);

    // Execute tools SEQUENTIALLY (not parallel)
    const toolResults: Array<{
      toolId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }> = [];

    for (const toolCall of response.toolCallsMade) {
      const toolName = String(toolCall['name'] ?? '');
      const toolInput = (toolCall['input'] as Record<string, unknown>) ?? {};
      const toolId = String(toolCall['id'] ?? '');

      try {
        const toolResult = await toolExecutor(toolName, toolInput);
        toolResults.push({ toolId, toolName, result: toolResult });
        allToolCalls.push({
          tool_name: toolName,
          tool_input: toolInput,
          tool_result: toolResult,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toolResults.push({
          toolId,
          toolName,
          result: `Error: ${errMsg}`,
          isError: true,
        });
      }
    }

    appendToolResults(currentProvider, toolResults, conversationMessages);

    if (iterationCallback !== null && iterationCallback !== undefined) {
      try {
        const iterData: IterationData = {
          iteration: iteration + 1,
          toolCalls: response.toolCallsMade.map((tc) => String(tc['name'] ?? '')),
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cacheReadTokens: response.cacheReadInputTokens ?? 0,
          cacheCreationTokens: response.cacheCreationInputTokens ?? 0,
        };
        iterationCallback(iterData);
      } catch {
        // iteration_callback failures are non-fatal
      }
    }

    // After first iteration, switch 'required'/'any' → 'auto'
    if (iteration === 0 && (effectiveToolChoice === 'required' || effectiveToolChoice === 'any')) {
      effectiveToolChoice = 'auto';
    }

    iteration++;
  }

  // Max iterations reached — append synthesis prompt, final tool-less call
  const synthesisPrompt =
    'You have reached the maximum number of tool calls. ' +
    'Based on all the information you have gathered, provide your final response now. ' +
    'Do not attempt to call any more tools.';
  conversationMessages.push({ role: 'user', content: synthesisPrompt });

  if (maxInputTokens !== null && maxInputTokens !== undefined) {
    const truncated = truncateMessagesToFit(conversationMessages, maxInputTokens);
    conversationMessages.length = 0;
    conversationMessages.push(...truncated);
  }

  if (streamFinal) {
    const winningPlan = getAttemptPlan();
    const stream = await streamFinalResponse({
      winningPlan,
      prompt,
      maxTokens,
      conversationMessages: [...conversationMessages],
      responseModel,
      jsonMode,
      temperature,
      stopSeqs,
      verbosity,
      enableRetry,
      retryAttempts,
      attemptRef,
      beforeRetryCallback,
    });

    const { StreamingResponseWithMetadata } = await import('./types.js');
    return new StreamingResponseWithMetadata({
      stream,
      toolCallsMade: allToolCalls,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationInputTokens: totalCacheCreationTokens,
      cacheReadInputTokens: totalCacheReadTokens,
      thinkingContent: null,
      iterations: iteration + 1,
    });
  }

  // Final synthesis call without tools
  attemptRef.value = 1;

  const finalCall = async (): Promise<LLMCallResponse<unknown>> => {
    const plan = getAttemptPlan();
    const r = await cleoLlmCallInner({
      provider: plan.provider,
      model: plan.model,
      prompt,
      maxTokens,
      responseModel: responseModel ?? null,
      jsonMode,
      temperature: effectiveTemperature(temperature, attemptRef.value),
      stopSeqs: stopSeqs ?? null,
      reasoningEffort: plan.reasoningEffort,
      verbosity: verbosity ?? null,
      thinkingBudgetTokens: plan.thinkingBudgetTokens,
      stream: false,
      clientOverride: plan.client,
      tools: null,
      toolChoice: null,
      messages: [...conversationMessages],
      selectedConfig: plan.selectedConfig,
    });
    return r as LLMCallResponse<unknown>;
  };

  let finalResponse: LLMCallResponse<unknown>;
  if (enableRetry) {
    finalResponse = await pRetry(finalCall, {
      retries: retryAttempts - 1,
      minTimeout: 4000,
      maxTimeout: 10000,
      factor: 2,
      onFailedAttempt: (error) => {
        beforeRetryCallback(error as Error, error.attemptNumber);
      },
    });
  } else {
    finalResponse = await finalCall();
  }

  return {
    ...finalResponse,
    toolCallsMade: allToolCalls,
    iterations: iteration + 1,
    inputTokens: totalInputTokens + finalResponse.inputTokens,
    outputTokens: totalOutputTokens + finalResponse.outputTokens,
    cacheCreationInputTokens: totalCacheCreationTokens + finalResponse.cacheCreationInputTokens,
    cacheReadInputTokens: totalCacheReadTokens + finalResponse.cacheReadInputTokens,
  };
}
