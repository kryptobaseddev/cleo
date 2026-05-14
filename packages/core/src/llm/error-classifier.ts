import type { ClassifiedError, FailoverReason } from '@cleocode/contracts';

/**
 * Classify an LLM API error into a structured {@link ClassifiedError}.
 *
 * Inspects the error object for:
 * - HTTP status code (`err.status`, `err.statusCode`, `err.response?.status`,
 *   `err.cause?.status`)
 * - error type strings (`'rate_limit_error'`, `'overloaded_error'`, etc.)
 * - message regex matches (`context_length_exceeded`, `too large`, etc.)
 *
 * Returns a {@link ClassifiedError} with deterministic retry/rotate/fallback
 * flags that consumers use instead of re-inspecting the raw error.
 *
 * Provider-specific deep classification (Anthropic thinking-block signature
 * parsing, long-context tier gating) is intentionally omitted here — those
 * values exist in the taxonomy as hooks for future extension.
 *
 * @param err   - The unknown error value caught from an LLM API call.
 * @param context - Optional provider and model identifiers for enrichment.
 * @returns A fully-populated {@link ClassifiedError}.
 *
 * @task T9270
 */
export function classifyError(
  err: unknown,
  context?: { provider?: string; model?: string },
): ClassifiedError {
  const message = extractMessage(err);
  const statusCode = extractStatusCode(err);
  const provider = context?.provider ?? null;
  const model = context?.model ?? null;

  const base: Omit<ClassifiedError, 'reason'> = {
    statusCode,
    provider,
    model,
    message,
    retryable: false,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
  };

  // Check AbortError / timeout signals first (no status code needed)
  if (isAbortOrTimeout(err, message)) {
    return { ...base, reason: 'timeout', retryable: true };
  }

  if (statusCode !== null) {
    return { ...base, ...classifyByStatus(statusCode, message) };
  }

  // No status code — fall through to unknown
  return { ...base, reason: 'unknown', retryable: false };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Safely extract the HTTP status code from an unknown error value.
 *
 * Checks `err.status`, `err.statusCode`, `err.response?.status`, and
 * `err.cause?.status` in that order. Returns `null` if none are found.
 */
function extractStatusCode(err: unknown): number | null {
  if (!isRecord(err)) return null;

  const direct = coerceInt(err['status'] ?? err['statusCode']);
  if (direct !== null) return direct;

  const fromResponse = isRecord(err['response']) ? coerceInt(err['response']['status']) : null;
  if (fromResponse !== null) return fromResponse;

  const fromCause = isRecord(err['cause']) ? coerceInt(err['cause']['status']) : null;
  return fromCause;
}

/**
 * Safely extract the error message string from an unknown error value.
 *
 * Checks `err.message` on Error instances and plain objects alike, falling
 * back to `String(err)` for primitives.
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err) && typeof err['message'] === 'string') return err['message'];
  return String(err);
}

/**
 * Narrow-cast `value` to `Record<string, unknown>` without using `any`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Coerce a value to an integer status code, returning `null` on failure.
 */
function coerceInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * Returns `true` if the error represents an AbortError or a timeout signal
 * (detected via `err.name === 'AbortError'` or message patterns).
 */
function isAbortOrTimeout(err: unknown, message: string): boolean {
  if (isRecord(err) && err['name'] === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return /timeout|ECONNRESET|ETIMEDOUT/i.test(message);
}

/**
 * Map an HTTP status code (and message for disambiguation) to a
 * `FailoverReason` plus the associated recovery flags.
 */
function classifyByStatus(
  status: number,
  message: string,
): Pick<
  ClassifiedError,
  'reason' | 'retryable' | 'shouldCompress' | 'shouldRotateCredential' | 'shouldFallback'
> {
  switch (status) {
    case 401:
    case 403:
      return {
        reason: 'auth',
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: false,
      };

    case 402:
      return {
        reason: 'billing',
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: false,
      };

    case 429:
      return {
        reason: 'rate_limit',
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: false,
      };

    case 503:
    case 529:
      return {
        reason: 'overloaded',
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
      };

    case 500:
    case 502:
    case 504:
      return {
        reason: 'server_error',
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
      };

    case 413:
      return {
        reason: 'payload_too_large',
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: false,
      };

    case 404:
      return {
        reason: 'model_not_found',
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
      };

    case 400:
      return classify400(message);

    default:
      return {
        reason: 'unknown',
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
      };
  }
}

/**
 * Disambiguate HTTP 400 errors into `context_overflow` vs `format_error`
 * based on message content.
 */
function classify400(
  message: string,
): Pick<
  ClassifiedError,
  'reason' | 'retryable' | 'shouldCompress' | 'shouldRotateCredential' | 'shouldFallback'
> {
  const isContextOverflow =
    /context length|context_length_exceeded|too long|prompt is too long/i.test(message);

  if (isContextOverflow) {
    return {
      reason: 'context_overflow' satisfies FailoverReason,
      retryable: true,
      shouldCompress: true,
      shouldRotateCredential: false,
      shouldFallback: false,
    };
  }

  return {
    reason: 'format_error' satisfies FailoverReason,
    retryable: false,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
  };
}
