/**
 * Gemini LLM transport — stub (not yet wired).
 *
 * Implements the {@link LlmTransport} interface with the same constructor
 * signature as {@link AnthropicTransport} so the role-resolver can swap
 * providers without changing call sites. `complete()` throws
 * `E_NOT_IMPLEMENTED` until T-llm-p3-X (future task) wires the real
 * Gemini implementation.
 *
 * W0c adds stub `stream()` + `apiMode` for compile parity with the extended
 * `LlmTransport` interface. Wave 1a migration (T-llm-p4-1a) replaces the stub
 * with a real implementation that absorbs `backends/gemini.ts` logic. `apiMode`
 * is `'chat_completions'` because Gemini currently routes through the
 * OpenAI-compatible shim; a native Gemini ApiMode is deferred to Phase 5.
 *
 * @module llm/transports/gemini
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
 * Options accepted by {@link GeminiTransport}.
 *
 * Kept structurally identical to `AnthropicTransportOptions` so the
 * role-resolver can swap providers by swapping the constructor reference only.
 */
export interface GeminiTransportOptions {
  /** API key or bearer token. */
  apiKey: string;
  /** Override base URL (e.g. Vertex AI endpoint). */
  baseUrl?: string;
  /** Extra headers merged into every SDK request. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// E_NOT_IMPLEMENTED error
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link GeminiTransport.complete} until the real implementation
 * is wired.
 *
 * Carries `code: 'E_NOT_IMPLEMENTED'` so callers can pattern-match without
 * relying on the error message string.
 */
export class GeminiNotImplementedError extends Error {
  /** Stable LAFS error code. */
  readonly code = 'E_NOT_IMPLEMENTED' as const;

  /** @param message - Human-readable description. */
  constructor(message: string) {
    super(message);
    this.name = 'GeminiNotImplementedError';
  }
}

// ---------------------------------------------------------------------------
// GeminiTransport
// ---------------------------------------------------------------------------

/**
 * Stub Gemini transport.
 *
 * Satisfies the {@link LlmTransport} interface but always throws
 * {@link GeminiNotImplementedError} from `complete()`. Replace with the real
 * implementation when T-llm-p4-1a (Wave 1a migration) lands.
 *
 * W0c adds stub `stream()` + `apiMode` for compile parity. Wave 1a replaces
 * them with a real implementation that absorbs `backends/gemini.ts` logic,
 * including Gemini caching via `geminiCacheStore`, schema sanitization
 * (`GEMINI_ALLOWED_SCHEMA_KEYS`), and `GEMINI_BLOCKED_FINISH_REASONS` safety
 * handling. `apiMode` is `'chat_completions'` because Gemini currently routes
 * through the OpenAI-compatible shim; native Gemini ApiMode is Phase 5.
 *
 * @example
 * ```ts
 * const transport = new GeminiTransport({ apiKey: 'AIza...' });
 * // Will throw GeminiNotImplementedError until the real impl ships.
 * await transport.complete({ model: 'gemini-pro', messages: [], maxTokens: 1024 });
 * ```
 */
export class GeminiTransport implements LlmTransport {
  /** Provider identifier — always `'gemini'`. */
  readonly provider = 'gemini' as const;

  /**
   * Wire protocol spoken by this transport — `'chat_completions'`.
   *
   * Gemini currently routes through the OpenAI-compatible shim. A native
   * `'gemini_native'` ApiMode is deferred to Phase 5 per ADR-072.
   *
   * @see ADR-072 §Type lock-in
   */
  readonly apiMode: ApiMode = 'chat_completions' as const;

  /** @param _options - Accepted for constructor parity with AnthropicTransport. */
  constructor(_options: GeminiTransportOptions) {
    // Intentionally empty — real impl initialises the SDK client here.
  }

  /**
   * Not yet implemented — always throws {@link GeminiNotImplementedError}.
   *
   * @param _request - Ignored.
   * @param _ctx - Ignored.
   * @throws {GeminiNotImplementedError} Always, until the real implementation lands.
   */
  complete(_request: TransportRequest, _ctx?: TransportContext): Promise<NormalizedResponse> {
    return Promise.reject(
      new GeminiNotImplementedError(
        'Gemini transport not yet wired — use Anthropic until T-llm-p4-1a (Wave 1a migration) lands',
      ),
    );
  }

  /**
   * Stream a completion against the Gemini API.
   *
   * STUB: W1 migration will implement stream() for gemini.
   *
   * Wave 1a (T-llm-p4-1a) replaces this stub with a real implementation
   * that absorbs `backends/gemini.ts` streaming logic, Gemini safety-reason
   * handling, and schema sanitization.
   *
   * @param _request - Ignored until Wave 1a implementation lands.
   * @param _ctx - Ignored until Wave 1a implementation lands.
   * @throws {Error} Always, until the real implementation lands in Wave 1a.
   */
  // biome-ignore lint/correctness/useYield: stub — Wave 1a replaces with real streaming impl
  async *stream(
    _request: TransportRequest,
    _ctx: TransportContext,
  ): AsyncIterable<NormalizedDelta> {
    // STUB: W1 migration will implement stream() for gemini
    throw new Error('STUB: W1 migration will implement stream() for gemini');
  }
}
