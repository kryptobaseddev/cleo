/**
 * Concrete agent-loop LLM executor implementation.
 *
 * Implements {@link LlmExecutor}: tool-call orchestration, multi-turn replay,
 * optional context-compression via {@link ContextEngine}, usage aggregation,
 * and discriminated-union {@link ExecutionEvent} emission.
 *
 * @module llm/concrete-executor
 * @task T9290
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §Decision §"LlmExecutor — agent-loop level"
 */

import type {
  AggregatedUsage,
  ContextEngine,
  ExecutionEvent,
  ExecutionRequest,
  LlmExecutor,
  LlmSession,
  SendOptions,
  ToolCall,
} from '@cleocode/contracts/llm/interfaces.js';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import { computeCost } from './usage-pricing.js';

// ---------------------------------------------------------------------------
// ConcreteExecutor
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link ConcreteExecutor}.
 */
export interface ConcreteExecutorOptions {
  /** Pre-initialized session to use for all LLM calls. */
  readonly session: LlmSession;
  /**
   * Optional context-compression engine.
   *
   * When undefined, compression checks are silently skipped — no events are
   * emitted and no errors are thrown.
   */
  readonly contextEngine?: ContextEngine;
}

/**
 * Concrete implementation of {@link LlmExecutor}.
 *
 * Each {@link run} call drives a multi-turn tool-call loop using the bound
 * session. The session history is owned by the caller — this executor appends
 * messages to it as the loop progresses.
 *
 * @example
 * ```ts
 * const executor = new ConcreteExecutor({ session });
 * for await (const event of executor.run({ messages: [{ role: 'user', content: 'Hi' }] })) {
 *   if (event.kind === 'done') console.log(event.usage);
 * }
 * ```
 */
export class ConcreteExecutor implements LlmExecutor {
  /** The underlying session used for all LLM calls. */
  readonly session: LlmSession;

  private readonly _contextEngine: ContextEngine | undefined;

  /**
   * @param opts - Executor construction options.
   */
  constructor(opts: ConcreteExecutorOptions) {
    this.session = opts.session;
    this._contextEngine = opts.contextEngine;
  }

  /**
   * Execute the full agent tool-call loop for the given request.
   *
   * Yields {@link ExecutionEvent} values as they occur. The generator
   * terminates when:
   * - The model returns a stop reason other than `'tool_use'` / `'tool_calls'`.
   * - The `maxIterations` limit is reached.
   * - An unrecoverable error occurs (emits `error` event then returns).
   *
   * @param request - Execution parameters including messages, tools, and handler.
   */
  async *run(request: ExecutionRequest): AsyncGenerator<ExecutionEvent> {
    const maxIterations = request.maxIterations ?? 10;
    const sendOpts: SendOptions | undefined = request.sendOptions;

    // Seed history with the initial messages.
    const initialMessages = [...request.messages];
    for (const msg of initialMessages) {
      this.session.append(msg);
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let iterations = 0;
    let lastResponse: NormalizedResponse | undefined;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      iterations = iteration + 1;

      // Context compression check (skip silently when engine absent).
      if (this._contextEngine !== undefined) {
        const history = this.session.history();
        if (this._contextEngine.shouldCompress(history)) {
          const tokensBefore = this._contextEngine.estimateTokens(history);
          try {
            const compressed = await this._contextEngine.compress(history);
            const tokensAfter = this._contextEngine.estimateTokens(compressed);
            // Replace session history with compressed version.
            this.session.truncateHistory(0, 0);
            for (const msg of compressed) {
              this.session.append(msg);
            }
            yield {
              kind: 'context_compressed',
              tokensBefore,
              tokensAfter,
            } satisfies ExecutionEvent;
          } catch (err: unknown) {
            const classified = _toClassifiedError(err, iteration);
            yield { kind: 'error', error: classified, iteration } satisfies ExecutionEvent;
            return;
          }
        }
      }

      // Issue the completion call using current history.
      let response: NormalizedResponse;
      try {
        response = await this.session.send([...this.session.history()], sendOpts);
      } catch (err: unknown) {
        const classified = _toClassifiedError(err, iteration);
        yield { kind: 'error', error: classified, iteration } satisfies ExecutionEvent;
        return;
      }

      lastResponse = response;

      // Accumulate usage.
      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
      totalCachedTokens += response.usage.cachedTokens ?? 0;

      // Emit response event.
      yield { kind: 'response', response } satisfies ExecutionEvent;

      // No tool calls → model is done.
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // Append the assistant turn to history.
      const assistantMsg: TransportMessage = {
        role: 'assistant',
        content: response.content ?? '',
      };
      this.session.append(assistantMsg);

      // Process tool calls sequentially.
      for (const rawCall of response.toolCalls) {
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(rawCall.arguments) as Record<string, unknown>;
        } catch {
          parsedArgs = {};
        }

        const toolCall: ToolCall = {
          id: rawCall.id,
          name: rawCall.name,
          args: parsedArgs,
          rawArguments: rawCall.arguments,
        };

        yield { kind: 'tool_call', toolCall, iteration } satisfies ExecutionEvent;

        // Invoke the handler if provided.
        let resultStr: string;
        if (request.toolHandler !== undefined) {
          try {
            const rawResult = await request.toolHandler(toolCall);
            resultStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
          } catch (err: unknown) {
            const classified = _toClassifiedError(err, iteration);
            yield { kind: 'error', error: classified, iteration } satisfies ExecutionEvent;
            return;
          }
        } else {
          resultStr = '';
        }

        // Append tool result to history.
        const toolResultMsg: TransportMessage = {
          role: 'tool',
          content: resultStr,
          toolUseId: rawCall.id ?? undefined,
        };
        this.session.append(toolResultMsg);

        yield {
          kind: 'tool_result',
          toolCallId: rawCall.id,
          toolName: rawCall.name,
          result: resultStr,
          iteration,
        } satisfies ExecutionEvent;
      }
    }

    // Compute aggregated usage with cost.
    const costUsd =
      lastResponse !== undefined
        ? (() => {
            const c = computeCost(
              {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                cacheReadTokens: totalCachedTokens,
              },
              lastResponse.model,
            );
            return c === 0 ? null : c;
          })()
        : null;

    const aggregatedUsage: AggregatedUsage = {
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      iterations,
      costUsd,
    };

    yield {
      kind: 'done',
      usage: aggregatedUsage,
      finalResponse: lastResponse ?? _emptyResponse(),
    } satisfies ExecutionEvent;
  }

  /**
   * Execute a single-turn completion without entering the tool-call loop.
   *
   * Intended for auxiliary calls (context compression summaries, dream cycles,
   * hygiene scans). Uses the same underlying session but does NOT append messages
   * to the session history.
   *
   * @param messages - Messages to send.
   * @param opts - Optional per-call overrides.
   * @returns The normalized provider response.
   */
  async auxiliary(messages: TransportMessage[], opts?: SendOptions): Promise<NormalizedResponse> {
    return this.session.send(messages, opts);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an unknown thrown value into a minimal {@link ClassifiedError}-compatible
 * object so the executor can emit an `error` event without importing the full
 * error-classifier (which belongs in W4a).
 */
function _toClassifiedError(err: unknown, _iteration: number) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    reason: 'unknown' as const,
    statusCode: null,
    provider: null,
    model: null,
    message,
    retryable: false,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
  };
}

/** Produce a minimal NormalizedResponse for the done event when no turns completed. */
function _emptyResponse(): NormalizedResponse {
  return {
    id: 'empty',
    model: 'unknown',
    content: null,
    toolCalls: null,
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: null,
  };
}
