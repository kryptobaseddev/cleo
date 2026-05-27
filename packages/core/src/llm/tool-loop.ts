/**
 * Agentic/tool orchestration — thin wrapper around {@link ConcreteExecutor}.
 *
 * Previously contained a full iterative tool-call loop against the removed
 * ProviderBackend layer. Now delegates entirely to
 * {@link ConcreteExecutor.run}, which already implements sequential tool-call
 * orchestration, multi-turn replay, and iteration limits.
 *
 * The public `executeToolLoop` signature is preserved for backwards
 * compatibility with `api.ts`. All fields not consumed by the new executor
 * path are accepted but ignored (marked with inline comments).
 *
 * Key invariants preserved:
 * - Tool calls are sequential, never parallel (enforced by ConcreteExecutor)
 * - `maxToolIterations` upper bound is forwarded as `maxIterations`
 * - `toolExecutor` callback is wrapped into the `toolHandler` shape
 * - `streamFinal` path is unsupported in the new executor (stream=false for
 *   tool loops per the api.ts guard); always returns a full LLMCallResponse
 *
 * @task T9299 (W5b — migrate tool-loop to ConcreteExecutor event stream)
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { LlmSession, ToolCall } from '@cleocode/contracts/llm/interfaces.js';
import type {
  NormalizedResponse,
  TransportMessage,
  TransportTool,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import { ConcreteExecutor } from './concrete-executor.js';
import { ConcreteSession } from './concrete-session.js';
import { truncateMessagesToFit } from './conversation.js';
import type { AttemptPlan, AttemptRef } from './runtime.js';
import { AnthropicTransport } from './transports/anthropic.js';
import { ChatCompletionsTransport } from './transports/chat-completions.js';
import { GeminiTransport } from './transports/gemini.js';
import type {
  IterationCallback,
  LLMCallResponse,
  StreamingResponseWithMetadata,
  VerbosityType,
} from './types.js';
import type { ModelConfig, ModelTransport } from './types-config.js';

export const MIN_TOOL_ITERATIONS = 1;
export const MAX_TOOL_ITERATIONS = 100;

type ToolExecutorFn = (name: string, input: Record<string, unknown>) => Promise<unknown>;

/** @internal */
export interface ToolLoopParams {
  prompt: string;
  maxTokens: number;
  messages: Array<Record<string, unknown>> | null;
  tools: Array<Record<string, unknown>>;
  toolChoice: string | Record<string, unknown> | null | undefined;
  toolExecutor: ToolExecutorFn;
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
  /** ModelConfig forwarded from api.ts for session construction. */
  modelConfig: ModelConfig;
}

// ---------------------------------------------------------------------------
// Session factory (mirrored from api.ts — kept local to avoid circular dep)
// ---------------------------------------------------------------------------

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

