/**
 * Graceful TCP port allocator for the docs viewer.
 *
 * Extracted from `server.ts` so the bind/retry loop can be tested without
 * spinning up the full viewer request handler. Default range is 7777 → 7800
 * (24 ports), matching the convention shared by other CLEO local services.
 * Auto-increment can be disabled with `autoIncrement: false`.
 *
 * @epic T9631
 * @task T9646 — `cleo docs serve` local viewer
 * @task T9722 — graceful port allocation 7777 → 7800
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

/** First port the allocator will attempt. */
export const DEFAULT_START_PORT = 7777;

/** Last port the allocator will attempt (inclusive). */
export const DEFAULT_END_PORT = 7800;

/** Successful bind result. */
export interface BoundServer {
  /** Bound TCP port (the OS-resolved port when `startPort === 0`). */
  port: number;
  /** Bind host. */
  host: string;
  /** Underlying `http.Server` instance with `requestHandler` already wired. */
  server: Server;
}

/** Options accepted by {@link tryListen}. */
export interface TryListenOptions {
  /** First port to attempt. Default: {@link DEFAULT_START_PORT}. */
  startPort?: number;
  /** Last port to attempt (inclusive). Default: {@link DEFAULT_END_PORT}. */
  endPort?: number;
  /** Bind host. Default: `127.0.0.1`. */
  host?: string;
  /** When true (default), auto-increment on `EADDRINUSE`. */
  autoIncrement?: boolean;
}

/**
 * Try to bind a fresh `http.Server` to the first available port in
 * `[startPort, endPort]`.
 *
 * The returned server is created with `requestHandler` already wired so the
 * caller never sees a hot socket without a listener.
 *
 * @throws `EADDRINUSE` when `autoIncrement` is `false` and `startPort` is busy.
 * @throws `E_NO_PORT` when every port in the range returned `EADDRINUSE`.
 *
 * @task T9722
 */
export async function tryListen(
  requestHandler: (req: IncomingMessage, res: ServerResponse) => void,
  opts: TryListenOptions = {},
): Promise<BoundServer> {
  const startPort = opts.startPort ?? DEFAULT_START_PORT;
  const endPort = opts.endPort ?? DEFAULT_END_PORT;
  const host = opts.host ?? '127.0.0.1';
  const autoIncrement = opts.autoIncrement ?? true;
  const last = autoIncrement ? endPort : startPort;

  for (let port = startPort; port <= last; port++) {
    const server = createServer(requestHandler);
    try {
      await new Promise<void>((res, rej) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListen);
          rej(err);
        };
        const onListen = () => {
          server.removeListener('error', onError);
          res();
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, host);
      });
      // When `port === 0` the OS picked a free port — read it from the
      // socket address so callers see the actual bound port.
      const addr = server.address();
      const boundPort =
        addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : port;
      return { server, port: boundPort, host };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Always close the half-bound server to release the fd before retrying.
      server.close();
      if (e.code !== 'EADDRINUSE') {
        // Surface non-collision errors immediately (permissions etc.).
        throw e;
      }
      if (!autoIncrement) {
        throw Object.assign(new Error(`port ${startPort} in use`), { code: 'EADDRINUSE' });
      }
    }
  }

  throw Object.assign(
    new Error(
      `no free port in range ${startPort}–${endPort} for viewer (tried ${last - startPort + 1} ports)`,
    ),
    { code: 'E_NO_PORT' },
  );
}
