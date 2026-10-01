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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertTrustedVerificationUri,
  getNexusAccountStatus,
  loginToNexus,
  logoutFromNexus,
  NexusAccountError,
  resolveNexusApiUrl,
} from '../nexus-auth.js';
import { FileNexusTokenStore, NEXUS_CREDENTIALS_FILE } from '../nexus-credentials.js';
import {
  applyBeginSignOut,
  applyEnrolment,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '../nexus-device.js';

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
  opts: {
    tokenReplies?: TokenReply[];
    me?: 'ok' | 401 | 'network';
    signOut?: number | 'hang';
    verificationUri?: string;
    verificationUriComplete?: string | null;
  } = {},
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
        verification_uri: opts.verificationUri ?? 'https://web.nexus.test/device',
        ...(opts.verificationUriComplete === null
          ? {}
          : {
              verification_uri_complete:
                opts.verificationUriComplete ?? 'https://web.nexus.test/device?user_code=ABCD-EFGH',
            }),
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
      if (opts.signOut === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
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

// These tests cover the 9.24 session path: pin device credentials off and
// sandbox CLEO_HOME so no test reads the real nexus-device.json (T12904).
let savedDeviceFlag: string | undefined;
let savedCleoHome: string | undefined;
let pinnedHome: string;
beforeEach(() => {
  savedDeviceFlag = process.env['CLEO_NEXUS_DEVICE'];
  savedCleoHome = process.env['CLEO_HOME'];
  process.env['CLEO_NEXUS_DEVICE'] = '0';
  // Status and logout read nexus-device.json whatever the switch says: point
  // CLEO_HOME at an empty sandbox so no test ever reads the real one.
  pinnedHome = mkdtempSync(join(tmpdir(), 'cleo-home-pin-'));
  process.env['CLEO_HOME'] = pinnedHome;
});
afterEach(() => {
  if (savedDeviceFlag === undefined) delete process.env['CLEO_NEXUS_DEVICE'];
  else process.env['CLEO_NEXUS_DEVICE'] = savedDeviceFlag;
  if (savedCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedCleoHome;
  rmSync(pinnedHome, { recursive: true, force: true });
});

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

    // RFC 8628 form bodies on both device endpoints (cleo-nexus #11 accepts
    // them), with the only allowed client id.
    const form = (body: string | null | undefined) =>
      Object.fromEntries(new URLSearchParams(body ?? ''));
    const start = calls.find((c) => c.url.endsWith('/api/auth/device/code'));
    const poll = calls.find((c) => c.url.endsWith('/api/auth/device/token'));
    expect(start?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(poll?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form(start?.body)).toEqual({ client_id: 'cleo-cli' });
    expect(form(poll?.body)).toEqual({
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

describe('verification URI validation (T12712 review item 2)', () => {
  const bad: Array<[string, string]> = [
    ['phishing host', 'https://cleocode-login.evil.test/device'],
    ['lookalike suffix', 'https://web.nexus.test.evil.test/device'],
    ['file scheme', 'file:///etc/passwd'],
    ['custom scheme', 'cleo-evil://device'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['plain http', 'http://web.nexus.test/device'],
    ['leading dash (option injection)', '-x'],
    ['ESC (terminal injection)', 'https://web.nexus.test/device\u001b[2J'],
    ['carriage return', 'https://web.nexus.test/device\rVisit: https://evil.test'],
    ['C1 control', 'https://web.nexus.test/device\u009b31m'],
    ['bidi override U+202E', 'https://web.nexus.test/device‮ved.live'],
    ['bidi isolate U+2066', 'https://web.nexus.test/device⁦x'],
    ['zero-width space U+200B', 'https://web.nexus.test​/device'],
    ['zero-width no-break U+FEFF', 'https://web.nexus.test/device﻿'],
    ['backslash', 'https://web.nexus.test\\@evil.test/device'],
  ];
  for (const [what, uri] of bad) {
    it(`aborts the login on ${what}, before showing or opening anything`, async () => {
      const onCode = vi.fn();
      for (const variant of [
        { verificationUri: uri, verificationUriComplete: null },
        { verificationUriComplete: uri },
      ]) {
        const { fetchImpl, calls } = mockNexus({ tokenReplies: [approved], ...variant });
        await expect(
          loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep, onCode }),
        ).rejects.toMatchObject({ code: 'E_NEXUS_UNTRUSTED_VERIFICATION_URI' });
        expect(calls.some((c) => c.url.endsWith('/api/auth/device/token'))).toBe(false);
      }
      expect(onCode).not.toHaveBeenCalled();
      expect(await store.get(API)).toBeNull();
    });
  }

  it('hands onCode the normalised URL (the exact form that was validated)', async () => {
    const onCode = vi.fn();
    const { fetchImpl } = mockNexus({
      tokenReplies: [approved],
      verificationUri: 'HTTPS://WEB.Nexus.Test:443/device',
      verificationUriComplete: 'https://web.nexus.test:443/device?user_code=ABCD-EFGH',
    });
    await loginToNexus({ apiUrl: API, store, fetch: fetchImpl, sleep, onCode });
    expect(onCode).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationUri: 'https://web.nexus.test/device',
        verificationUriComplete: 'https://web.nexus.test/device?user_code=ABCD-EFGH',
      }),
    );
  });

  it('accepts the web origin of the production and staging APIs', () => {
    expect(() =>
      assertTrustedVerificationUri(
        'https://cleocode.dev/device?user_code=AB',
        'https://api.cleocode.dev',
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedVerificationUri(
        'https://staging.cleocode.dev/device',
        'https://api.staging.cleocode.dev',
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedVerificationUri(
        'https://cleocode.dev/device',
        'https://api.staging.cleocode.dev',
      ),
    ).toThrow(NexusAccountError);
    expect(() =>
      assertTrustedVerificationUri('http://localhost:5173/device', 'http://localhost:8787'),
    ).not.toThrow();
  });
});

describe('logout robustness (T12712 review items 3 and 7)', () => {
  const session = (token: string) => ({
    token,
    tokenType: 'Bearer',
    expiresAt: null,
    user: null,
    organization: null,
  });

  it('deletes locally first and gives up on a hanging revoke within the timeout', async () => {
    await store.put(API, session(TOKEN));
    const { fetchImpl } = mockNexus({ signOut: 'hang' });
    const started = Date.now();
    const result = await logoutFromNexus({
      apiUrl: API,
      store,
      fetch: fetchImpl,
      revokeTimeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ removedLocally: true, revocation: 'failed' });
    expect(await store.get(API)).toBeNull();
  }, 5_000);

  it('does not delete a session a concurrent login stored after logout read the old one', async () => {
    await store.put(API, session(TOKEN));
    const newer = 'tok_NEWER_concurrent_login_0123456789';
    const racing: typeof store = Object.create(store);
    racing.get = async (apiUrl: string) => {
      const old = await store.get(apiUrl);
      await store.put(apiUrl, session(newer)); // a login finishes in between
      return old;
    };
    const { fetchImpl } = mockNexus();
    const result = await logoutFromNexus({ apiUrl: API, store: racing, fetch: fetchImpl });
    expect(result.removedLocally).toBe(false);
    expect((await store.get(API))?.bearer()).toBe(newer);
  });
});

describe('token store on win32 (T12712 review item 1)', () => {
  it('skips the POSIX mode/owner check, since Windows reports 0o666', async () => {
    await store.put(API, session0());
    chmodSync(store.location, 0o666);
    const saved = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect((await store.get(API))?.bearer()).toBe(TOKEN);
      expect(await store.list()).toHaveLength(1);
      expect(await store.delete(API)).toBe(true);
    } finally {
      if (saved) Object.defineProperty(process, 'platform', saved);
    }
  });

  function session0() {
    return { token: TOKEN, tokenType: 'Bearer', expiresAt: null, user: null, organization: null };
  }
});

describe('getNexusAccountStatus with device credentials (T12904)', () => {
  const DEVICE_TOKEN = `cnx_d1_${'A'.repeat(43)}`;
  const enrolledEntry = () =>
    applyEnrolment(
      null,
      new NexusDeviceEnrolment({
        deviceId: '01a0f48f-89db-7e69-95d6-87e4c14da0d1',
        keys: null,
        credential: {
          credentialId: '01a0f48f-8eb4-735f-8483-f167d8d11a5a',
          token: DEVICE_TOKEN,
          profile: 'device',
          scopes: ['account:read'],
          createdAt: new Date().toISOString(),
        },
      }),
    );
  const whoami = (status: number) =>
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      expect(new URL(url).pathname).toBe('/v1/whoami');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${DEVICE_TOKEN}`);
      const body =
        status === 200
          ? {
              success: true,
              data: {
                user: { id: 'u-1', email: 'dev@example.test' },
                organizations: [{ id: 'o-1', name: 'Personal', personal: true }],
              },
            }
          : {
              success: false,
              error: {
                code: 'E_UNAUTHORIZED',
                message: 'no',
                requestId: 'r',
                details: { reason: 'device-signed-out' },
              },
            };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
  let devices: NexusDeviceStore;
  beforeEach(() => {
    devices = new NexusDeviceStore(join(dir, 'nexus-device.json'));
  });

  it('a device credential reads as signed in through E2, replacing a leftover session row', async () => {
    await devices.update((tx) => tx.set(API, 'u-1', enrolledEntry()));
    await store.put(API, {
      token: TOKEN,
      tokenType: 'Bearer',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u-1', email: 'cached@example.test' },
      organization: null,
    });
    const fetchImpl = whoami(200);
    const rows = await getNexusAccountStatus({
      store,
      fetch: fetchImpl,
      devices: true,
      deviceStore: devices,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        apiUrl: API,
        state: 'signed-in',
        email: 'dev@example.test',
        organization: 'Personal',
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a signed-out device (401) reads as expired; a locally signed-out device is not signed in', async () => {
    await devices.update((tx) => tx.set(API, 'u-1', enrolledEntry()));
    const [row] = await getNexusAccountStatus({
      store,
      fetch: whoami(401),
      devices: true,
      deviceStore: devices,
    });
    expect(row?.state).toBe('expired');

    await devices.update((tx) => {
      const e = tx.get(API, 'u-1');
      if (e) tx.set(API, 'u-1', applyBeginSignOut(e));
    });
    const none = vi.fn();
    const [after] = await getNexusAccountStatus({
      store,
      fetch: none,
      devices: true,
      deviceStore: devices,
      apiUrl: API,
    });
    expect(after?.state).toBe('not-signed-in');
    expect(none).not.toHaveBeenCalled();
  });

  it('device rows show even with CLEO_NEXUS_DEVICE=0, so the switch never hides a live credential (review M2)', async () => {
    await devices.update((tx) => tx.set(API, 'u-1', enrolledEntry()));
    expect(process.env['CLEO_NEXUS_DEVICE']).toBe('0');
    const [row] = await getNexusAccountStatus({ store, fetch: whoami(200), deviceStore: devices });
    expect(row?.state).toBe('signed-in');
  });

  it('an unreadable device store keeps the session rows and names the error (review M1)', async () => {
    await store.put(API, {
      token: TOKEN,
      tokenType: 'Bearer',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u-1', email: 'cached@example.test' },
      organization: null,
    });
    writeFileSync(devices.location, '{not json');
    const { fetchImpl } = mockNexus();
    const rows = await getNexusAccountStatus({ store, fetch: fetchImpl, deviceStore: devices });
    expect(rows.map((r) => r.state).sort()).toEqual(['signed-in', 'unverified']);
    expect(rows.find((r) => r.state === 'unverified')?.summary).toMatch(
      /device credentials unreadable/,
    );
  });

  it('a session of another user on the same origin is still shown (review L3)', async () => {
    await devices.update((tx) => tx.set(API, 'u-1', enrolledEntry()));
    await store.put(API, {
      token: TOKEN,
      tokenType: 'Bearer',
      expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'u-2', email: 'other@example.test' },
      organization: null,
    });
    const rows = await getNexusAccountStatus({
      store,
      fetch: whoami(200),
      deviceStore: devices,
      live: false,
    });
    expect(rows.length).toBe(2);
  });
});
