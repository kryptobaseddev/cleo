/**
 * Default timeout in milliseconds for outbound HTTP requests.
 *
 * @public
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

type NetworkErrorKind = "timeout" | "http" | "network";

/**
 * Structured error for network failures with categorized kind.
 *
 * @remarks
 * Carries the original URL, a classification of the failure (`"timeout"`,
 * `"http"`, or `"network"`), and an optional HTTP status code for `"http"`
 * failures.
 *
 * @public
 */
export class NetworkError extends Error {
  /** Classification of the failure. */
  kind: NetworkErrorKind;
  /** URL that was being fetched. */
  url: string;
  /** HTTP status code (only present for `"http"` kind). */
  status?: number;

  constructor(message: string, kind: NetworkErrorKind, url: string, status?: number) {
    super(message);
    this.name = "NetworkError";
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Fetch a URL with an automatic timeout via `AbortSignal.timeout`.
 *
 * @remarks
 * Wraps the native `fetch` API to provide consistent timeout and error
 * handling. Abort errors are translated into `NetworkError` with kind
 * `"timeout"`, and other failures become `"network"` errors.
 *
 * @param url - URL to fetch
 * @param init - Optional `RequestInit` options forwarded to `fetch`
 * @param timeoutMs - Timeout in milliseconds (defaults to {@link DEFAULT_FETCH_TIMEOUT_MS})
 * @returns The `Response` object from the fetch call
 * @throws {@link NetworkError} on timeout or network failure
 *
 * @example
 * ```typescript
 * const response = await fetchWithTimeout("https://api.example.com/data", undefined, 5000);
 * ```
 *
 * @public
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new NetworkError(`Request timed out after ${timeoutMs}ms`, "timeout", url);
    }
    throw new NetworkError("Network request failed", "network", url);
  }
}

/**
 * Assert that a `Response` has an OK status, throwing on failure.
 *
 * @remarks
 * Convenience guard that throws a `NetworkError` with kind `"http"` when the
 * response status is outside the 200-299 range.
 *
 * @param response - Fetch `Response` to validate
 * @param url - Original request URL (included in the error)
 * @returns The same `Response` if status is OK
 * @throws {@link NetworkError} when `response.ok` is `false`
 *
 * @example
 * ```typescript
 * const res = await fetchWithTimeout(url);
 * ensureOkResponse(res, url);
 * ```
 *
 * @public
 */
export function ensureOkResponse(response: Response, url: string): Response {
  if (!response.ok) {
    throw new NetworkError(`Request failed with status ${response.status}`, "http", url, response.status);
  }
  return response;
}

/**
 * Format a network error into a user-friendly message string.
 *
 * @remarks
 * Recognizes `NetworkError` instances and produces kind-specific messages
 * (timeout, HTTP status, generic network). Falls back to `Error.message` or
 * `String()` for unknown error types.
 *
 * @param error - The caught error value
 * @returns Human-readable error description
 *
 * @example
 * ```typescript
 * try {
 *   await fetchWithTimeout(url);
 * } catch (err) {
 *   console.error(formatNetworkError(err));
 * }
 * ```
 *
 * @public
 */
export function formatNetworkError(error: unknown): string {
  if (error instanceof NetworkError) {
    if (error.kind === "timeout") {
      return "Network request timed out. Please check your connection and try again.";
    }
    if (error.kind === "http") {
      return `Marketplace request failed with HTTP ${error.status ?? "unknown"}. Please try again shortly.`;
    }
    return "Network request failed. Please check your connection and try again.";
  }

  if (error instanceof Error) return error.message;
  return String(error);
}
