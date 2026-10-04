/**
 * Cloud messaging endpoints — the one gate every agent-messaging network call
 * passes through (T13169).
 *
 * SignalDock (`api.signaldock.io`) is retired (owner decision D008), and its
 * servers are being deleted. Agent rows registered before the retirement
 * still carry its URL: the `api_base_url` column defaults to it, and CLEO
 * never rebuilds a table to change a default. So CLEO does not trust the
 * stored URL. Every call to an agent's cloud API goes through
 * {@link conduitFetch}, which refuses a SignalDock host before any network
 * I/O, at every redirect hop, and the transports refuse one when they connect.
 * As a backstop for any other path, {@link installRetiredHostFetchGuard}
 * wraps the process-global `fetch`. Only the CLI installs it, before every
 * command; SDK consumers of core and runtime are unaffected.
 *
 * `EventSource` follows redirects internally and cannot be checked per hop.
 * It is not a global in Node 24 without `--experimental-eventsource`, so the
 * SSE transport falls back to HTTP polling through {@link conduitFetch}.
 *
 * @task T13169
 */

/** Hosts of the retired SignalDock service. A subdomain of one is retired too. */
export const RETIRED_CLOUD_HOSTS: readonly string[] = ['signaldock.io'];

/** Error code for a refused call to a retired cloud host. */
export const E_SIGNALDOCK_RETIRED = 'E_SIGNALDOCK_RETIRED';

/**
 * The host of `url` when it is a retired SignalDock host, else `null`.
 *
 * A string that does not parse as a URL is not retired here: `fetch` and
 * `EventSource` cannot open it either.
 *
 * @param url - A base URL or full request URL, as stored or configured.
 * @returns The retired host name, or `null`.
 */
export function retiredCloudHost(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
  return RETIRED_CLOUD_HOSTS.some((retired) => host === retired || host.endsWith(`.${retired}`))
    ? host
    : null;
}

/**
 * Whether `url` points at a retired SignalDock host.
 *
 * @param url - A base URL or full request URL.
 * @returns `true` when CLEO must not call it.
 */
export function isRetiredCloudUrl(url: string | null | undefined): boolean {
  return retiredCloudHost(url) !== null;
}

/** A call to a retired cloud host was refused before any network I/O. */
export class SignalDockRetiredError extends Error {
  /** Stable error code, {@link E_SIGNALDOCK_RETIRED}. */
  readonly code = E_SIGNALDOCK_RETIRED;
  /** The refused host. */
  readonly host: string;

  /**
   * @param host - The retired host that was refused.
   */
  constructor(host: string) {
    super(
      `SignalDock is retired: CLEO no longer calls ${host}. Agent messaging runs locally through the project's conduit store (\`cleo init\` creates it).`,
    );
    this.name = 'SignalDockRetiredError';
    this.host = host;
  }
}

/**
 * Whether `err` is a {@link SignalDockRetiredError}.
 *
 * @param err - A caught value.
 * @returns `true` when the call was refused because its host is retired.
 */
export function isSignalDockRetiredError(err: unknown): err is SignalDockRetiredError {
  return err instanceof SignalDockRetiredError;
}

/**
 * Throw {@link SignalDockRetiredError} when `url` points at a retired host.
 *
 * @param url - The URL about to be opened.
 * @throws {SignalDockRetiredError} When the host is retired.
 */
export function assertCloudUrlAllowed(url: string | null | undefined): void {
  const host = retiredCloudHost(url);
  // @sync-invariant none:input-shape a retired cloud host is refused before any I/O; nothing is written
  if (host !== null) throw new SignalDockRetiredError(host);
}

/** Redirect statuses that carry a `Location` to follow. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Redirect hops {@link conduitFetch} follows before giving up. */
export const MAX_CONDUIT_REDIRECTS = 5;

/** Credentials that never cross to another origin on a redirect. */
const ORIGIN_BOUND_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;

/** Body headers dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
] as const;

/**
 * `fetch` for an agent's cloud messaging API. It refuses a retired host
 * before any network I/O, and follows redirects itself so that every hop's
 * host is checked too.
 *
 * Redirects follow the fetch standard: a 303, or a 301/302 after a POST,
 * becomes a body-less GET, and `Authorization`, `Cookie` and
 * `Proxy-Authorization` are dropped when the origin changes. A caller that
 * sets `redirect: 'manual'` or `'error'` gets fetch's own behaviour after the
 * first check.
 *
 * @param url - The full request URL.
 * @param init - The request options, passed through.
 * @returns The response.
 * @throws {SignalDockRetiredError} When the URL, or any redirect target, is a retired host.
 */
export async function conduitFetch(url: string, init: RequestInit = {}): Promise<Response> {
  assertCloudUrlAllowed(url);
  if (init.redirect === 'manual' || init.redirect === 'error') return fetch(url, init);

  let current = new URL(url);
  let request: RequestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    const response = await fetch(current.href, request);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (location === null) return response;
    await response.body?.cancel();
    if (hop >= MAX_CONDUIT_REDIRECTS) {
      // @sync-invariant none:input-shape a redirect loop is refused like fetch refuses one; nothing is written
      throw new Error(`conduitFetch: more than ${MAX_CONDUIT_REDIRECTS} redirects from ${url}`);
    }

    const next = new URL(location, current);
    assertCloudUrlAllowed(next.href);
    const headers = new Headers(request.headers);
    if (next.origin !== current.origin) {
      for (const name of ORIGIN_BOUND_HEADERS) headers.delete(name);
    }
    const method = (request.method ?? 'GET').toUpperCase();
    const toGet =
      (response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && method === 'POST');
    if (toGet) {
      for (const name of BODY_HEADERS) headers.delete(name);
      request = { ...request, method: 'GET', body: undefined, headers };
    } else {
      request = { ...request, headers };
    }
    current = next;
  }
}

/** Marks a `fetch` already wrapped by {@link installRetiredHostFetchGuard}. */
const FETCH_GUARD = Symbol.for('cleo.conduit.retiredHostFetchGuard');

/** The URL a `fetch` call targets, whatever form its first argument takes. */
function requestTarget(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wrap the process-global `fetch` so that any request to a retired SignalDock
 * host is refused, whichever code path makes it. Every other request passes
 * through unchanged. Calling it again is a no-op.
 *
 * This is the backstop behind {@link conduitFetch}: it checks the first URL
 * only (redirect hops are checked by {@link conduitFetch}).
 */
export function installRetiredHostFetchGuard(): void {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || FETCH_GUARD in original) return;
  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    assertCloudUrlAllowed(requestTarget(input));
    return original(input, init);
  };
  Object.defineProperty(guarded, FETCH_GUARD, { value: true });
  globalThis.fetch = guarded;
}
