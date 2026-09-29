/**
 * Cleo Nexus account engine (T12712): device-code login through the shared
 * RFC 8628 runner, the 0600 token store, logout revocation, and status.
 *
 * The Nexus API is replaced by an in-memory mock `fetch` that mirrors the
 * better-auth routes (`/api/auth/device/code`, `/api/auth/device/token`,
 * `/api/auth/sign-out`) and the `/v1/account/me` envelope. Polling waits go
 * through an injected `sleep` that records each interval, so no test waits.
 *
 * @task T12712
 */

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNexusAccountStatus,
  loginToNexus,
  logoutFromNexus,
  NexusAccountError,
  resolveNexusApiUrl,
} from '../nexus-auth.js';
import { FileNexusTokenStore, NEXUS_CREDENTIALS_FILE } from '../nexus-credentials.js';

const API = 'https://api.nexus.test';
const TOKEN = 'tok_SECRET_session_token_0123456789abcdef';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

type TokenReply = { status: number; body: Record<string, unknown> };

/** A mock Nexus API. `tokenReplies` is consumed one per poll; the last repeats. */
function mockNexus(
  opts: { tokenReplies?: TokenReply[]; me?: 'ok' | 401 | 'network'; signOut?: number } = {},
) {
  const calls: Recorded[] = [];
  const tokenReplies = [...(opts.tokenReplies ?? [])];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
    });
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const path = new URL(url).pathname;
    if (path === '/api/auth/device/code') {
      return json(200, {
        device_code: 'dev-code-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://web.nexus.test/device',
        verification_uri_complete: 'https://web.nexus.test/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 5,
      });
    }
    if (path === '/api/auth/device/token') {
      const reply = tokenReplies.length > 1 ? tokenReplies.shift() : tokenReplies[0];
      if (!reply) throw new Error('no token reply configured');
      return json(reply.status, reply.body);
    }
    if (path === '/v1/account/me') {
      if (opts.me === 'network') throw new TypeError('fetch failed');
      if (opts.me === 401) {
        return json(401, {
          success: false,
          error: { code: 'E_UNAUTHENTICATED', message: 'sign in required', requestId: 'r1' },
        });
      }
      return json(200, {
        success: true,
        data: {
          user: { id: 'u-1', email: 'dev@example.test', name: 'Dev' },
          homeStream: { streamId: 'x' },
          organizations: [
            { id: 'o-2', name: 'Acme', slug: 'acme', role: 'member', personal: false },
            { id: 'o-1', name: 'Personal', slug: 'dev', role: 'owner', personal: true },
          ],
        },
        meta: { requestId: 'r1' },
      });
    }
    if (path === '/api/auth/sign-out') {
      return json(opts.signOut ?? 200, { success: true });
    }
    return json(404, { success: false, error: { code: 'E_NOT_FOUND', message: 'no route' } });
  });
  return { fetchImpl, calls };
}

const pending: TokenReply = {
  status: 400,
  body: { error: 'authorization_pending', error_description: 'pending' },
};
const slowDown: TokenReply = {
  status: 400,
  body: { error: 'slow_down', error_description: 'polling too frequently' },
};
const approved: TokenReply = {
  status: 200,
  body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 2_592_000, scope: '' },
};

