import type { ErrorCode } from '@cleocode/contracts/cloud';

/**
 * `E_NETWORK`: the request never got an answer. `E_PROTOCOL`: the server answered with something the
 * contract or the E2E checks do not allow (a malformed body, replayed or reordered segments, a rolled-back
 * checkpoint). Both are client-side codes; the server never sends them.
 */
export type ClientErrorCode = ErrorCode | 'E_NETWORK' | 'E_PROTOCOL';

export class NexusError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}${requestId ? ` (request ${requestId})` : ''}`);
    this.name = 'NexusError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Anything with zod's `safeParse`: every response body is parsed against its contract schema. */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: boolean; data?: T };
}

export interface HttpOptions {
  /** https, or http only for localhost (tests and local development). */
  baseUrl: string;
  token: string;
  deviceId?: string;
  fetch?: FetchLike;
  /** Attempts for retryable failures: network, 5xx, 429. Default 4. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** The longest a server-sent Retry-After may make the client wait. Longer values are clamped. */
export const MAX_RETRY_AFTER_MS = 30_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for https URLs, and for http URLs on a loopback host. */
export function isSecureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Minimal envelope-aware HTTP client. It retries only failures that are safe to retry. Every API
 * write is idempotent or lineage-checked, so a retried write either no-ops or is refused explicitly.
 * It never follows redirects, so a bearer token is never replayed to another origin.
 */
export class Http {
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: HttpOptions) {
    if (!isSecureUrl(o.baseUrl)) {
      throw new NexusError(
        'E_VALIDATION',
        'baseUrl must be https (http is allowed only for localhost)',
        0,
        null,
      );
    }
    this.fetch = o.fetch ?? ((i, init) => globalThis.fetch(i, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Send a request and parse the success payload against `schema`. A payload that does not parse is E_PROTOCOL. */
  async request<T>(
    method: string,
    path: string,
    schema: ResponseSchema<T>,
    body?: unknown,
  ): Promise<T> {
    const attempts = this.o.maxAttempts ?? 4;
    let lastErr: NexusError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${this.o.token}` };
        if (this.o.deviceId) headers['x-cleo-device-id'] = this.o.deviceId;
        if (body !== undefined) headers['content-type'] = 'application/json';
        res = await this.fetch(`${this.o.baseUrl}${path}`, {
          method,
          headers,
          redirect: 'error',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        lastErr = new NexusError('E_NETWORK', (err as Error).message, 0, null);
        if (attempt < attempts) await this.sleep(backoff(attempt));
        continue;
      }
      const json = (await res.json().catch(() => null)) as
        | { success: true; data: unknown }
        | {
            success: false;
            error: {
              code: ErrorCode;
              message: string;
              requestId: string;
              details?: Record<string, unknown>;
            };
          }
        | null;
      const requestId = res.headers.get('x-request-id');
      if (json?.success === true) {
        const parsed = schema.safeParse(json.data);
        if (!parsed.success) {
          throw new NexusError(
            'E_PROTOCOL',
            `${method} ${path}: response does not match the contract`,
            res.status,
            requestId,
          );
        }
        return parsed.data as T;
      }
      const e = json && json.success === false ? json.error : null;
      lastErr = new NexusError(
        e?.code ?? 'E_INTERNAL',
        e?.message ?? `HTTP ${res.status}`,
        res.status,
        e?.requestId ?? requestId,
        e?.details,
      );
      if (!RETRYABLE.has(res.status) || attempt === attempts) throw lastErr;
      await this.sleep(retryDelay(res.headers.get('retry-after'), attempt));
    }
    throw lastErr ?? new NexusError('E_NETWORK', 'request failed', 0, null);
  }
}

/** Honour a numeric Retry-After, clamped to MAX_RETRY_AFTER_MS; otherwise back off exponentially. */
export function retryDelay(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && retryAfter.trim() !== '' && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000);
  }
  return backoff(attempt);
}

const backoff = (attempt: number) =>
  Math.min(8_000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
