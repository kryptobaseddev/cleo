/**
 * Hook dispatch helpers for CLEO provider adapters.
 * Fire-and-forget HTTP dispatch to the brain worker daemon,
 * originally extracted from the legacy .claude-plugin/ brain-hook.sh.
 *
 * @task T5240
 */

import http from 'node:http';

/** Default brain worker port. */
const DEFAULT_WORKER_PORT = 37778;

/** Options for dispatching a hook event. */
export interface HookDispatchOptions {
  /** Worker port. Defaults to 37778. */
  port?: number;
  /** Host. Defaults to 127.0.0.1. */
  host?: string;
  /** Request timeout in milliseconds. Defaults to 5000. */
  timeout?: number;
}

/** Result of a hook dispatch attempt. */
export interface HookDispatchResult {
  sent: boolean;
  error?: string;
}

/**
 * Dispatch a hook event to the brain worker daemon.
 * Fire-and-forget: resolves with {sent: true} on success,
 * or {sent: false, error} on failure. Never rejects.
 */
export function dispatchHookEvent(
  event: string,
  data: Record<string, unknown>,
  options?: HookDispatchOptions,
): Promise<HookDispatchResult> {
  const port = options?.port ?? DEFAULT_WORKER_PORT;
  const host = options?.host ?? '127.0.0.1';
  const timeout = options?.timeout ?? 5000;

  const payload = JSON.stringify({ event, data });

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout,
      },
      (res) => {
        res.resume();
        resolve({ sent: true });
      },
    );

    req.on('error', (err) => {
      resolve({ sent: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ sent: false, error: 'Request timed out' });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Check if the brain worker daemon is healthy.
 */
export function checkWorkerHealth(options?: HookDispatchOptions): Promise<boolean> {
  const port = options?.port ?? DEFAULT_WORKER_PORT;
  const host = options?.host ?? '127.0.0.1';
  const timeout = options?.timeout ?? 3000;

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/health',
        method: 'GET',
        timeout,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}
