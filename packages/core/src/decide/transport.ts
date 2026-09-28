/**
 * Abort-complete HTTP transport for decision providers.
 *
 * The global `fetch` cannot be trusted with a sub-second, one-shot CLI
 * budget: aborting it rejects the promise, but a request still in its CONNECT
 * phase keeps its handle — `TCPConnectWrap` for an unanswered SYN, the TLS
 * socket for a stalled handshake, `GetAddrInfoReqWrap` for a slow DNS lookup
 * on the libuv threadpool. The CLI's success path relies on the event loop
 * draining, so each of those kept `cleo add` alive until the 3 s teardown
 * backstop (measured 4.4 s end to end, T12492).
 *
 * This transport owns every handle it creates, and releases all of them when
 * the signal fires:
 *
 * - DNS goes through a dedicated `dns.Resolver` (c-ares) whose `cancel()`
 *   ends in-flight queries; IP literals and `localhost` skip DNS. Names the
 *   resolver cannot find (e.g. `/etc/hosts`-only) fall back to `dns.lookup`.
 * - The request uses `agent: false` — no pooled keep-alive socket survives the
 *   call — and `req.destroy()` on abort tears down a socket in any phase.
 * - TLS still verifies the certificate against the ORIGINAL hostname
 *   (`servername`), not the resolved address.
 *
 * Provider-neutral: it knows no endpoint paths or wire shapes.
 *
 * @task T12492
 */

import { lookup as dnsLookup, Resolver } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/** Request options accepted by {@link decideFetch}. */
export interface DecideFetchInit {
  /** HTTP method. */
  readonly method: 'GET' | 'POST';
  /** Request headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Request body. */
  readonly body?: string;
  /** Cancels DNS, connect, request and response; every handle is released. */
  readonly signal: AbortSignal;
}

/** Signature of {@link decideFetch}; `globalThis.fetch` satisfies it too (tests inject stubs). */
export type DecideFetch = (url: string, init: DecideFetchInit) => Promise<Response>;

/** Upper bound on one DNS query when no abort arrives first, in ms. */
const RESOLVER_TIMEOUT_MS = 2_000;

/** Byte cap on a buffered response body. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Statuses whose `Response` must not carry a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function isNotFound(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'NOTFOUND';
}

/** Resolve `hostname` to one address, cancellably. */
function resolveHost(hostname: string, signal: AbortSignal): Promise<string> {
  if (isIP(hostname)) return Promise.resolve(hostname);
  if (hostname.toLowerCase() === 'localhost') return Promise.resolve('127.0.0.1');

  return new Promise<string>((resolve, reject) => {
    const resolver = new Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: 1 });
    let done = false;
    const finish = (err: Error | null, address?: string): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(address ?? hostname);
    };
    const onAbort = (): void => {
      resolver.cancel();
      finish(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    resolver.resolve4(hostname, (err4, v4) => {
      if (!err4 && v4[0]) return finish(null, v4[0]);
      if (done) return;
      resolver.resolve6(hostname, (err6, v6) => {
        if (!err6 && v6[0]) return finish(null, v6[0]);
        if (done) return;
        const err = err6 ?? err4;
        // Not in DNS: maybe a hosts-file name. `dns.lookup` answers those
        // from local files without a network round trip.
        if (err && isNotFound(err)) {
          dnsLookup(hostname, (errL, address) => finish(errL, address));
          return;
        }
        finish(err ?? new Error(`could not resolve ${hostname}`));
      });
    });
  });
}

/** Buffer `res` into a WHATWG `Response`, capped at {@link MAX_RESPONSE_BYTES}. */
function toResponse(res: IncomingMessage): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        res.destroy(new Error('response body exceeds the size limit'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', () => {
      const status = res.statusCode ?? 0;
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks);
      resolve(new Response(body, { status, headers }));
    });
  });
}

/**
 * Perform one HTTP(S) request and buffer the response.
 *
 * Rejects with an `AbortError` when `init.signal` fires; by then the DNS
 * query, socket and request have been destroyed, so no handle outlives the
 * call.
 *
 * @param url - Absolute `http:` or `https:` URL.
 * @param init - Method, headers, body and the (required) abort signal.
 * @returns The buffered response.
 */
export async function decideFetch(url: string, init: DecideFetchInit): Promise<Response> {
  const { signal } = init;
  if (signal.aborted) throw abortError();
  const target = new URL(url);
  const https = target.protocol === 'https:';
  if (!https && target.protocol !== 'http:') {
    throw new Error(`unsupported protocol ${target.protocol}`);
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const address = await resolveHost(hostname, signal);
  if (signal.aborted) throw abortError();

  return new Promise<Response>((resolve, reject) => {
    const request = https ? httpsRequest : httpRequest;
    const req = request({
      host: address,
      port: target.port || (https ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: init.method,
      headers: { ...init.headers, host: target.host },
      agent: false,
      ...(https && !isIP(hostname) ? { servername: hostname } : {}),
    });
    const onAbort = (): void => {
      req.destroy(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    req.on('close', cleanup);
    req.on('error', (err) => {
      cleanup();
      reject(signal.aborted ? abortError() : err);
    });
    req.on('response', (res) => {
      toResponse(res).then(resolve, (err: Error) => reject(signal.aborted ? abortError() : err));
    });
    req.end(init.body);
  });
}
