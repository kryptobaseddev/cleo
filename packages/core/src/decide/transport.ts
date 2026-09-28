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
 *   ends in-flight queries. IP literals skip DNS; `localhost` and other
 *   hosts-file names are answered from the hosts file, in file order.
 * - `.local` (mDNS) names are refused outright unless the hosts file maps
 *   them: c-ares answers NXDOMAIN, and the system resolver would then wait
 *   seconds on multicast, uncancellably.
 * - When c-ares cannot answer (NXDOMAIN, SERVFAIL, REFUSED, timeout — e.g. a
 *   VPN's split DNS that only the system resolver knows), `dns.lookup` is the
 *   fallback. It is the ONE step that cannot be cancelled: a hung
 *   `getaddrinfo` holds the process until it returns. That residual risk is
 *   disclosed in the T12492 changeset.
 * - Every resolved address is tried in order (IPv4 first, then IPv6) until a
 *   connection is made; a refused or unreachable address moves on to the next.
 * - Requests use `agent: false` — no pooled keep-alive socket survives the
 *   call — and `req.destroy()` on abort tears down a socket in any phase.
 * - TLS verifies the certificate against the ORIGINAL hostname
 *   (`servername`), not the resolved address.
 * - Every listener converts a throw into a rejection: a response the WHATWG
 *   `Response` cannot represent (status outside 200–599) is a rejected call,
 *   never an uncaught exception that kills the CLI mid-write.
 * - The transport never consults `HTTPS_PROXY` / `NODE_USE_ENV_PROXY`.
 *
 * Provider-neutral: it knows no endpoint paths or wire shapes.
 *
 * @task T12492
 */

import { lookup as dnsLookup, Resolver } from 'node:dns';
import { readFileSync } from 'node:fs';
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
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** c-ares answers after which the system resolver may still know the name. */
const SYSTEM_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'ENODATA',
  'NOTFOUND',
  'ESERVFAIL',
  'SERVFAIL',
  'EREFUSED',
  'REFUSED',
  'ETIMEOUT',
  'TIMEOUT',
]);

/** Connect-phase failures after which the next address is worth trying. */
const NEXT_ADDRESS_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
]);

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Hosts-file path for this platform. */
function hostsFilePath(): string {
  return process.platform === 'win32'
    ? `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\drivers\\etc\\hosts`
    : '/etc/hosts';
}

/**
 * Addresses the hosts file maps `hostname` to, in file order. A synchronous
 * read of a small local file — no handle survives it.
 */
function hostsFileAddresses(hostname: string): string[] {
  let text: string;
  try {
    text = readFileSync(hostsFilePath(), 'utf-8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const [address, ...names] = (raw.split('#')[0] ?? '').trim().split(/\s+/);
    if (!address || !isIP(address)) continue;
    if (names.some((n) => n.toLowerCase() === hostname) && !out.includes(address)) {
      out.push(address);
    }
  }
  return out;
}

/** IPv4 addresses first, then IPv6, preserving order within each family. */
function v4First(addresses: readonly string[]): string[] {
  return [...addresses.filter((a) => isIP(a) === 4), ...addresses.filter((a) => isIP(a) === 6)];
}

/** Resolve through c-ares: both families. Cancellable; never throws synchronously. */
function resolveWithCares(hostname: string, signal: AbortSignal): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const resolver = new Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: 1 });
    let done = false;
    const finish = (err: Error | null, addresses: string[] = []): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(addresses);
    };
    const onAbort = (): void => {
      resolver.cancel();
      finish(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      resolver.resolve4(hostname, (err4, v4) => {
        if (done) return;
        resolver.resolve6(hostname, (err6, v6) => {
          const found = [...(err4 ? [] : v4), ...(err6 ? [] : v6)];
          if (found.length > 0) finish(null, found);
          else finish(err4 ?? err6 ?? new Error(`could not resolve ${hostname}`));
        });
      });
    } catch (err) {
      finish(asError(err));
    }
  });
}

/**
 * The system resolver (`getaddrinfo`) — NOT cancellable. Used only after
 * c-ares could not answer. An abort still settles the promise at once, but a
 * hung lookup keeps its threadpool request alive until it returns.
 */
function resolveWithSystem(hostname: string, signal: AbortSignal): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      dnsLookup(hostname, { all: true }, (err, addresses) => {
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(addresses.map((a) => a.address));
      });
    } catch (err) {
      signal.removeEventListener('abort', onAbort);
      reject(asError(err));
    }
  });
}