function _transportForProvider(
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

function _sessionFromConfig(config: ModelConfig, model: string): LlmSession {
  const cred = _resolvedCredentialFromConfig(config);
  const transport = _transportForProvider(config.transport, cred);
  return new ConcreteSession({ transport, model, credential: cred });
}

// ---------------------------------------------------------------------------
// LLMCallResponse builder from NormalizedResponse
// ---------------------------------------------------------------------------

function _toCallResponse(
  resp: NormalizedResponse,
  allToolCalls: Array<Record<string, unknown>>,
  iterations: number,
  totalInput: number,
  totalOutput: number,
  totalCached: number,
): LLMCallResponse<unknown> {
  return {
    content: resp.content,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: totalCached,
    finishReasons: resp.stopReason ? [resp.stopReason] : [],
    toolCallsMade: allToolCalls,
    iterations,
    thinkingContent: null,
    thinkingBlocks: [],
    reasoningDetails: [],
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run the iterative tool calling loop for agentic LLM interactions.
 *
 * Delegates to {@link ConcreteExecutor.run} which already owns sequential
 * tool-call orchestration. The legacy `params` shape is accepted verbatim;
 * fields that ConcreteExecutor does not need are silently ignored.
 */
export async function executeToolLoop(
  params: ToolLoopParams,
): Promise<LLMCallResponse<unknown> | StreamingResponseWithMetadata> {
  const {
    prompt,
    maxToolIterations,
    messages,
    tools,
    toolExecutor,
    maxInputTokens,
    getAttemptPlan,
    iterationCallback,
    modelConfig,
  } = params;

  if (maxToolIterations < MIN_TOOL_ITERATIONS || maxToolIterations > MAX_TOOL_ITERATIONS) {
    throw new Error(
      `maxToolIterations must be in [${MIN_TOOL_ITERATIONS}, ${MAX_TOOL_ITERATIONS}]; got ${maxToolIterations}`,
    );
  }

  const plan = getAttemptPlan();
  const effectiveConfig: ModelConfig = plan.selectedConfig ?? {
    ...modelConfig,
    transport: plan.provider,
    model: plan.model,
  };
  const session = _sessionFromConfig(effectiveConfig, plan.model);

  // Build initial messages, extracting any system-role entries separately
  let initialMessages: Array<Record<string, unknown>> = messages
    ? [...messages]
    : [{ role: 'user', content: prompt }];

  if (maxInputTokens !== null && maxInputTokens !== undefined) {
    initialMessages = truncateMessagesToFit(initialMessages, maxInputTokens);
  }

  const systemParts: string[] = [];
  const transportMessages: TransportMessage[] = [];
  for (const m of initialMessages) {
    const role = String(m['role'] ?? 'user');
    const content = typeof m['content'] === 'string' ? m['content'] : JSON.stringify(m['content']);
    if (role === 'system') {
      systemParts.push(content);
    } else {
      transportMessages.push({ role: role as 'user' | 'assistant' | 'tool', content });
    }
  }
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n') : undefined;

  // Convert tool definitions to TransportTool array
  const transportTools: TransportTool[] = tools.map((t) => ({
    name: String(t['name'] ?? ''),
    description: (t['description'] as string | undefined) ?? '',
    inputSchema: (t['input_schema'] ?? t['parameters'] ?? {}) as Record<string, unknown>,
  }));

  const allToolCalls: Array<Record<string, unknown>> = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let iterations = 0;
  let lastResponse: NormalizedResponse | undefined;

  const executor = new ConcreteExecutor({ session });

  const toolHandler = async (call: ToolCall): Promise<string | Record<string, unknown>> => {
    const result = await toolExecutor(call.name, call.args);
    allToolCalls.push({
      tool_name: call.name,
      tool_input: call.args,
      tool_result: result,
    });
    return typeof result === 'string' ? result : JSON.stringify(result);
  };

  let iterationCount = 0;

  for await (const event of executor.run({
    messages: transportMessages,
    tools: transportTools,
    toolHandler,
    maxIterations: maxToolIterations,
    sendOptions: systemPrompt ? { systemSuffix: systemPrompt } : undefined,
  })) {
    if (event.kind === 'response') {
      lastResponse = event.response;
      totalInput += event.response.usage.inputTokens;
      totalOutput += event.response.usage.outputTokens;
      totalCached += event.response.usage.cachedTokens ?? 0;
    } else if (event.kind === 'tool_call') {
      iterationCount = event.iteration + 1;
    } else if (event.kind === 'tool_result' && iterationCallback) {
      try {
        iterationCallback({
          iteration: iterationCount,
          toolCalls: [event.toolName],
          inputTokens: lastResponse?.usage.inputTokens ?? 0,
          outputTokens: lastResponse?.usage.outputTokens ?? 0,
          cacheReadTokens: lastResponse?.usage.cachedTokens ?? 0,
          cacheCreationTokens: 0,
        });
      } catch {
        /* iteration_callback failures are non-fatal */
      }
    } else if (event.kind === 'done') {
      iterations = event.usage.iterations;
      totalInput = event.usage.totalInputTokens;
      totalOutput = event.usage.totalOutputTokens;
      totalCached = event.usage.totalCachedTokens;
      lastResponse = event.finalResponse;
    } else if (event.kind === 'error') {
      throw new Error(event.error.message);
    }
  }

  if (!lastResponse) {
    return {
      content: null,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: totalCached,
      finishReasons: [],
      toolCallsMade: allToolCalls,
      iterations: Math.max(iterations, 1),
      thinkingContent: null,
      thinkingBlocks: [],
      reasoningDetails: [],
    };
  }

  return _toCallResponse(
    lastResponse,
    allToolCalls,
    Math.max(iterations, 1),
    totalInput,
    totalOutput,
    totalCached,
  );
}
