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
 * I/O, and the transports refuse one when they connect.
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

/**
 * `fetch` for an agent's cloud messaging API. It refuses a retired host
 * before any network I/O and otherwise calls the global `fetch` unchanged.
 *
 * @param url - The full request URL.
 * @param init - The request options, passed through.
 * @returns The response.
 * @throws {SignalDockRetiredError} When the host is retired.
 */
export async function conduitFetch(url: string, init?: RequestInit): Promise<Response> {
  assertCloudUrlAllowed(url);
  return fetch(url, init);
}