let dir: string;
let store: FileNexusTokenStore;
let sleeps: number[];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-auth-'));
  store = new FileNexusTokenStore(join(dir, NEXUS_CREDENTIALS_FILE));
  sleeps = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loginToNexus — every poll branch', () => {
  it('pending, then success: stores the token and returns a secret-free result', async () => {
    const { fetchImpl, calls } = mockNexus({ tokenReplies: [pending, pending, approved] });
    const onCode = vi.fn();
    const onPending = vi.fn();
    const result = await loginToNexus({
      apiUrl: API,
      store,
      fetch: fetchImpl,
      sleep,
      onCode,
      onPending,
    });

    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCD-EFGH' }));
    expect(onPending).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([5000, 5000]);
    expect(result.apiUrl).toBe(API);
    expect(result.user?.email).toBe('dev@example.test');
    expect(result.organization?.name).toBe('Personal');
    expect(result.warnings).toEqual([]);
    expect((await store.get(API))?.bearer()).toBe(TOKEN);

    // The device endpoints get JSON (better-auth's token route refuses a form body)
    // and the only allowed client id.
    const start = calls.find((c) => c.url.endsWith('/api/auth/device/code'));
    const poll = calls.find((c) => c.url.endsWith('/api/auth/device/token'));
    expect(start?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(start?.body ?? '{}')).toEqual({ client_id: 'cleo-cli' });
    expect(JSON.parse(poll?.body ?? '{}')).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'cleo-cli',
      device_code: 'dev-code-1',
    });
    // The account lookup carries the bearer token.
    const me = calls.find((c) => c.url.endsWith('/v1/account/me'));
    expect(me?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('slow_down grows the interval by 5s each time', async () => {
    const { fetchImpl } = mockNexus({ tokenReplies: [slowDown, slowDown, pending, approved] });
    await loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep });
    expect(sleeps).toEqual([10_000, 15_000, 15_000]);
  });

  it('a 429 from a rate limiter is treated like slow_down', async () => {
    const { fetchImpl } = mockNexus({
      tokenReplies: [{ status: 429, body: { message: 'Too many requests' } }, approved],
    });
    await loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep });
    expect(sleeps).toEqual([10_000]);
    expect((await store.get(API))?.bearer()).toBe(TOKEN);
  });

  it('expired_token maps to E_NEXUS_DEVICE_CODE_EXPIRED and stores nothing', async () => {
    const { fetchImpl } = mockNexus({
      tokenReplies: [
        pending,
        { status: 400, body: { error: 'expired_token', error_description: 'x' } },
      ],
    });
    await expect(
      loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_DEVICE_CODE_EXPIRED' });
    expect(await store.get(API)).toBeNull();
  });

  it('a device code that outlives its deadline also maps to E_NEXUS_DEVICE_CODE_EXPIRED', async () => {
    const { fetchImpl } = mockNexus({ tokenReplies: [pending] });
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    const advancing = async (ms: number) => {
      t += ms;
    };
    await expect(
      loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep: advancing }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_DEVICE_CODE_EXPIRED' });
  });

  it('access_denied maps to E_NEXUS_ACCESS_DENIED', async () => {
    const { fetchImpl } = mockNexus({
      tokenReplies: [
        { status: 400, body: { error: 'access_denied', error_description: 'denied' } },
      ],
    });
    await expect(
      loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_ACCESS_DENIED' });
    expect(await store.get(API)).toBeNull();
  });

  it('a failed account lookup still stores the session and warns', async () => {
    const { fetchImpl } = mockNexus({ tokenReplies: [approved], me: 'network' });
    const result = await loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep });
    expect(result.user).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect((await store.get(API))?.bearer()).toBe(TOKEN);
  });
});

describe('token store — 0600 and never printed', () => {
  it('writes the store owner-only (0600)', async () => {
    const { fetchImpl } = mockNexus({ tokenReplies: [approved] });
    await loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep });
    expect(statSync(store.location).mode & 0o777).toBe(0o600);
  });

  it('keeps the token out of results, JSON, inspect, strings, errors and logs', async () => {
    const out: string[] = [];
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
        out.push(String(s));
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
        out.push(String(s));
        return true;
      }),
      vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' '))),
      vi.spyOn(console, 'warn').mockImplementation((...a) => void out.push(a.join(' '))),
    ];
    const { fetchImpl } = mockNexus({ tokenReplies: [approved], me: 401 });
    const login = await loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep });
    const session = await store.get(API);
    const status = await getNexusAccountStatus({ store, fetch: fetchImpl });
    const listed = await store.list();
    let loginErr = '';
    try {
      await loginToNexus({
        apiUrl: API,
        store,
        fetch: mockNexus({
          tokenReplies: [
            { status: 400, body: { error: 'invalid_grant', error_description: 'bad' } },
          ],
        }).fetchImpl,
        sleep,
      });
    } catch (err) {
      loginErr = `${String(err)} ${JSON.stringify(err)} ${inspect(err)}`;
    }
    for (const spy of spies) spy.mockRestore();

    const surfaces = [
      JSON.stringify(login),
      JSON.stringify(session),
      String(session),
      inspect(session),
      `${session}`,
      JSON.stringify(status),
      JSON.stringify(listed),
      inspect(listed),
      loginErr,
      out.join('\n'),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(TOKEN);
    expect(JSON.stringify(session)).toContain('tokenPreview');
    // It is on disk, where it belongs.
    expect(readFileSync(store.location, 'utf-8')).toContain(TOKEN);
  });

  it('refuses to read a store that group or others can access', async () => {
    const { fetchImpl } = mockNexus({ tokenReplies: [approved] });
    await loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep });
    chmodSync(store.location, 0o644);
    await expect(store.get(API)).rejects.toThrow(/mode 0600/);
  });

  it('refuses to write through a symlinked store', async () => {
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, '');
    const linked = join(dir, 'linked.json');
    symlinkSync(target, linked);
    const s = new FileNexusTokenStore(linked);
    await expect(
      s.put(API, {
        token: TOKEN,
        tokenType: 'Bearer',
        expiresAt: null,
        user: null,
        organization: null,
      }),
    ).rejects.toThrow(/symlink/);
  });
});

