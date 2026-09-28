/**
 * `decideFetch` falls back to the system resolver when c-ares cannot answer —
 * SERVFAIL, REFUSED and timeout included (VPN split DNS answers only through
 * the system resolver) — and tries every address it gets, IPv4 first.
 *
 * `node:dns` is mocked: c-ares fails with the code under test, and the system
 * lookup maps the name to 127.0.0.1 (refused — nothing listens there) and
 * then ::1, where the test server is.
 *
 * @task T12492
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ caresCode: 'ESERVFAIL', lookups: 0 }));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  class FailingResolver {
    resolve4(_host: string, cb: (err: NodeJS.ErrnoException | null, a: string[]) => void): void {
      const err: NodeJS.ErrnoException = new Error(`c-ares ${state.caresCode}`);
      err.code = state.caresCode;
      queueMicrotask(() => cb(err, []));
    }
    resolve6(_host: string, cb: (err: NodeJS.ErrnoException | null, a: string[]) => void): void {
      this.resolve4(_host, cb);
    }
    cancel(): void {}
  }
  return {
    ...actual,
    Resolver: FailingResolver,
    lookup: (
      _host: string,
      _opts: object,
      cb: (err: Error | null, a: Array<{ address: string; family: number }>) => void,
    ) => {
      state.lookups += 1;
      // A refused address first: the transport must move on to the next one.
      queueMicrotask(() =>
        cb(null, [
          { address: '127.0.0.1', family: 4 },
          { address: '::1', family: 6 },
        ]),
      );
    },
  };
});

const { decideFetch } = await import('../transport.js');

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200).end('ok'));
  // IPv6 loopback only: the lookup's 127.0.0.1 is refused, so success proves
  // the transport moved on to the next address.
  await new Promise<void>((r) => server.listen(0, '::1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  state.lookups = 0;
});

describe('decideFetch system-resolver fallback', () => {
  it.each([
    'ESERVFAIL',
    'EREFUSED',
    'ETIMEOUT',
    'ENOTFOUND',
  ])('c-ares %s → dns.lookup answers → request succeeds', async (code) => {
    state.caresCode = code;
    const res = await decideFetch(`http://decide.split-dns.example:${port}/`, {
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(2_000),
    });
    expect(await res.text()).toBe('ok');
    expect(state.lookups).toBe(1);
  });

  it('does not fall back on a .local name', async () => {
    state.caresCode = 'ENOTFOUND';
    await expect(
      decideFetch(`http://printer.local:${port}/`, {
        method: 'GET',
        headers: {},
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow(/\.local/);
    expect(state.lookups).toBe(0);
  });
});
