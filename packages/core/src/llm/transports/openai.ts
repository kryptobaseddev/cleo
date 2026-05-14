/**
 * OpenAI LLM transport — stub (not yet wired).
 *
 * Implements the {@link LlmTransport} interface with the same constructor
 * signature as {@link AnthropicTransport} so the role-resolver can swap
 * providers without changing call sites. `complete()` throws
 * `E_NOT_IMPLEMENTED` until T-llm-p3-X (future task) wires the real
 * OpenAI implementation.
 *
 * @module llm/transports/openai
 * @task T9263
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import type {
  LlmTransport,
  NormalizedResponse,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';

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
 * implementation when T-llm-p3-X (future task) lands.
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

  /** @param _options - Accepted for constructor parity with AnthropicTransport. */
  constructor(_options: OpenAITransportOptions) {
    // Intentionally empty — real impl initialises the SDK client here.
  }

  /**
   * Not yet implemented — always throws {@link OpenAINotImplementedError}.
   *
   * @param _request - Ignored.
   * @throws {OpenAINotImplementedError} Always, until the real implementation lands.
   */
  complete(_request: TransportRequest): Promise<NormalizedResponse> {
    return Promise.reject(
      new OpenAINotImplementedError(
        'OpenAI transport not yet wired — use Anthropic until T-llm-p3-X (future task) lands',
      ),
    );
  }
}
