import type { ErrorCode } from '@cleocode/contracts/cloud';

export class NexusError extends Error {
  constructor(
    readonly code: ErrorCode | 'E_NETWORK',
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

export interface HttpOptions {
  baseUrl: string;
  token: string;
  deviceId?: string;
  fetch?: FetchLike;
  /** Attempts for retryable failures: network, 5xx, 429. Default 4. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Minimal envelope-aware HTTP client. It retries only failures that are safe to retry. Every API
 * write is idempotent or lineage-checked, so a retried write either no-ops or is refused explicitly.
 */
export class Http {
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: HttpOptions) {
    this.fetch = o.fetch ?? ((i, init) => globalThis.fetch(i, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        lastErr = new NexusError('E_NETWORK', (err as Error).message, 0, null);
        await this.sleep(backoff(attempt));
        continue;
      }
      const json = (await res.json().catch(() => null)) as
        | { success: true; data: T }
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
      if (json?.success) return json.data;
      const e = json && !json.success ? json.error : null;
      lastErr = new NexusError(
        e?.code ?? 'E_INTERNAL',
        e?.message ?? `HTTP ${res.status}`,
        res.status,
        e?.requestId ?? res.headers.get('x-request-id'),
        e?.details,
      );
      if (!RETRYABLE.has(res.status) || attempt === attempts) throw lastErr;
      const retryAfter = Number(res.headers.get('retry-after'));
      await this.sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt),
      );
    }
    throw lastErr ?? new NexusError('E_NETWORK', 'request failed', 0, null);
  }
}

const backoff = (attempt: number) =>
  Math.min(8_000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
