/**
 * Device logout and revoke (cleo-nexus device contract §3.5, review M3; client
 * tests §7.2): only 200, or 401 `device-signed-out` / `device-revoked`, counts
 * as done; the newest credential (`pending`) is used first; an unanswered
 * request keeps its slot for the next run; a revoke removes the entry only
 * once E10 reached the server.
 *
 * The API is a scripted mock that answers per bearer token. Every test uses
 * its own temp CLEO home.
 *
 * @task T12870
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEd25519, generateX25519 } from '../crypto.js';
import type { FetchLike } from '../http.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  applyBeginSignOut,
  applyEnrolment,
  applyPendingRotation,
  NexusDeviceEnrolment,
  type NexusDeviceEntry,
  type NexusDeviceKeys,
  NexusDeviceStore,
} from '../nexus-device.js';
import { logoutNexusDevice, settleNexusDeviceEnds } from '../nexus-logout.js';
import { uuidv7 } from '../uuidv7.js';

const API = 'https://api.nexus.test';
const USER_A = '0198a1b2-0000-7000-8000-00000000000a';
const USER_B = '0198a1b2-0000-7000-8000-00000000000b';

const mintToken = (): string => `cnx_d1_${randomBytes(32).toString('base64url')}`;

function keys(): NexusDeviceKeys {
  const enc = generateX25519();
  const sig = generateEd25519();
  return {
    encryption: {
      publicKey: enc.publicKey.toString('base64'),
      privateKey: enc.privateKey.toString('base64'),
    },
    signing: {
      publicKey: sig.publicKey.toString('base64'),
      privateKey: sig.privateKey.toString('base64'),
    },
  };
}

function enrolled(token: string, deviceId = uuidv7()): NexusDeviceEntry {
  return applyEnrolment(
    null,
    new NexusDeviceEnrolment({
      deviceId,
      keys: keys(),
      credential: {
        credentialId: uuidv7(),
        token,
        profile: 'device',
        scopes: ['account:read'],
        createdAt: new Date().toISOString(),
      },
    }),
  );
}

// ---------- the scripted API ----------

/** How the mock answers one bearer: a status and optional 401 reason, or a thrown network error. */
type Answer = { status: number; reason?: string } | 'network';

interface Call {
  method: string;
  path: string;
  token: string;
}

