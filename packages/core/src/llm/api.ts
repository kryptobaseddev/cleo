/**
 * Public LLM entrypoint: `cleoLlmCall`.
 *
 * Ported from PSYCHE src/llm/api.py (366 LOC). Orchestrates:
 * - Runtime config resolution from ModelConfig.
 * - Per-attempt planning (primary vs fallback selection).
 * - Retry with exponential backoff via p-retry.
 * - Tool-loop delegation when tools are supplied.
 * - Single-call delegation to the executor otherwise.
 *
 * Langfuse / Sentry decorators removed (no-op telemetry in CLEO).
 *
 * @task T1400 (T1386-W14)
 * @task T9298 (W5a — migrate to ConcreteExecutor event stream)
 * @epic T1386
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { LlmSession } from '@cleocode/contracts/llm/interfaces.js';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import pRetry from 'p-retry';
import { ConcreteExecutor } from './concrete-executor.js';
import { ConcreteSession } from './concrete-session.js';
import { effectiveTemperature, makeAttemptRef, planAttempt } from './runtime.js';
import { executeToolLoop } from './tool-loop.js';
import { AnthropicTransport } from './transports/anthropic.js';
import { ChatCompletionsTransport } from './transports/chat-completions.js';
import { GeminiTransport } from './transports/gemini.js';
import type {
  IterationCallback,
  LLMCallResponse,
  LLMStreamChunk,
  ReasoningEffortType,
  StreamingResponseWithMetadata,
  VerbosityType,
} from './types.js';
import type { ModelConfig, ModelTransport } from './types-config.js';

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

// ---------------------------------------------------------------------------
// Session factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a {@link ResolvedCredential} from the fields available on a
 * {@link ModelConfig} (api key, auth type, extra headers, base url).
 */
function _resolvedCredentialFromConfig(config: ModelConfig): ResolvedCredential {
  const extraHeaders: Record<string, string> = config.extraHeaders ?? {};
  return {
    provider: config.transport,
    label: 'modelconfig',
    token: config.apiKey ?? '',
    authType: 'api_key',
    expiresAt: null,
    refreshToken: null,
    extraHeaders,
    baseUrl: config.baseUrl ?? null,
    awsProfile: null,
  };
}

/**
 * Instantiate the correct {@link import('@cleocode/contracts/llm/normalized-response.js').LlmTransport}
 * for the given provider + credential.
 */
function _transportForConfig(
  provider: ModelTransport,
  cred: ResolvedCredential,
): import('@cleocode/contracts/llm/normalized-response.js').LlmTransport {
  if (provider === 'anthropic') {
    const opts =
      cred.authType === 'oauth'
        ? { authToken: cred.token, baseUrl: cred.baseUrl ?? undefined }
        : {
            apiKey: cred.token,
            baseUrl: cred.baseUrl ?? undefined,
            defaultHeaders: Object.keys(cred.extraHeaders).length ? cred.extraHeaders : undefined,
          };
    return new AnthropicTransport(opts);
  }

  if (provider === 'gemini') {
    return new GeminiTransport({
      apiKey: cred.token,
      baseUrl: cred.baseUrl ?? undefined,
    });
  }

  const defaultHeaders: Record<string, string> = { ...cred.extraHeaders };
  if (cred.authType === 'oauth') {
    defaultHeaders['Authorization'] = `Bearer ${cred.token}`;
  }
  return new ChatCompletionsTransport({
    apiKey: cred.token,
    baseUrl: cred.baseUrl ?? undefined,
    defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
    provider,
  });
}

/**
 * Build a one-shot {@link LlmSession} from a {@link ModelConfig}.
 *
 * Each call gets a fresh session so that history does not bleed across
 * retry attempts or independent callers.
 */
function _sessionFromConfig(config: ModelConfig, model: string): LlmSession {
  const cred = _resolvedCredentialFromConfig(config);
  const transport = _transportForConfig(config.transport, cred);
  return new ConcreteSession({ transport, model, credential: cred });
}

// ---------------------------------------------------------------------------
// Streaming via ConcreteSession.stream()
// ---------------------------------------------------------------------------

