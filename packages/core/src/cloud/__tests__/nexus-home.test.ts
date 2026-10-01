/**
 * This device's global CLEO store on the account's `home:` stream (T12952):
 * `attachHomeReplica` / `attachNexusGlobalStore` attach the global-scope
 * replica with path-free presence, rebind only for this user's own revoked
 * device, and refuse a copied store; `nexusGlobalStoreStatus` reads the
 * attachments back. The API is a scripted mock; the binder is a stub except
 * in the binding tests, which bind a real temp global `cleo.db`.
 *
 * @task T12952
 * @epic T12323
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache } from '../../store/dual-scope-db.js';
import { activeReplica, ensureGlobalReplica } from '../../store/sync/replica.js';
import { ReplicaRegistry } from '../../store/sync/replica-registry.js';
import { generateEd25519, generateX25519, uuidv7 } from '../crypto.js';
import type { FetchLike } from '../http.js';
import {
  attachHomeReplica,
  canonicalGlobalReplicaBinder,
  type ProjectReplicaBinder,
} from '../nexus-attach.js';
import { NexusAccountError } from '../nexus-auth.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  applyEnrolment,
  NEXUS_DEVICE_ENV,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '../nexus-device.js';
import {
  attachNexusGlobalStore,
  nexusGlobalStoreStatus,
  W_NEXUS_HOME_UNSUPPORTED,
} from '../nexus-home.js';

const API = 'https://api.nexus.test';
const USER = '0198a1b2-0000-7000-8000-0000000000aa';
const DEVICE = '01a0f48f-89db-7e69-95d6-87e4c14da0d1';
const OTHER_DEVICE = '01a0f48f-89db-7e69-95d6-87e4c14da0d2';
const R1 = '01a0f48f-0000-7000-8000-000000000001';
const R2 = '01a0f48f-0000-7000-8000-000000000002';
const NOW = '2026-10-01T12:00:00.000Z';
const HOME_PATH = '/v1/account/home/replicas';

interface Call {
  method: string;
  path: string;
  deviceHeader: string | null;
  body: unknown;
}

type Reply = { status: number; data?: unknown; code?: string; details?: Record<string, unknown> };

function api(replies: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      path: new URL(input).pathname,
      deviceHeader: new Headers(init?.headers).get('x-cleo-device-id'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const r = replies(call);
    const body =
      r.status < 300
        ? { success: true, data: r.data ?? {} }
        : {
            success: false,
            error: {
              code: r.code ?? (r.status === 404 ? 'E_NOT_FOUND' : 'E_CONFLICT'),
              message: 'no',
              requestId: 'r',
              details: r.details,
            },
          };
    return new Response(JSON.stringify(body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

const ok = (call: Call): Reply =>
  call.method === 'PUT'
    ? { status: 200, data: { presenceAt: NOW } }
    : { status: 201, data: { replicaId: (call.body as { replicaId: string }).replicaId } };

function binder(): ProjectReplicaBinder & { rebinds: number } {
  const b = {
    rebinds: 0,
    ensure: async () => ({ replicaId: R1 }),
    rebindReenrolled: async () => {
      b.rebinds += 1;
      return { replicaId: R2, previousReplicaId: R1 };
    },
  };
  return b;
}

let base: string;
let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'nexus-home-'));
  home = join(base, 'cleo-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  saved = { flag: process.env[NEXUS_DEVICE_ENV], home: process.env['CLEO_HOME'] };
  process.env[NEXUS_DEVICE_ENV] = '1';
  process.env['CLEO_HOME'] = home;
});

afterEach(() => {
  _resetDualScopeDbCache();
  if (saved['flag'] === undefined) delete process.env[NEXUS_DEVICE_ENV];
  else process.env[NEXUS_DEVICE_ENV] = saved['flag'];
  if (saved['home'] === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = saved['home'];
  rmSync(base, { recursive: true, force: true });
});

function attach(fetch: FetchLike, b: ProjectReplicaBinder) {
  return attachHomeReplica({
    apiUrl: API,
    bearer: `cnx_d1_${'A'.repeat(43)}`,
    deviceId: DEVICE,
    cliVersion: '2026.10.1',
    binder: b,
    fetch,
  });
}

async function failure(p: Promise<object>): Promise<NexusAccountError> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(NexusAccountError);
  return err as NexusAccountError;
}

/** An enrolled device in this test's CLEO home; returns the stores and its token. */
async function signedIn() {
  const devices = new NexusDeviceStore(join(home, 'nexus-device.json'), {
    cleoHome: home,
    lockWaitMs: 10_000,
  });
  const sessions = new FileNexusTokenStore(join(home, 'nexus-credentials.json'));
  const token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  const enc = generateX25519();
  const sig = generateEd25519();
  const b64 = (b: Buffer) => b.toString('base64');
  await devices.update((tx) => {
    tx.set(
      API,
      USER,
      applyEnrolment(
        tx.get(API, USER),
        new NexusDeviceEnrolment({
          deviceId: DEVICE,
          keys: {
            encryption: { publicKey: b64(enc.publicKey), privateKey: b64(enc.privateKey) },
            signing: { publicKey: b64(sig.publicKey), privateKey: b64(sig.privateKey) },
          },
          credential: {
            credentialId: uuidv7(),
            token,
            profile: 'device',
            scopes: ['account:read', 'devices:read', 'projects:read'],
            createdAt: NOW,
          },
        }),
      ),
    );
  });
  return { devices, sessions, token };
}