describe('logoutFromNexus — revoke server-side, delete locally', () => {
  async function signIn() {
    await store.put(API, {
      token: TOKEN,
      tokenType: 'Bearer',
      expiresAt: null,
      user: { id: 'u-1', email: 'dev@example.test' },
      organization: null,
    });
    // A second write rotates a backup that holds the token.
    await store.put(API, {
      token: TOKEN,
      tokenType: 'Bearer',
      expiresAt: null,
      user: { id: 'u-1', email: 'dev@example.test' },
      organization: null,
    });
  }

  it('POSTs /api/auth/sign-out with the bearer token, deletes the token and its backups', async () => {
    await signIn();
    const { fetchImpl, calls } = mockNexus();
    const result = await logoutFromNexus({ apiUrl: API, store, fetch: fetchImpl });

    expect(result).toEqual({
      apiUrl: API,
      removedLocally: true,
      revocation: 'revoked',
      warnings: [],
    });
    const signOut = calls.find((c) => c.url === `${API}/api/auth/sign-out`);
    expect(signOut?.method).toBe('POST');
    expect(signOut?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(await store.get(API)).toBeNull();
    expect(readFileSync(store.location, 'utf-8')).not.toContain(TOKEN);
    const backups = join(dir, '.backups');
    const leftovers = (() => {
      try {
        return readdirSync(backups).filter((f) => f.startsWith(NEXUS_CREDENTIALS_FILE));
      } catch {
        return [];
      }
    })();
    expect(leftovers).toEqual([]);
  });

  it('still deletes the local token when revocation fails, and says so', async () => {
    await signIn();
    const { fetchImpl } = mockNexus({ signOut: 503 });
    const result = await logoutFromNexus({ apiUrl: API, store, fetch: fetchImpl });
    expect(result.revocation).toBe('failed');
    expect(result.removedLocally).toBe(true);
    expect(result.warnings[0]).toMatch(/server-side sign-out failed/);
    expect(await store.get(API)).toBeNull();
  });

  it('is a no-op when not signed in (no network call)', async () => {
    const { fetchImpl } = mockNexus();
    const result = await logoutFromNexus({ apiUrl: API, store, fetch: fetchImpl });
    expect(result).toMatchObject({ removedLocally: false, revocation: 'skipped' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('getNexusAccountStatus', () => {
  beforeEach(async () => {
    await store.put(API, {
      token: TOKEN,
      tokenType: 'Bearer',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u-1', email: 'cached@example.test' },
      organization: null,
    });
  });

  it('signed in: email, organization and api url from /v1/account/me', async () => {
    const { fetchImpl } = mockNexus();
    const [row] = await getNexusAccountStatus({ store, fetch: fetchImpl });
    expect(row).toMatchObject({
      apiUrl: API,
      state: 'signed-in',
      email: 'dev@example.test',
      organization: 'Personal',
      summary: 'signed in as dev@example.test (Personal)',
    });
  });

  it('a 401 reads as an expired session, not a crash', async () => {
    const { fetchImpl } = mockNexus({ me: 401 });
    const [row] = await getNexusAccountStatus({ store, fetch: fetchImpl });
    expect(row?.state).toBe('expired');
    expect(row?.summary).toMatch(/session expired/);
  });

  it('an unreachable API reads as unverified, with the cached identity', async () => {
    const { fetchImpl } = mockNexus({ me: 'network' });
    const [row] = await getNexusAccountStatus({ store, fetch: fetchImpl });
    expect(row).toMatchObject({ state: 'unverified', email: 'cached@example.test' });
  });

  it('not signed in: one row, no network call', async () => {
    const empty = new FileNexusTokenStore(join(dir, 'empty.json'));
    const { fetchImpl } = mockNexus();
    const rows = await getNexusAccountStatus({ store: empty, fetch: fetchImpl, apiUrl: API });
    expect(rows).toEqual([
      {
        apiUrl: API,
        state: 'not-signed-in',
        email: null,
        organization: null,
        expiresAt: null,
        summary: 'not signed in',
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolveNexusApiUrl', () => {
  it('reduces to the origin and refuses insecure or credentialed URLs', () => {
    expect(resolveNexusApiUrl('https://api.cleocode.dev/v1/')).toBe('https://api.cleocode.dev');
    expect(resolveNexusApiUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => resolveNexusApiUrl('http://api.cleocode.dev')).toThrow(NexusAccountError);
    expect(() => resolveNexusApiUrl('https://u:p@api.cleocode.dev')).toThrow(NexusAccountError);
  });

  it('defaults to production, overridable by CLEO_NEXUS_API_URL', () => {
    const saved = process.env['CLEO_NEXUS_API_URL'];
    try {
      delete process.env['CLEO_NEXUS_API_URL'];
      expect(resolveNexusApiUrl()).toBe('https://api.cleocode.dev');
      process.env['CLEO_NEXUS_API_URL'] = 'https://api.staging.cleocode.dev';
      expect(resolveNexusApiUrl()).toBe('https://api.staging.cleocode.dev');
    } finally {
      if (saved === undefined) delete process.env['CLEO_NEXUS_API_URL'];
      else process.env['CLEO_NEXUS_API_URL'] = saved;
    }
  });
});