function mockApi(
  answers: Map<string, Answer>,
  fallback: Answer = { status: 401, reason: 'invalid' },
) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const token = auth.replace(/^Bearer /, '');
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, token });
    const a = answers.get(token) ?? fallback;
    if (a === 'network') throw new TypeError('fetch failed');
    if (a.status === 200) {
      return new Response(
        JSON.stringify({ success: true, data: { deviceId: 'x', state: 'signed-out' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code:
            a.status === 401 ? 'E_UNAUTHORIZED' : a.status === 404 ? 'E_NOT_FOUND' : 'E_INTERNAL',
          message: 'no',
          requestId: 'r1',
          ...(a.reason ? { details: { reason: a.reason } } : {}),
        },
      }),
      { status: a.status, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, calls };
}

let dir: string;
let store: NexusDeviceStore;
let sessions: FileNexusTokenStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-logout-'));
  store = new NexusDeviceStore(join(dir, 'home', 'nexus-device.json'));
  sessions = new FileNexusTokenStore(join(dir, 'home', 'nexus-credentials.json'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function seed(userId: string, entry: NexusDeviceEntry): Promise<void> {
  await store.update((tx) => tx.set(API, userId, entry));
}

async function read(userId: string): Promise<NexusDeviceEntry | null> {
  return (await store.get(API, userId))?.unseal() ?? null;
}

function run(fetch: FetchLike, revoke = false) {
  return logoutNexusDevice({ apiUrl: API, fetch, deviceStore: store, store: sessions, revoke });
}

describe('cleo logout nexus (E9)', () => {
  it('signs out with the pending credential first and keeps the device keys', async () => {
    const c0 = mintToken();
    const c1 = mintToken();
    const entry = applyPendingRotation(enrolled(c0), c1);
    await seed(USER_A, entry);
    const api = mockApi(new Map([[c1, { status: 200 }]]));

    const r = await run(api.fetch);

    expect(api.calls.map((c) => [c.method, c.path, c.token])).toEqual([
      ['POST', '/v1/devices/self/sign-out', c1],
    ]);
    expect(r.devices).toEqual([
      {
        userId: USER_A,
        deviceId: entry.deviceId,
        action: 'sign-out',
        retired: false,
        outcome: 'confirmed',
        removedLocally: false,
      },
    ]);
    expect(r.warnings).toEqual([]);
    const after = await read(USER_A);
    expect(after?.pendingSignOut).toBeNull();
    expect(after?.current).toBeNull();
    expect(after?.pending).toBeNull();
    expect(after?.keys).not.toBeNull();
    expect(after?.deviceId).toBe(entry.deviceId);
  });

  it('lost rotation: a pending credential the server never saw (401 invalid) falls back to current', async () => {
    const c0 = mintToken();
    const c1 = mintToken();
    await seed(USER_A, applyPendingRotation(enrolled(c0), c1));
    const api = mockApi(
      new Map<string, Answer>([
        [c1, { status: 401, reason: 'invalid' }],
        [c0, { status: 200 }],
      ]),
    );

    const r = await run(api.fetch);

    expect(api.calls.map((c) => c.token)).toEqual([c1, c0]);
    expect(r.devices[0]?.outcome).toBe('confirmed');
    expect((await read(USER_A))?.pendingSignOut).toBeNull();
  });

  it('lost rotation response: C0 is already revoked, the promoted C1 confirms', async () => {
    const c0 = mintToken();
    const c1 = mintToken();
    await seed(USER_A, applyPendingRotation(enrolled(c0), c1));
    const api = mockApi(
      new Map<string, Answer>([
        [c1, { status: 200 }],
        [c0, { status: 401, reason: 'credential-revoked' }],
      ]),
    );
    const r = await run(api.fetch);
    expect(r.devices[0]?.outcome).toBe('confirmed');
    expect(api.calls.map((c) => c.token)).toEqual([c1]);
  });

  it('401 device-signed-out and device-revoked count as done', async () => {
    for (const reason of ['device-signed-out', 'device-revoked']) {
      const c0 = mintToken();
      await seed(USER_A, enrolled(c0));
      const r = await run(mockApi(new Map([[c0, { status: 401, reason }]])).fetch);
      expect(r.devices[0]?.outcome).toBe('confirmed');
      expect((await read(USER_A))?.pendingSignOut).toBeNull();
    }
  });

  it('never reports done when every credential is refused as stale; the slot stays', async () => {
    const c0 = mintToken();
    await seed(USER_A, enrolled(c0));
    const r = await run(
      mockApi(new Map([[c0, { status: 401, reason: 'credential-expired' }]])).fetch,
    );

    expect(r.devices[0]?.outcome).toBe('unconfirmed');
    expect(r.warnings.join('\n')).toMatch(/not confirmed.*cleocode\.dev/);
    const after = await read(USER_A);
    expect(after?.pendingSignOut?.credentials.map((c) => c.token)).toEqual([c0]);
    expect(after?.current).toBeNull();
  });

  it('offline: keeps pendingSignOut, then the next run retries and confirms', async () => {
    const c0 = mintToken();
    await seed(USER_A, enrolled(c0));
    const offline = await run(mockApi(new Map(), 'network').fetch);
    expect(offline.devices[0]?.outcome).toBe('pending');
    expect(offline.warnings.join('\n')).toMatch(/retried by the next/);
    expect((await read(USER_A))?.pendingSignOut?.credentials.map((c) => c.token)).toEqual([c0]);

    const api = mockApi(new Map([[c0, { status: 200 }]]));
    const retry = await settleNexusDeviceEnds({
      apiUrl: API,
      fetch: api.fetch,
      deviceStore: store,
    });
    expect(retry.devices[0]?.outcome).toBe('confirmed');
    expect((await read(USER_A))?.pendingSignOut).toBeNull();
  });

  it('a route the server does not have yet (404) or a 429 keeps the slot', async () => {
    for (const status of [404, 429, 503]) {
      const c0 = mintToken();
      await seed(USER_A, enrolled(c0));
      const r = await run(mockApi(new Map([[c0, { status }]])).fetch);
      expect(r.devices[0]?.outcome).toBe('pending');
      expect((await read(USER_A))?.pendingSignOut).not.toBeNull();
    }
  });

  it('with nothing stored, reports nothing and calls nothing', async () => {
    const api = mockApi(new Map());
    const r = await run(api.fetch);
    expect(r.devices).toEqual([]);
    expect(r.session).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('retries a retired device request left by a device change', async () => {
    const old = mintToken();
    const signingOut = applyBeginSignOut(enrolled(old));
    const moved = applyEnrolment(
      signingOut,
      new NexusDeviceEnrolment({
        deviceId: uuidv7(),
        keys: keys(),
        credential: {
          credentialId: uuidv7(),
          token: mintToken(),
          profile: 'device',
          scopes: [],
          createdAt: new Date().toISOString(),
        },
      }),
    );
    expect(moved.retired?.[0]?.kind).toBe('sign-out');
    await seed(USER_A, moved);
    const api = mockApi(new Map([[old, { status: 200 }]]));
    const r = await settleNexusDeviceEnds({ apiUrl: API, fetch: api.fetch, deviceStore: store });
    expect(r.devices).toEqual([
      expect.objectContaining({
        deviceId: signingOut.deviceId,
        retired: true,
        outcome: 'confirmed',
      }),
    ]);
    const after = await read(USER_A);
    expect(after?.retired).toBeUndefined();
    expect(after?.current).not.toBeNull();
  });
});

describe('cleo logout nexus --revoke (E10)', () => {
  it('offline revoke keeps the entry, keys and pendingRevoke; a later 200 removes the entry', async () => {
    const c0 = mintToken();
    const entry = enrolled(c0);
    await seed(USER_A, entry);

    const offline = await run(mockApi(new Map(), 'network').fetch, true);
    expect(offline.devices[0]).toMatchObject({
      action: 'revoke',
      outcome: 'pending',
      removedLocally: false,
    });
    const kept = await read(USER_A);
    expect(kept?.pendingRevoke?.credentials.map((c) => c.token)).toEqual([c0]);
    expect(kept?.keys).not.toBeNull();

    const api = mockApi(new Map([[c0, { status: 200 }]]));
    const r = await run(api.fetch, true);
    expect(api.calls.map((c) => [c.method, c.path])).toEqual([['DELETE', '/v1/devices/self']]);
    expect(r.devices[0]).toMatchObject({ outcome: 'confirmed', removedLocally: true });
    expect(await read(USER_A)).toBeNull();
  });

  it('401 device-signed-out on a revoke ends it: web revoke named, slot cleared, never retried', async () => {
    const c0 = mintToken();
    const entry = enrolled(c0);
    await seed(USER_A, entry);
    const signedOut = await run(
      mockApi(new Map([[c0, { status: 401, reason: 'device-signed-out' }]])).fetch,
      true,
    );
    expect(signedOut.devices[0]).toMatchObject({ outcome: 'signed-out', removedLocally: false });
    expect(signedOut.warnings.join('\n')).toContain(
      `revoke device ${entry.deviceId} on cleocode.dev`,
    );
    const after = await read(USER_A);
    expect(after?.pendingRevoke).toBeNull();
    expect(after?.keys).not.toBeNull();

    const api = mockApi(new Map());
    const retry = await settleNexusDeviceEnds({
      apiUrl: API,
      fetch: api.fetch,
      deviceStore: store,
    });
    expect(api.calls).toEqual([]);
    expect(retry.devices).toEqual([]);
  });

  it('401 device-revoked confirms a revoke and removes the entry', async () => {
    const c0 = mintToken();
    await seed(USER_A, enrolled(c0));
    const revoked = await run(
      mockApi(new Map([[c0, { status: 401, reason: 'device-revoked' }]])).fetch,
      true,
    );
    expect(revoked.devices[0]).toMatchObject({ outcome: 'confirmed', removedLocally: true });
    expect(await read(USER_A)).toBeNull();
  });

  it('removing one entry keeps the file and the other accounts', async () => {
    const a = mintToken();
    const b = mintToken();
    await seed(USER_A, enrolled(a));
    await seed(USER_B, enrolled(b));
    const api = mockApi(
      new Map<string, Answer>([
        [a, { status: 200 }],
        [b, 'network'],
      ]),
    );
    const r = await run(api.fetch, true);
    expect(r.devices.map((d) => [d.userId, d.outcome])).toEqual([
      [USER_A, 'confirmed'],
      [USER_B, 'pending'],
    ]);
    expect(await read(USER_A)).toBeNull();
    expect((await read(USER_B))?.pendingRevoke).not.toBeNull();
    expect(readFileSync(store.location, 'utf8')).toContain(USER_B);
  });

  it('a signed-out device with no credential left warns instead of pretending', async () => {
    const c0 = mintToken();
    await seed(USER_A, enrolled(c0));
    await run(mockApi(new Map([[c0, { status: 200 }]])).fetch);
    const api = mockApi(new Map());
    const r = await run(api.fetch, true);
    expect(api.calls).toEqual([]);
    expect(r.devices).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/holds no credential.*revoke it on cleocode\.dev/);
  });
});