describe('attachHomeReplica', () => {
  it('attaches the global replica on the home collection and sends path-free presence', async () => {
    const m = api(ok);
    const r = await attach(m.fetch, binder());
    expect(r.replica).toEqual({
      replicaId: R1,
      deviceId: DEVICE,
      reboundFrom: null,
      presenceAt: NOW,
    });
    expect(r.warnings).toEqual([]);
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${HOME_PATH}`,
      `PUT ${HOME_PATH}/${R1}/presence`,
    ]);
    expect(m.calls[0]?.body).toEqual({ deviceId: DEVICE, replicaId: R1 });
    expect(m.calls.every((c) => c.deviceHeader === DEVICE)).toBe(true);
    const presence = m.calls[1]?.body as Record<string, unknown>;
    expect(presence).not.toHaveProperty('git');
    expect(presence['cliVersion']).toBe('2026.10.1');
    const text = JSON.stringify(presence);
    for (const leak of [hostname(), home, base, '"path"', '"hostname"']) {
      expect(text).not.toContain(leak);
    }
  });

  it("409 from this user's own revoked device rebinds and attaches the new id", async () => {
    let posts = 0;
    const m = api((call) => {
      if (call.method === 'POST' && posts++ === 0) {
        return { status: 409, details: { holderState: 'revoked', holderSameUser: true } };
      }
      return ok(call);
    });
    const b = binder();
    const r = await attach(m.fetch, b);
    expect(b.rebinds).toBe(1);
    expect(r.replica).toMatchObject({ replicaId: R2, reboundFrom: R1, presenceAt: NOW });
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${HOME_PATH}`,
      `POST ${HOME_PATH}`,
      `PUT ${HOME_PATH}/${R2}/presence`,
    ]);
    expect(m.calls[1]?.body).toEqual({ deviceId: DEVICE, replicaId: R2 });
  });

  it.each([
    ['a live device of this user', { holderState: 'active', holderSameUser: true }],
    ['another user', { holderState: 'revoked', holderSameUser: false }],
    ['the deployed server (no holder details)', { remedy: 'mint a new replica id' }],
  ])('any other 409 (%s) is E_NEXUS_REPLICA_COPIED with the login remedy', async (_, details) => {
    const m = api((call) => (call.method === 'POST' ? { status: 409, details } : ok(call)));
    const b = binder();
    const err = await failure(attach(m.fetch, b));
    expect(err.code).toBe('E_NEXUS_REPLICA_COPIED');
    expect(err.message).toContain('your global CLEO store');
    expect(err.fix).toContain('cleo login nexus');
    expect(err.fix).not.toContain('cleo project link');
    expect(b.rebinds).toBe(0);
    expect(m.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a failed presence report is a warning naming `cleo login nexus`', async () => {
    const m = api((call) => (call.method === 'PUT' ? { status: 400 } : ok(call)));
    const r = await attach(m.fetch, binder());
    expect(r.replica).toMatchObject({ replicaId: R1, presenceAt: null });
    expect(r.warnings.join('\n')).toMatch(
      /global CLEO store.*presence report failed.*cleo login nexus/,
    );
  });
});

