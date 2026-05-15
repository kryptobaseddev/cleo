/**
 * OpenAI LLM transport — stub (not yet wired).
 *
 * Implements the {@link LlmTransport} interface with the same constructor
 * signature as {@link AnthropicTransport} so the role-resolver can swap
 * providers without changing call sites. `complete()` throws
 * `E_NOT_IMPLEMENTED` until T-llm-p3-X (future task) wires the real
 * OpenAI implementation.
 *
 * W0c adds stub `stream()` + `apiMode` for compile parity with the extended
 * `LlmTransport` interface. Wave 1b migration (T-llm-p4-1b) replaces the stub
 * with a real implementation backed by the OpenAI SDK streaming API.
 *
 * @module llm/transports/openai
 * @task T9263
 * @task T9282 (W0c — stub stream() + apiMode)
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import type { NormalizedDelta, TransportContext } from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ApiMode } from '@cleocode/contracts/llm/provider-id.js';

// ---------------------------------------------------------------------------
// Constructor options (parallel to AnthropicTransportOptions)
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link OpenAITransport}.
 *
 * Kept structurally identical to `AnthropicTransportOptions` so the
 * role-resolver can swap providers by swapping the constructor reference only.
 */
export interface OpenAITransportOptions {
  /** API key or bearer token. */
  apiKey: string;
  /** Override base URL (e.g. Azure OpenAI endpoint). */
  baseUrl?: string;
  /** Extra headers merged into every SDK request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// E_NOT_IMPLEMENTED error
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link OpenAITransport.complete} until the real implementation
 * is wired.
 *
 * Carries `code: 'E_NOT_IMPLEMENTED'` so callers can pattern-match without
 * relying on the error message string.
 */
export class OpenAINotImplementedError extends Error {
  /** Stable LAFS error code. */
  readonly code = 'E_NOT_IMPLEMENTED' as const;

  /** @param message - Human-readable description. */
  constructor(message: string) {
    super(message);
    this.name = 'OpenAINotImplementedError';
  }
}

// ---------------------------------------------------------------------------
// OpenAITransport
// ---------------------------------------------------------------------------

/**
 * Stub OpenAI transport.
 *
 * Satisfies the {@link LlmTransport} interface but always throws
 * {@link OpenAINotImplementedError} from `complete()`. Replace with the real
 * implementation when T-llm-p4-1b (Wave 1b migration) lands.
 *
 * W0c adds stub `stream()` + `apiMode` for compile parity. Wave 1b replaces
 * them with a real implementation backed by the OpenAI SDK streaming API,
 * including `usesMaxCompletionTokens` o-series branching and reasoning content
 * extraction via `extractReasoningContent`.
 *
 * @example
 * ```ts
 * const transport = new OpenAITransport({ apiKey: 'sk-...' });
 * // Will throw OpenAINotImplementedError until the real impl ships.
 * await transport.complete({ model: 'gpt-4o', messages: [], maxTokens: 1024 });
 * ```
 */
export class OpenAITransport implements LlmTransport {
  /** Provider identifier — always `'openai'`. */
  readonly provider = 'openai' as const;

  /**
   * Wire protocol spoken by this transport — always `'chat_completions'`.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'chat_completions' as const;

  /**
   * Not yet implemented — always throws {@link OpenAINotImplementedError}.
   *
   * @param _request - Ignored.
   * @param _ctx - Ignored.
   * @throws {OpenAINotImplementedError} Always, until the real implementation lands.
   */
  complete(_request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    return Promise.reject(
      new OpenAINotImplementedError(
        'OpenAI transport not yet wired — use Anthropic until T-llm-p4-1b (Wave 1b migration) lands',
      ),
    );
  }

  /**
   * Stream a completion against the OpenAI chat completions API.
   *
   * STUB: W1 migration will implement stream() for openai.
   *
   * Wave 1b (T-llm-p4-1b) replaces this stub with a real implementation
   * backed by the OpenAI SDK streaming API, including `usesMaxCompletionTokens`
   * o-series branching and `extractReasoningContent` try/catch handling.
   *
   * @param _request - Ignored until Wave 1b implementation lands.
   * @param _ctx - Ignored until Wave 1b implementation lands.
   * @throws {Error} Always, until the real implementation lands in Wave 1b.
   */
  // biome-ignore lint/correctness/useYield: stub — Wave 1b replaces with real streaming impl
  async *stream(
    _request: TransportRequest,
    _ctx: TransportContext,
  ): AsyncIterable<NormalizedDelta> {
    // STUB: W1 migration will implement stream() for openai
    throw new Error('STUB: W1 migration will implement stream() for openai');
  }
}