async function* _sessionStream(
  session: LlmSession,
  messages: TransportMessage[],
  system?: string,
): AsyncGenerator<LLMStreamChunk> {
  const opts = system ? { systemSuffix: system } : undefined;

  for await (const delta of session.stream(messages, opts)) {
    yield {
      content: delta.text,
      isDone: delta.stopReason !== null,
      finishReasons: delta.stopReason ? [delta.stopReason] : [],
      outputTokens: delta.usage?.outputTokens ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Single-turn executor run (no tool loop)
// ---------------------------------------------------------------------------

/**
 * Drive a single non-tool-loop completion via {@link ConcreteExecutor.run}.
 *
 * Collects the first `response` event and returns the aggregated result.
 * The optional `system` string is forwarded as a `systemSuffix` in
 * {@link SendOptions} since {@link TransportMessage} does not carry a
 * `system` role.
 */
async function _executorRun(
  session: LlmSession,
  messages: TransportMessage[],
  system?: string | null,
): Promise<LLMCallResponse<unknown>> {
  const executor = new ConcreteExecutor({ session });
  const sendOptions = system ? { systemSuffix: system } : undefined;

  let lastResponse: NormalizedResponse | undefined;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;

  for await (const event of executor.run({
    messages,
    maxIterations: 1,
    sendOptions,
  })) {
    if (event.kind === 'response') {
      lastResponse = event.response;
      totalInput += event.response.usage.inputTokens;
      totalOutput += event.response.usage.outputTokens;
      totalCached += event.response.usage.cachedTokens ?? 0;
    } else if (event.kind === 'error') {
      throw new Error(event.error.message);
    }
  }

  if (!lastResponse) {
    return {
      content: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      finishReasons: [],
      toolCallsMade: [],
      iterations: 1,
      thinkingContent: null,
      thinkingBlocks: [],
      reasoningDetails: [],
    };
  }

  return {
    content: lastResponse.content,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: totalCached,
    finishReasons: lastResponse.stopReason ? [lastResponse.stopReason] : [],
    toolCallsMade: [],
    iterations: 1,
    thinkingContent: null,
    thinkingBlocks: [],
    reasoningDetails: [],
  };
}

// ---------------------------------------------------------------------------
// Build TransportMessages from CleoLlmCallParams
// ---------------------------------------------------------------------------

/**
 * Build `TransportMessage[]` from the caller-supplied messages array.
 *
 * `system`-role entries are extracted into a separate `systemPrompt` string
 * because {@link TransportMessage.role} does not include `'system'` — that is
 * passed via {@link ConcreteSession._buildRequest} `system` field instead.
 *
 * Returns both the non-system messages and any extracted system content.
 */
function _buildMessages(params: {
  prompt: string;
  messages?: Array<Record<string, unknown>> | null;
}): { messages: TransportMessage[]; system: string | undefined } {
  if (params.messages && params.messages.length > 0) {
    const systemParts: string[] = [];
    const nonSystem: TransportMessage[] = [];

    for (const m of params.messages) {
      const role = String(m['role'] ?? 'user');
      const content =
        typeof m['content'] === 'string' ? m['content'] : JSON.stringify(m['content']);
      if (role === 'system') {
        systemParts.push(content);
      } else {
        nonSystem.push({
          role: role as 'user' | 'assistant' | 'tool',
          content,
        });
      }
    }

    return {
      messages: nonSystem,
      system: systemParts.length > 0 ? systemParts.join('\n') : undefined,
    };
  }
  return { messages: [{ role: 'user', content: params.prompt }], system: undefined };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
    temperature = null,
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
      callThinkingBudgetTokens: params.thinkingBudgetTokens ?? null,
      callReasoningEffort: params.reasoningEffort ?? null,
    });
  }

  async function callWithProviderSelection(): Promise<
    LLMCallResponse<unknown> | AsyncGenerator<LLMStreamChunk>
  > {
    const plan = getAttemptPlan();
    const effectiveConfig: ModelConfig = plan.selectedConfig ?? {
      ...modelConfig,
      transport: plan.provider,
      model: plan.model,
    };
    const session = _sessionFromConfig(effectiveConfig, plan.model);
    const { messages: transportMessages, system } = _buildMessages({ prompt, messages });

    if (stream) {
      return _sessionStream(session, transportMessages, system) as AsyncGenerator<LLMStreamChunk>;
    }

    void effectiveTemperature(temperature, attemptRef.value);
    return _executorRun(session, transportMessages, system);
  }

  function beforeRetryCallback(_err: Error, attemptNumber: number): void {
    attemptRef.value = attemptNumber + 1;
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
    responseModel: params.responseModel ?? null,
    jsonMode: params.jsonMode ?? false,
    temperature,
    stopSeqs: params.stopSeqs ?? null,
    verbosity: params.verbosity ?? null,
    enableRetry,
    retryAttempts,
    maxInputTokens: params.maxInputTokens ?? null,
    getAttemptPlan,
    attemptRef,
    beforeRetryCallback,
    streamFinal: streamFinalOnly,
    iterationCallback,
    modelConfig,
  });
}