describe('attachNexusGlobalStore', () => {
  it('attaches with the device credential', async () => {
    const { devices, sessions, token } = await signedIn();
    const auth: string[] = [];
    const m = api(ok);
    const fetch: FetchLike = (input, init) => {
      auth.push(new Headers(init?.headers).get('authorization') ?? '');
      return m.fetch(input, init);
    };
    const r = await attachNexusGlobalStore({
      apiUrl: API,
      fetch,
      deviceStore: devices,
      store: sessions,
      cliVersion: '2026.10.1',
      binder: binder(),
    });
    expect(r.replica).toMatchObject({ replicaId: R1, deviceId: DEVICE, presenceAt: NOW });
    expect(m.calls.filter((c) => c.path.startsWith(HOME_PATH))).toHaveLength(2);
    expect(auth.filter((a) => a !== '').every((a) => a === `Bearer ${token}`)).toBe(true);
  });

  it('a server without home replicas (404) is a warning and no replica', async () => {
    const { devices, sessions } = await signedIn();
    const m = api(() => ({ status: 404 }));
    const r = await attachNexusGlobalStore({
      apiUrl: API,
      fetch: m.fetch,
      deviceStore: devices,
      store: sessions,
      cliVersion: '2026.10.1',
      binder: binder(),
    });
    expect(r.replica).toBeNull();
    expect(r.warnings.some((w) => w.startsWith(W_NEXUS_HOME_UNSUPPORTED))).toBe(true);
  });

  it('does nothing with device mode off', async () => {
    process.env[NEXUS_DEVICE_ENV] = '0';
    const m = api(ok);
    const r = await attachNexusGlobalStore({ apiUrl: API, fetch: m.fetch, binder: binder() });
    expect(r).toEqual({ replica: null, warnings: [] });
    expect(m.calls).toHaveLength(0);
  });

  it('a copied store stays a failure (not a warning)', async () => {
    const { devices, sessions } = await signedIn();
    const m = api((call) =>
      call.method === 'POST' && call.path === HOME_PATH ? { status: 409 } : ok(call),
    );
    const err = await failure(
      attachNexusGlobalStore({
        apiUrl: API,
        fetch: m.fetch,
        deviceStore: devices,
        store: sessions,
        cliVersion: '2026.10.1',
        binder: binder(),
      }),
    );
    expect(err.code).toBe('E_NEXUS_REPLICA_COPIED');
  });
});

describe('nexusGlobalStoreStatus', () => {
  it("lists every device's attachment and picks this device's", async () => {
    const { devices, sessions } = await signedIn();
    const replicas = [
      { replicaId: R1, deviceId: DEVICE, presenceAt: NOW, attachedAt: NOW },
      { replicaId: R2, deviceId: OTHER_DEVICE, presenceAt: null, attachedAt: NOW },
    ];
    const m = api((call) =>
      call.method === 'GET' && call.path === HOME_PATH
        ? { status: 200, data: { replicas } }
        : { status: 404 },
    );
    const s = await nexusGlobalStoreStatus({
      apiUrl: API,
      fetch: m.fetch,
      deviceStore: devices,
      store: sessions,
    });
    expect(s.supported).toBe(true);
    expect(s.thisDevice).toMatchObject({ replicaId: R1, deviceId: DEVICE });
    expect(s.replicas).toHaveLength(2);
    expect(m.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('this device not attached: thisDevice is null', async () => {
    const { devices, sessions } = await signedIn();
    const m = api(() => ({
      status: 200,
      data: { replicas: [{ replicaId: R2, deviceId: OTHER_DEVICE }] },
    }));
    const s = await nexusGlobalStoreStatus({
      apiUrl: API,
      fetch: m.fetch,
      deviceStore: devices,
      store: sessions,
    });
    expect(s).toMatchObject({ supported: true, thisDevice: null });
  });

  it('a 404 is supported: false', async () => {
    const { devices, sessions } = await signedIn();
    const m = api(() => ({ status: 404 }));
    const s = await nexusGlobalStoreStatus({
      apiUrl: API,
      fetch: m.fetch,
      deviceStore: devices,
      store: sessions,
    });
    expect(s).toEqual({ supported: false, thisDevice: null, replicas: [] });
  });
});

describe('global replica binding (real temp cleo.db)', () => {
  it('ensureGlobalReplica binds once, then only reads', () => {
    const dbPath = join(base, 'cleo.db');
    const db = new DatabaseSync(dbPath);
    const registry = new ReplicaRegistry(join(base, 'registry.json'), 'host-1');
    try {
      const first = ensureGlobalReplica(db, { dbPath, mode: 'test', registry });
      expect(first.reboundFrom).toBeUndefined();
      expect(activeReplica(db, 'global')?.replicaId).toBe(first.replicaId);
      expect(activeReplica(db, 'project')).toBeUndefined();
      const again = ensureGlobalReplica(db, { dbPath, mode: 'test', registry });
      expect(again.replicaId).toBe(first.replicaId);
      expect(() => ensureGlobalReplica(db, { dbPath, mode: 'off' })).toThrow(/live or test/);
    } finally {
      db.close();
    }
  });

  it('canonicalGlobalReplicaBinder binds the CLEO home store and rebinds to a new id', async () => {
    const b = canonicalGlobalReplicaBinder();
    const first = await b.ensure();
    expect(first.replicaId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await b.ensure()).replicaId).toBe(first.replicaId);
    const rebound = await b.rebindReenrolled();
    expect(rebound.previousReplicaId).toBe(first.replicaId);
    expect(rebound.replicaId).not.toBe(first.replicaId);
    expect((await b.ensure()).replicaId).toBe(rebound.replicaId);
    _resetDualScopeDbCache();
    const db = new DatabaseSync(join(home, 'cleo.db'), { readOnly: true });
    try {
      expect(activeReplica(db, 'global')?.replicaId).toBe(rebound.replicaId);
    } finally {
      db.close();
    }
  });
});