/** Resolve `hostname` to every candidate address, in connection order. */
async function resolveHost(hostname: string, signal: AbortSignal): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const name = hostname.toLowerCase().replace(/\.$/, '');
  const fromHosts = hostsFileAddresses(name);
  // `localhost` keeps the hosts file's own order (the system order).
  if (name === 'localhost') return fromHosts.length > 0 ? fromHosts : ['127.0.0.1', '::1'];
  if (fromHosts.length > 0) return v4First(fromHosts);
  if (name === 'local' || name.endsWith('.local')) {
    throw new Error(`refusing to resolve ${hostname}: .local (mDNS) names are not supported`);
  }

  try {
    return v4First(await resolveWithCares(hostname, signal));
  } catch (err) {
    if (signal.aborted) throw abortError();
    const code = errorCode(err);
    if (code === undefined || !SYSTEM_FALLBACK_CODES.has(code)) throw asError(err);
    return v4First(await resolveWithSystem(hostname, signal));
  }
}

/**
 * Buffer `res` into a WHATWG `Response`, capped at {@link MAX_RESPONSE_BYTES}.
 * Settles by rejection on any failure, including a status `Response` refuses.
 */
function toResponse(res: IncomingMessage): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const status = res.statusCode ?? 0;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      res.destroy();
      reject(new Error(`provider returned an HTTP status outside 200-599 (${status})`));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      try {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy(new Error('response body exceeds the size limit'));
          return;
        }
        chunks.push(chunk);
      } catch (err) {
        res.destroy(asError(err));
      }
    });
    res.on('error', (err) => reject(err));
    res.on('aborted', () => reject(new Error('response aborted')));
    res.on('close', () => {
      if (!res.complete) reject(new Error('response closed before it completed'));
    });
    res.on('end', () => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }
        const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, headers }));
      } catch (err) {
        reject(asError(err));
      }
    });
  });
}

/** One request to one resolved address. Settles by rejection; no listener throws. */
function requestOnce(
  target: URL,
  address: string,
  hostname: string,
  init: DecideFetchInit,
): Promise<Response> {
  const { signal } = init;
  const https = target.protocol === 'https:';
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let req: ReturnType<typeof httpRequest> | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      req?.destroy(abortError());
      settle(() => reject(abortError()));
    };
    try {
      req = (https ? httpsRequest : httpRequest)({
        host: address,
        port: target.port || (https ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers: { ...init.headers, host: target.host },
        agent: false,
        ...(https && !isIP(hostname) ? { servername: hostname } : {}),
      });
    } catch (err) {
      settle(() => reject(asError(err)));
      return;
    }
    const active = req;
    signal.addEventListener('abort', onAbort, { once: true });
    active.on('error', (err) => {
      settle(() => reject(signal.aborted ? abortError() : err));
    });
    active.on('response', (res) => {
      toResponse(res).then(
        (response) => settle(() => resolve(response)),
        (err: unknown) => {
          active.destroy();
          settle(() => reject(signal.aborted ? abortError() : asError(err)));
        },
      );
    });
    try {
      active.end(init.body);
    } catch (err) {
      active.destroy();
      settle(() => reject(asError(err)));
    }
  });
}

/**
 * Perform one HTTP(S) request and buffer the response.
 *
 * Rejects — never throws out of a callback — on abort, on any network or
 * protocol failure, and on a status outside 200–599. By the time an abort
 * rejects, the DNS query, socket and request have been destroyed (except a
 * system-resolver fallback already in flight; see the module docs).
 *
 * @param url - Absolute `http:` or `https:` URL.
 * @param init - Method, headers, body and the (required) abort signal.
 * @returns The buffered response.
 */
export async function decideFetch(url: string, init: DecideFetchInit): Promise<Response> {
  const { signal } = init;
  if (signal.aborted) throw abortError();
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error(`unsupported protocol ${target.protocol}`);
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolveHost(hostname, signal);
  if (signal.aborted) throw abortError();

  let lastError: Error = new Error(`no address for ${hostname}`);
  for (const address of addresses) {
    try {
      return await requestOnce(target, address, hostname, init);
    } catch (err) {
      if (signal.aborted) throw abortError();
      lastError = asError(err);
      const code = errorCode(err);
      if (code === undefined || !NEXT_ADDRESS_CODES.has(code)) throw lastError;
    }
  }
  throw lastError;
}
