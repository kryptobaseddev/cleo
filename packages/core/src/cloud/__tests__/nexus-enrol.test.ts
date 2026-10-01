/**
 * Device enrolment for `cleo login nexus` and the 9.24 session auto-upgrade
 * (cleo-nexus device contract v2.9 §3.3, §3.4, §4.0.4; client tests §7.2).
 *
 * The Nexus API is an in-memory, stateful mock: better-auth device-code and
 * sign-out routes, E1 (`POST /v1/devices/enroll`, which verifies the Ed25519
 * proof over the exact enrolment message and revokes older credentials on
 * re-enrolment), E2 (`GET /v1/whoami`) and `POST /v1/projects`. Hooks pause
 * E1, drop its answer after the server committed, or answer a 409.
 *
 * Every test uses its own temp CLEO home; nothing touches the real one.
 *
 * @task T12868
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEd25519, generateX25519, verifyEd25519 } from '../crypto.js';
import type { FetchLike } from '../http.js';
import { NexusError } from '../http.js';
import { NexusAccountError } from '../nexus-auth.js';
import type { NexusTokenStore } from '../nexus-credentials.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  applyBeginRevoke,
  applyDropCurrent,
  applyEnrolIntent,
  applyEnrolment,
  applyForgetDevice,
  applySetRaceCandidate,
  guardNexusDeviceSecrets,
  NEXUS_DEVICE_ENV,
  NexusDeviceEnrolment,
  type NexusDeviceKeys,
  NexusDeviceStore,
  NexusDeviceStoreError,
} from '../nexus-device.js';
import {
  defaultNexusDeviceName,
  ensureNexusDeviceCredential,
  loginToNexusDevice,
  NEXUS_STAGING_API_ORIGIN,
  NEXUS_TEST_BEARER_ENV,
  nexusApiErrorToAccountError,
  upgradeNexusSession,
  W_NEXUS_DEVICE_NAME_IS_HOSTNAME,
  W_NEXUS_LOGIN_RACE_BOTH_LIVE,
  W_NEXUS_TEST_BEARER_IGNORED,
} from '../nexus-enrol.js';
import { linkProjectToNexus } from '../nexus-link.js';

const API = 'https://api.nexus.test';
const USER = '0198a1b2-0000-7000-8000-0000000000aa';
const EMAIL = 'dev@example.test';

// ---------- the mock server ----------

interface ServerDevice {
  userId: string;
  enc: string;
  sig: string;
  name: string;
  revoked: boolean;
}

interface ServerCred {
  id: string;
  token: string;
  deviceId: string;
  createdAt: string;
  live: boolean;
  profile: 'device' | 'read-only';
  scopes: string[];
}

interface Call {
  method: string;
  path: string;
  auth: string;
  body: Record<string, unknown> | null;
  raw: string | null;
}

type EnrolHook = (
  n: number,
  body: Record<string, unknown>,
) => Promise<Response | 'drop' | undefined>;

const SCOPES_DEVICE = [
  'account:read',
  'devices:read',
  'projects:read',
  'projects:write',
  'sync:read',
  'sync:write',
  'keys:read',
  'keys:write',
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
  });
}

function fail(status: number, code: string, reason?: string): Response {
  return json(status, {
    success: false,
    error: {
      code,
      message: reason ?? code,
      requestId: 'r',
      ...(reason ? { details: { reason } } : {}),
    },
  });
}

function ok(data: unknown, status = 200): Response {
  return json(status, { success: true, data, meta: { requestId: 'r' } });
}

let uuidCounter = 0;
function serverUuid(): string {
  uuidCounter += 1;
  return `0198ffff-0000-7000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

class MockNexus {
  readonly sessions = new Map<string, { userId: string; exempt: boolean }>();
  /** Exempt sessions an E1 consumed: a later E1 with one gets 401 `session-used` (v2.12). */
  readonly consumed = new Set<string>();
  /** The device-code `verification_uri` (must sit under the API's web host). */
  verificationUri = 'https://nexus.test/device';
  readonly devices = new Map<string, ServerDevice>();
  readonly creds: ServerCred[] = [];
  readonly calls: Call[] = [];
  enrolCount = 0;
  /** Runs before E1 commits; may answer instead. */
  beforeEnrol: EnrolHook | null = null;
  /** Runs after E1 committed; `drop` loses the answer. */
  afterEnrol: EnrolHook | null = null;
  /** Runs before every E2 (delays, probes of the file). */
  beforeWhoami: ((auth: string) => Promise<void>) | null = null;
  /** Answer E2 for device credentials with this status instead (5xx tests). */
  whoamiDeviceStatus: number | null = null;
  /** Re-enrolment revokes older credentials (the contract); off to force "both live". */
  revokeOnReenrol = true;
  /** The v1 session the auto-upgrade presents is exempt (pre-deploy). */
  private clock = Date.parse('2026-09-30T00:00:00.000Z');

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  /** Mint a bearer session for the user. */
  session(exempt = false): string {
    const token = `sess_${randomBytes(16).toString('hex')}`;
    this.sessions.set(token, { userId: USER, exempt });
    return token;
  }

  live(deviceId: string): ServerCred[] {
    return this.creds.filter((c) => c.deviceId === deviceId && c.live);
  }

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : null;
    let body: Record<string, unknown> | null = null;
    if (raw !== null) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const auth = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    this.calls.push({ method: init?.method ?? 'GET', path: u.pathname, auth, body, raw });
    switch (u.pathname) {
      case '/api/auth/device/code':
        return json(200, {
          device_code: 'dev-code',
          user_code: 'ABCD-EFGH',
          verification_uri: this.verificationUri,
          expires_in: 900,
          interval: 1,
        });
      case '/api/auth/device/token':
        return json(200, { access_token: this.session(), token_type: 'Bearer', expires_in: 900 });
      case '/api/auth/sign-out': {
        if (!this.sessions.delete(auth)) return fail(401, 'E_UNAUTHENTICATED', 'invalid');
        return json(200, { success: true });
      }
      case '/v1/whoami':
        if (this.beforeWhoami) await this.beforeWhoami(auth);
        return this.whoami(auth);
      case '/v1/devices/enroll':
        return this.enrol(auth, body ?? {});
      default:
        return fail(404, 'E_NOT_FOUND');
    }
  };

  private whoami(auth: string): Response {
    const session = this.sessions.get(auth);
    const org = { id: 'o-1', name: 'Personal', slug: 'dev', role: 'owner', personal: true };
    const user = { id: USER, email: EMAIL, name: 'Dev' };
    if (session) {
      return ok({
        serverTime: new Date(this.clock).toISOString(),
        user,
        organizations: [org],
        credential: { kind: 'session', credentialId: null, profile: null, scopes: SCOPES_DEVICE },
        device: null,
      });
    }
    const cred = this.creds.find((c) => c.token === auth);
    if (!cred) return fail(401, 'E_UNAUTHENTICATED', 'invalid');
    if (this.whoamiDeviceStatus !== null) return fail(this.whoamiDeviceStatus, 'E_INTERNAL');
    if (!cred.live) return fail(401, 'E_UNAUTHENTICATED', 'credential-revoked');
    const device = this.devices.get(cred.deviceId);
    return ok({
      serverTime: new Date(this.clock).toISOString(),
      user,
      organizations: [org],
      credential: {
        kind: 'device',
        credentialId: cred.id,
        profile: cred.profile,
        scopes: cred.scopes,
      },
      device: {
        deviceId: cred.deviceId,
        name: device?.name ?? '?',
        state: 'active',
        profile: cred.profile,
      },
    });
  }

  private async enrol(auth: string, body: Record<string, unknown>): Promise<Response> {
    this.enrolCount += 1;
    const n = this.enrolCount;
    const early = this.beforeEnrol ? await this.beforeEnrol(n, body) : undefined;
    if (early instanceof Response) return early;
    const session = this.sessions.get(auth);
    if (!session) {
      return fail(401, 'E_UNAUTHENTICATED', this.consumed.has(auth) ? 'session-used' : 'invalid');
    }
    const deviceId = String(body['deviceId']);
    const enc = String(body['encryptionPublicKey']);
    const sig = String(body['signingPublicKey']);
    const profile = body['profile'] === 'read-only' ? 'read-only' : 'device';
    const message = new TextEncoder().encode(
      [
        'cleo-nexus/device-enroll/v1',
        session.userId,
        deviceId,
        Buffer.from(enc, 'base64').toString('hex'),
        Buffer.from(sig, 'base64').toString('hex'),
        profile,
      ].join('\n'),
    );
    if (
      !verifyEd25519(
        Buffer.from(sig, 'base64'),
        message,
        Buffer.from(String(body['proof']), 'base64'),
      )
    ) {
      return fail(400, 'E_VALIDATION', 'proof-invalid');
    }
    const existing = this.devices.get(deviceId);
    if (existing && existing.userId !== session.userId) {
      return fail(409, 'E_CONFLICT', 'device-other-account');
    }
    if (existing?.revoked) return fail(409, 'E_CONFLICT', 'device-revoked');
    if (existing && (existing.enc !== enc || existing.sig !== sig)) {
      return fail(409, 'E_CONFLICT', 'device-keys-changed');
    }
    const created = !existing;
    this.devices.set(deviceId, {
      userId: session.userId,
      enc,
      sig,
      name: String(body['name']),
      revoked: false,
    });
    if (this.revokeOnReenrol) {
      for (const c of this.creds) if (c.deviceId === deviceId) c.live = false;
    }
    const cred: ServerCred = {
      id: serverUuid(),
      token: `cnx_d1_${randomBytes(32).toString('base64url')}`,
      deviceId,
      createdAt: this.now(),
      live: true,
      profile,
      scopes: profile === 'read-only' ? SCOPES_DEVICE.slice(0, 3) : SCOPES_DEVICE,
    };
    this.creds.push(cred);
    if (session.exempt) {
      this.sessions.delete(auth); // one shot (M2)
      this.consumed.add(auth);
    }
    const answer = ok(
      {
        device: { deviceId, name: String(body['name']), state: 'active', profile },
        credential: {
          credentialId: cred.id,
          token: cred.token,
          profile,
          scopes: cred.scopes,
          idleExpiryDays: 90,
          createdAt: cred.createdAt,
        },
        created,
      },
      created ? 201 : 200,
    );
    const after = this.afterEnrol ? await this.afterEnrol(n, body) : undefined;
    if (after === 'drop') throw new TypeError('fetch failed: connection reset');
    return after instanceof Response ? after : answer;
  }
}

// ---------- fixtures ----------

let base: string;
let home: string;
let server: MockNexus;
let devices: NexusDeviceStore;
let sessions: FileNexusTokenStore;
let savedHome: string | undefined;
let savedFlag: string | undefined;
let savedTestBearer: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'nexus-enrol-'));
  home = join(base, 'cleo-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  savedHome = process.env['CLEO_HOME'];
  savedFlag = process.env[NEXUS_DEVICE_ENV];
  savedTestBearer = process.env[NEXUS_TEST_BEARER_ENV];
  delete process.env[NEXUS_TEST_BEARER_ENV];
  process.env['CLEO_HOME'] = home;
  process.env[NEXUS_DEVICE_ENV] = '1';
  server = new MockNexus();
  devices = new NexusDeviceStore(join(home, 'nexus-device.json'), {
    cleoHome: home,
    lockWaitMs: 10_000,
  });
  sessions = new FileNexusTokenStore(join(home, 'nexus-credentials.json'));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedHome;
  if (savedFlag === undefined) delete process.env[NEXUS_DEVICE_ENV];
  else process.env[NEXUS_DEVICE_ENV] = savedFlag;
  if (savedTestBearer === undefined) delete process.env[NEXUS_TEST_BEARER_ENV];
  else process.env[NEXUS_TEST_BEARER_ENV] = savedTestBearer;
});

const noSleep = async (): Promise<void> => {};

function flow(extra: Record<string, unknown> = {}) {
  return {
    apiUrl: API,
    fetch: server.fetch,
    deviceStore: devices,
    store: sessions,
    cliVersion: '2026.9.99-test',
    pollSleep: noSleep,
    upgradePollMs: 10,
    ...extra,
  };
}

async function accountError(p: Promise<unknown>, code: string): Promise<NexusAccountError> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(NexusAccountError);
  expect((err as NexusAccountError).code).toBe(code);
  return err as NexusAccountError;
}

/** A 9.24 session in nexus-credentials.json. */
async function seedV1Session(exempt = true): Promise<string> {
  const token = server.session(exempt);
  await sessions.put(API, {
    token,
    tokenType: 'Bearer',
    expiresAt: null,
    user: { id: USER, email: EMAIL, name: 'Dev' },
    organization: null,
  });
  return token;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function keyPairs(): NexusDeviceKeys {
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

async function storedToken(): Promise<string | null> {
  return (await devices.get(API, USER))?.currentBearer() ?? null;
}

// ---------- login ----------

describe('loginToNexusDevice after a revoke forgot the device (review #1762 LOW-C)', () => {
  it('mints a new device id instead of re-enrolling the forgotten one', async () => {
    const first = await loginToNexusDevice(flow());
    const burned = first.device?.deviceId;
    expect(burned).toBeDefined();
    await devices.update((tx) => {
      const e = tx.get(API, USER);
      if (e) tx.set(API, USER, applyForgetDevice(applyBeginRevoke(e)));
    });
    const before = server.count('/v1/devices/enroll');
    const again = await loginToNexusDevice(flow());
    expect(again.device?.deviceId).toBeDefined();
    expect(again.device?.deviceId).not.toBe(burned);
    // The client minted the new id itself: one E1, never a 409-driven retry.
    expect(server.count('/v1/devices/enroll')).toBe(before + 1);
  });
});

describe('loginToNexusDevice: fresh enrolment (§3.3 steps 1-10)', () => {
  it('enrols, signs the session out, and stores only the sealed device credential at 0600', async () => {
    const result = await loginToNexusDevice(flow());

    expect(result.device?.created).toBe(true);
    expect(result.device?.state).toBe('active');
    expect(result.device?.profile).toBe('device');
    expect(result.scopes).toEqual(SCOPES_DEVICE);
    expect(result.user?.id).toBe(USER);
    expect(result.credentialsPath).toBe(devices.location);

    // Device-code scope, E2 then E1 with the session, sign-out, E2 with C.
    const code = server.calls.find((c) => c.path === '/api/auth/device/code');
    expect(code?.raw).toContain('scope=cleo%3Adevice');
    const order = server.calls.map((c) => c.path).filter((p) => !p.startsWith('/api/auth/device'));
    expect(order).toEqual(['/v1/whoami', '/v1/devices/enroll', '/api/auth/sign-out', '/v1/whoami']);
    expect(server.sessions.size).toBe(0);

    const live = server.live(result.device?.deviceId ?? '');
    expect(live).toHaveLength(1);
    expect(await storedToken()).toBe(live[0]?.token);

    // Sealed at rest, owner-only; the v1 file is never written.
    const text = readFileSync(devices.location, 'utf-8');
    expect(text).not.toContain('cnx_d1_');
    expect(text).not.toContain(live[0]?.token ?? '-');
    if (process.platform !== 'win32') expect(statSync(devices.location).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'nexus-credentials.json'))).toBe(false);

    // The intent was cleared at step 7.
    expect((await devices.get(API, USER))?.unseal().enrolIntent ?? null).toBeNull();
  });

  it('sends the generic default name (no hostname), and never leaks a secret in the result', async () => {
    const result = await loginToNexusDevice(flow());
    const enrol = server.calls.find((c) => c.path === '/v1/devices/enroll');
    const deviceId = String(enrol?.body?.['deviceId']);
    expect(enrol?.body?.['name']).toBe(defaultNexusDeviceName(deviceId));
    expect(String(enrol?.body?.['name'])).not.toContain(hostname());
    expect(enrol?.body?.['cliVersion']).toBe('2026.9.99-test');
    const token = (await storedToken()) ?? '-';
    expect(JSON.stringify(result)).not.toContain(token);
    expect(inspect(result, { depth: 10 })).not.toContain(token);
    expect(JSON.stringify(await devices.get(API, USER))).not.toContain(token);
  });

  it('--read-only sends that profile and scope; a name equal to the hostname warns (L8)', async () => {
    const result = await loginToNexusDevice(flow({ readOnly: true, name: hostname() }));
    const code = server.calls.find((c) => c.path === '/api/auth/device/code');
    expect(code?.raw).toContain('scope=cleo%3Aread-only');
    const enrol = server.calls.find((c) => c.path === '/v1/devices/enroll');
    expect(enrol?.body?.['profile']).toBe('read-only');
    expect(enrol?.body?.['name']).toBe(hostname());
    expect(result.device?.profile).toBe('read-only');
    expect(result.warnings.some((w) => w.startsWith(W_NEXUS_DEVICE_NAME_IS_HOSTNAME))).toBe(true);
  });

  it('a re-login keeps the device id, re-enrols it and replaces the credential', async () => {
    const first = await loginToNexusDevice(flow());
    const firstToken = await storedToken();
    const second = await loginToNexusDevice(flow());
    expect(second.device?.deviceId).toBe(first.device?.deviceId);
    expect(second.device?.created).toBe(false);
    const live = server.live(second.device?.deviceId ?? '');
    expect(live).toHaveLength(1);
    expect(await storedToken()).toBe(live[0]?.token);
    expect(await storedToken()).not.toBe(firstToken);
  });
});

describe('loginToNexusDevice: pending revoke (v2.9)', () => {
  it('refuses with E_NEXUS_REVOKE_PENDING, sends no E1, and never clears pendingRevoke', async () => {
    await loginToNexusDevice(flow());
    await devices.update((tx) => {
      const entry = tx.get(API, USER);
      if (entry) tx.set(API, USER, applyBeginRevoke(entry));
    });
    const enrolsBefore = server.count('/v1/devices/enroll');
    const err = await accountError(loginToNexusDevice(flow()), 'E_NEXUS_REVOKE_PENDING');
    expect(err.fix).toContain('cleo logout nexus --revoke');
    expect(server.count('/v1/devices/enroll')).toBe(enrolsBefore);
    expect((await devices.get(API, USER))?.unseal().pendingRevoke).not.toBeNull();
  });
});

describe('loginToNexusDevice: E1 conflicts (§3.3 step 6, §4.0.4)', () => {
  it('409 device-revoked mints a new identity and retries once', async () => {
    const first = await loginToNexusDevice(flow());
    const old = first.device?.deviceId ?? '';
    const dev = server.devices.get(old);
    if (dev) dev.revoked = true;
    const second = await loginToNexusDevice(flow());
    expect(second.device?.deviceId).not.toBe(old);
    expect(second.device?.created).toBe(true);
    const enrols = server.calls.filter((c) => c.path === '/v1/devices/enroll');
    expect(enrols.slice(-2).map((c) => c.body?.['deviceId'])).toEqual([
      old,
      second.device?.deviceId,
    ]);
    // The old device's credential is kept for a retry, never silently dropped.
    const entry = (await devices.get(API, USER))?.unseal();
    expect(entry?.retired?.[0]?.deviceId).toBe(old);
  });

  it('409 device-keys-changed with the local keys intact is reported, not auto-resolved', async () => {
    const first = await loginToNexusDevice(flow());
    const dev = server.devices.get(first.device?.deviceId ?? '');
    if (dev) dev.enc = generateX25519().publicKey.toString('base64');
    const before = server.count('/v1/devices/enroll');
    const err = await accountError(loginToNexusDevice(flow()), 'E_NEXUS_REQUEST_FAILED');
    expect(err.message).toContain('different keys');
    expect(server.count('/v1/devices/enroll')).toBe(before + 1);
    expect((await devices.get(API, USER))?.deviceId).toBe(first.device?.deviceId);
  });

  it('409 device-id-taken with nothing enrolled here mints a new identity and retries once', async () => {
    server.beforeEnrol = async (n) =>
      n === 1 ? fail(409, 'E_CONFLICT', 'device-id-taken') : undefined;
    const result = await loginToNexusDevice(flow());
    const ids = server.calls
      .filter((c) => c.path === '/v1/devices/enroll')
      .map((c) => c.body?.['deviceId']);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(result.device?.deviceId).toBe(ids[1]);
  });

  it('409 device-id-taken after another process on this home enrolled the id uses that result', async () => {
    let other: Awaited<ReturnType<typeof loginToNexusDevice>> | null = null;
    server.beforeEnrol = async (n) => {
      if (n !== 1) return undefined;
      other = await loginToNexusDevice(flow()); // runs E1 #2 for the same persisted id
      return fail(409, 'E_CONFLICT', 'device-id-taken');
    };
    const result = await loginToNexusDevice(flow());
    expect(server.count('/v1/devices/enroll')).toBe(2);
    expect(result.device?.deviceId).toBe(
      (other as { device?: { deviceId: string } } | null)?.device?.deviceId,
    );
    expect(server.live(result.device?.deviceId ?? '')).toHaveLength(1);
    expect(await storedToken()).toBe(server.live(result.device?.deviceId ?? '')[0]?.token);
  });

  it('a network error on the interactive E1 reports E_NEXUS_UNREACHABLE; re-running re-enrols the same id', async () => {
    server.afterEnrol = async (n) => (n === 1 ? 'drop' : undefined);
    const lost = await accountError(loginToNexusDevice(flow()), 'E_NEXUS_UNREACHABLE');
    expect(lost.fix).toContain('revokes any credential left orphaned');
    const persisted = (await devices.get(API, USER))?.deviceId;
    expect(persisted).toBeDefined();
    const again = await loginToNexusDevice(flow());
    expect(again.device?.deviceId).toBe(persisted);
    expect(server.live(persisted ?? '')).toHaveLength(1);
  });
});

describe('loginToNexusDevice: concurrent logins on one home (M6, step 7)', () => {
  /** Login A's E1 commits first; B runs to completion before A's answer arrives. */
  async function race(opts: { beforeRelease?: () => void } = {}) {
    const committed = deferred();
    const release = deferred();
    server.afterEnrol = async (n) => {
      if (n === 1) {
        committed.resolve();
        await release.promise;
      }
      return undefined;
    };
    const a = loginToNexusDevice(flow()).then(
      (r) => r,
      (e: Error) => e,
    );
    await committed.promise;
    const b = await loginToNexusDevice(flow());
    opts.beforeRelease?.();
    release.resolve();
    return { a: await a, b };
  }

  it('ends with one device id and one live credential in the file, with no E9', async () => {
    const { a, b } = await race();
    expect(a).not.toBeInstanceOf(Error);
    const deviceId = b.device?.deviceId ?? '';
    expect((a as { device?: { deviceId: string } }).device?.deviceId).toBe(deviceId);
    expect(server.devices.size).toBe(1);
    const live = server.live(deviceId);
    expect(live).toHaveLength(1);
    expect(await storedToken()).toBe(live[0]?.token);
    expect(server.calls.some((c) => c.path.includes('sign-out') && c.path.startsWith('/v1'))).toBe(
      false,
    );
    // A's step 7 asked E2 about its own (revoked) credential: the race rule ran.
    const aToken = server.creds[0]?.token ?? '-';
    expect(server.calls.some((c) => c.path === '/v1/whoami' && c.auth === aToken)).toBe(true);
    const entry = (await devices.get(API, USER))?.unseal();
    expect(entry?.pendingSignOut).toBeNull();
    expect(entry?.enrolIntent ?? null).toBeNull();
  });

  it('both credentials live: keeps the later createdAt and warns (ruling A)', async () => {
    server.revokeOnReenrol = false;
    const { a } = await race();
    expect(a).not.toBeInstanceOf(Error);
    const warnings = (a as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.startsWith(W_NEXUS_LOGIN_RACE_BOTH_LIVE))).toBe(true);
    const newest = [...server.creds].sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    expect(await storedToken()).toBe(newest?.token);
  });

  it('both credentials refused: keeps neither and reports that a login is required', async () => {
    const { a } = await race({
      beforeRelease: () => {
        for (const c of server.creds) c.live = false;
      },
    });
    expect(a).toBeInstanceOf(NexusAccountError);
    expect((a as NexusAccountError).code).toBe('E_NEXUS_NOT_SIGNED_IN');
    expect(await storedToken()).toBeNull();
  });

  it('M2: the later E1 is never lost: parked as a sealed race candidate, settled by the next command', async () => {
    // A enrols first and stores; B prepared before A stored, so its later E1
    // (which revokes A's credential) meets A's credential at step 7.
    const aCommitted = deferred();
    const releaseA = deferred();
    const bEnrolling = deferred();
    const releaseB = deferred();
    server.beforeEnrol = async (n) => {
      if (n === 2) {
        bEnrolling.resolve();
        await releaseB.promise;
      }
      return undefined;
    };
    server.afterEnrol = async (n) => {
      if (n === 1) {
        aCommitted.resolve();
        await releaseA.promise;
      }
      return undefined;
    };
    const a = loginToNexusDevice(flow());
    await aCommitted.promise;
    const b = loginToNexusDevice(flow()).then(
      (r) => r,
      (e: Error) => e,
    );
    await bEnrolling.promise;
    releaseA.resolve();
    await a;
    server.whoamiDeviceStatus = 503;
    releaseB.resolve();
    const bResult = await b;

    expect(bResult).toBeInstanceOf(NexusAccountError);
    expect((bResult as NexusAccountError).code).toBe('E_NEXUS_UNREACHABLE');
    expect((bResult as NexusAccountError).fix).toContain('re-enrols the same device id');
    const aCred = server.creds[0];
    const bCred = server.creds[1];
    expect(aCred?.live).toBe(false);
    expect(bCred?.live).toBe(true);
    const entry = (await devices.get(API, USER))?.unseal();
    expect(entry?.current?.token).toBe(aCred?.token);
    expect(entry?.raceCandidate?.token).toBe(bCred?.token);
    expect(readFileSync(devices.location, 'utf-8')).not.toContain('cnx_d1_');

    // Next command, server reachable: E2 settles it to the live credential.
    server.whoamiDeviceStatus = null;
    const handle = await ensureNexusDeviceCredential(flow());
    expect(handle.device.currentBearer()).toBe(bCred?.token);
    expect((await devices.get(API, USER))?.unseal().raceCandidate ?? null).toBeNull();
  });
});

describe('loginToNexusDevice: unreadable entry (lost machine key)', () => {
  it('discards the entry, enrols a new device, and names the old device id to revoke', async () => {
    const first = await loginToNexusDevice(flow());
    const oldId = first.device?.deviceId ?? '';
    rmSync(join(home, 'machine-key'));
    const second = await loginToNexusDevice(flow());
    expect(second.device?.deviceId).not.toBe(oldId);
    const warning = second.warnings.find((w) => w.includes('W_NEXUS_DEVICE_DISCARDED_UNREADABLE'));
    expect(warning).toContain(oldId);
    expect(warning).toContain('revoke');
    expect(await storedToken()).toBe(server.live(second.device?.deviceId ?? '')[0]?.token);
  });
});

// ---------- the 9.24 auto-upgrade ----------

describe('upgradeNexusSession (§3.4)', () => {
  it('upgrades once, removes the origin session from the v1 file, and keeps that file valid v1', async () => {
    await seedV1Session();
    const result = await upgradeNexusSession(flow());
    expect(result.outcome).toBe('upgraded');
    expect(server.count('/v1/devices/enroll')).toBe(1);
    expect(server.sessions.size).toBe(0); // E1 consumed the exempt session
    expect(await sessions.get(API)).toBeNull();
    const v1 = JSON.parse(readFileSync(sessions.location, 'utf-8')) as { version: number };
    expect(v1.version).toBe(1);
    expect(result.device?.currentBearer()).toBe(
      server.live(result.device?.deviceId ?? '')[0]?.token,
    );
    // A failed sign-out after an exempt E1 is expected, not a warning.
    expect(result.warnings.some((w) => w.includes('signed out'))).toBe(false);
  });

  it('skips E1 when the device file already holds a credential; signs the leftover session out, then removes it', async () => {
    await loginToNexusDevice(flow());
    const leftover = await seedV1Session(false);
    const enrols = server.count('/v1/devices/enroll');
    let storedAtSignOut: boolean | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      if (new URL(url).pathname === '/api/auth/sign-out') {
        storedAtSignOut = (await sessions.get(API)) !== null;
      }
      return server.fetch(url, init);
    };
    const result = await upgradeNexusSession(flow({ fetch: fetchImpl }));
    expect(result.outcome).toBe('already-enrolled');
    expect(server.count('/v1/devices/enroll')).toBe(enrols);
    const signOuts = server.calls.filter(
      (c) => c.path === '/api/auth/sign-out' && c.auth === leftover,
    );
    expect(signOuts).toHaveLength(1);
    expect(storedAtSignOut).toBe(true); // signed out first, removed after
    expect(server.sessions.has(leftover)).toBe(false);
    expect(await sessions.get(API)).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('a failed sign-out of the leftover session is best effort: warned, still removed locally', async () => {
    await loginToNexusDevice(flow());
    const leftover = await seedV1Session(false);
    const fetchImpl: FetchLike = async (url, init) =>
      new URL(url).pathname === '/api/auth/sign-out'
        ? fail(503, 'E_INTERNAL')
        : server.fetch(url, init);
    const result = await upgradeNexusSession(flow({ fetch: fetchImpl }));
    expect(result.outcome).toBe('already-enrolled');
    expect(result.warnings.some((w) => w.includes('could not be signed out'))).toBe(true);
    expect(result.warnings.join(' ')).not.toContain(leftover);
    expect(await sessions.get(API)).toBeNull();
  });

  it('a lost E1 answer on the exempt path needs a browser login; no retry; the next login keeps the id', async () => {
    await seedV1Session();
    server.afterEnrol = async (n) => (n === 1 ? 'drop' : undefined);
    const err = await accountError(upgradeNexusSession(flow()), 'E_NEXUS_SESSION_EXPIRED');
    expect(err.fix).toContain('browser');
    expect(server.count('/v1/devices/enroll')).toBe(1);
    expect(await sessions.get(API)).toBeNull(); // never retried with the deleted session
    const persisted = (await devices.get(API, USER))?.deviceId;
    server.afterEnrol = null;
    const login = await loginToNexusDevice(flow());
    expect(login.device?.deviceId).toBe(persisted);
    expect(server.live(persisted ?? '')).toHaveLength(1);
  });

  it('an expired v1 session gives E_NEXUS_SESSION_EXPIRED', async () => {
    const token = await seedV1Session();
    server.sessions.delete(token);
    await accountError(upgradeNexusSession(flow()), 'E_NEXUS_SESSION_EXPIRED');
    expect(server.count('/v1/devices/enroll')).toBe(0);
  });

  it('a post-deploy session older than 15 minutes (403 session-not-fresh) needs a browser login (M1)', async () => {
    await seedV1Session(false);
    server.beforeEnrol = async () => fail(403, 'E_FORBIDDEN', 'session-not-fresh');
    const err = await accountError(upgradeNexusSession(flow()), 'E_NEXUS_SESSION_EXPIRED');
    expect(err.fix).toContain('browser');
  });

  it('T13008: a session the device flow did not mint (403 device-flow-session-required) needs a browser login', async () => {
    await seedV1Session(false);
    server.beforeEnrol = async () => fail(403, 'E_FORBIDDEN', 'device-flow-session-required');
    const err = await accountError(upgradeNexusSession(flow()), 'E_NEXUS_SESSION_EXPIRED');
    expect(err.fix).toContain('browser');
    expect(err.message).toMatch(/stored session can no longer be upgraded/);
    expect(err.message).toContain('device login');
  });

  it('two processes upgrading at once make exactly one E1 call and neither reports expiry (N1)', async () => {
    await seedV1Session();
    server.beforeEnrol = async () => {
      await new Promise((r) => setTimeout(r, 300));
      return undefined;
    };
    const [one, two] = await Promise.all([
      upgradeNexusSession(flow()),
      upgradeNexusSession(flow()),
    ]);
    expect(server.count('/v1/devices/enroll')).toBe(1);
    expect([one.outcome, two.outcome].sort()).toEqual(['already-enrolled', 'upgraded']);
    expect(one.device?.currentBearer()).toBe(two.device?.currentBearer());
  });

  it('T12903: two concurrent upgrades; the loser gets 401 session-used, re-reads the device file and reports already-enrolled', async () => {
    await seedV1Session();
    const aInE1 = deferred();
    const releaseA = deferred();
    let aDone: Promise<unknown> = Promise.resolve();
    server.beforeEnrol = async (n) => {
      if (n === 1) {
        // A is inside E1 and has not committed yet.
        aInE1.resolve();
        await releaseA.promise;
      } else {
        // B's E1 arrives: A commits (consuming the session) and stores first.
        releaseA.resolve();
        await aDone;
      }
      return undefined;
    };
    const a = upgradeNexusSession(flow());
    aDone = a.then(
      () => undefined,
      () => undefined,
    );
    await aInE1.promise;
    // B sees A's intent as stale (its clock is ahead) and takes it over, so
    // both processes send the one-shot session to E1.
    const b = upgradeNexusSession(flow({ now: () => new Date(Date.now() + 10 * 60_000) }));
    const [ra, rb] = await Promise.all([a, b]);

    expect(server.count('/v1/devices/enroll')).toBe(2);
    const second = server.calls.filter((c) => c.path === '/v1/devices/enroll')[1];
    expect(second?.auth).toBe(server.calls.find((c) => c.path === '/v1/devices/enroll')?.auth);
    expect(ra.outcome).toBe('upgraded');
    expect(rb.outcome).toBe('already-enrolled');
    expect(rb.device?.currentBearer()).toBe(ra.device?.currentBearer());
    expect(rb.device?.currentBearer()).not.toBeNull();
    expect(await sessions.get(API)).toBeNull();
    expect((await devices.get(API, USER))?.unseal().enrolIntent ?? null).toBeNull();
  });

  it('T12903: 401 session-used with no credential stored here is E_NEXUS_SESSION_EXPIRED (browser login); the session is removed', async () => {
    await seedV1Session();
    server.beforeEnrol = async () => fail(401, 'E_UNAUTHENTICATED', 'session-used');
    const err = await accountError(
      upgradeNexusSession(flow({ upgradeWaitMs: 100 })),
      'E_NEXUS_SESSION_EXPIRED',
    );
    expect(err.fix).toContain('browser');
    expect(err.message).toContain('already used');
    expect(server.count('/v1/devices/enroll')).toBe(1);
    expect(await sessions.get(API)).toBeNull();
    expect(await storedToken()).toBeNull();
  });

  it('T12903 review LOW-1: the winner stores AFTER the loser got session-used; the loser polls and reports already-enrolled', async () => {
    const token = await seedV1Session();
    const aInE1 = deferred();
    const releaseA = deferred();
    const releaseStore = deferred();
    server.beforeEnrol = async (n) => {
      if (n === 1) {
        aInE1.resolve();
        await releaseA.promise;
      } else {
        // Let A commit (consume the session) before B's E1 is answered.
        releaseA.resolve();
        while (!server.consumed.has(token)) await sleep(5);
      }
      return undefined;
    };
    // A's answer (and so its store) is held until B has its 401.
    server.afterEnrol = async (n) => {
      if (n === 1) await releaseStore.promise;
      return undefined;
    };
    let bGotSessionUsed = false;
    const bFetch: FetchLike = async (url, init) => {
      const res = await server.fetch(url, init);
      if (new URL(url).pathname === '/v1/devices/enroll' && res.status === 401) {
        bGotSessionUsed = true;
      }
      return res;
    };
    // B's first device-file read after its 401 finds nothing (A has not
    // stored yet); only then is A allowed to store.
    class GatedStore extends NexusDeviceStore {
      override async get(apiUrl: string, userId: string) {
        const found = await super.get(apiUrl, userId);
        if (bGotSessionUsed) {
          expect(found?.currentBearer() ?? null).toBeNull();
          releaseStore.resolve();
          bGotSessionUsed = false;
        }
        return found;
      }
    }
    const bDevices = new GatedStore(join(home, 'nexus-device.json'), {
      cleoHome: home,
      lockWaitMs: 10_000,
    });
    const a = upgradeNexusSession(flow());
    await aInE1.promise;
    const b = upgradeNexusSession(
      flow({
        fetch: bFetch,
        deviceStore: bDevices,
        now: () => new Date(Date.now() + 10 * 60_000),
      }),
    );
    const [ra, rb] = await Promise.all([a, b]);
    expect(server.count('/v1/devices/enroll')).toBe(2);
    expect(ra.outcome).toBe('upgraded');
    expect(rb.outcome).toBe('already-enrolled');
    expect(rb.device?.currentBearer()).toBe(ra.device?.currentBearer());
    expect(rb.device?.currentBearer()).not.toBeNull();
  });

  it('T12903 review LOW-2: an unreadable device store during the re-reads is a CLI error, not a raw store error', async () => {
    class BrokenStore extends NexusDeviceStore {
      broken = false;
      override async get(apiUrl: string, userId: string) {
        if (this.broken) {
          throw new NexusDeviceStoreError('E_NEXUS_DEVICE_UNSEAL_FAILED', 'cannot unseal');
        }
        return super.get(apiUrl, userId);
      }
    }
    const broken = new BrokenStore(join(home, 'nexus-device.json'), {
      cleoHome: home,
      lockWaitMs: 10_000,
    });
    // session-used path.
    await seedV1Session();
    server.beforeEnrol = async () => {
      broken.broken = true;
      return fail(401, 'E_UNAUTHENTICATED', 'session-used');
    };
    await accountError(
      upgradeNexusSession(flow({ deviceStore: broken })),
      'E_NEXUS_REQUEST_FAILED',
    );
    // 'enrolled' path: a credential exists, then the store breaks.
    broken.broken = false;
    server.beforeEnrol = null;
    await loginToNexusDevice(flow({ deviceStore: broken }));
    await seedV1Session();
    broken.broken = true;
    await accountError(
      upgradeNexusSession(flow({ deviceStore: broken })),
      'E_NEXUS_REQUEST_FAILED',
    );
  });

  it('waits for a live upgrade intent without calling E1, and gives up after the budget', async () => {
    await seedV1Session();
    await devices.update((tx) => {
      tx.set(
        API,
        USER,
        applyEnrolIntent(null, {
          deviceId: '0198a1b2-0000-7000-8000-00000000abcd',
          keys: keyPairs(),
          intent: {
            deviceId: '0198a1b2-0000-7000-8000-00000000abcd',
            kind: 'upgrade',
            owner: 'f'.repeat(32),
            startedAt: new Date().toISOString(),
          },
        }),
      );
    });
    await accountError(upgradeNexusSession(flow({ upgradeWaitMs: 150 })), 'E_NEXUS_BUSY');
    expect(server.count('/v1/devices/enroll')).toBe(0);
    expect(server.count('/v1/whoami')).toBe(0);
  });

  it('takes over a stale intent (no credential, same intent on a second locked read)', async () => {
    await seedV1Session();
    const staleId = '0198a1b2-0000-7000-8000-00000000abce';
    await devices.update((tx) => {
      tx.set(
        API,
        USER,
        applyEnrolIntent(null, {
          deviceId: staleId,
          keys: keyPairs(),
          intent: {
            deviceId: staleId,
            kind: 'upgrade',
            owner: 'e'.repeat(32),
            startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          },
        }),
      );
    });
    const result = await upgradeNexusSession(flow());
    expect(result.outcome).toBe('upgraded');
    expect(server.count('/v1/devices/enroll')).toBe(1);
    // The persisted identity (same id, same keys) is the one enrolled.
    expect(result.device?.deviceId).toBe(staleId);
  });

  it('ensureNexusDeviceCredential upgrades a v1 session, then reuses the device credential', async () => {
    await seedV1Session();
    const first = await ensureNexusDeviceCredential(flow());
    expect(first.upgraded).toBe(true);
    const second = await ensureNexusDeviceCredential(flow());
    expect(second.upgraded).toBe(false);
    expect(second.device.currentBearer()).toBe(first.device.currentBearer());
    expect(server.count('/v1/devices/enroll')).toBe(1);
  });

  it('with nothing stored, ensureNexusDeviceCredential reports not signed in', async () => {
    await accountError(ensureNexusDeviceCredential(flow()), 'E_NEXUS_NOT_SIGNED_IN');
  });
});

// ---------- staging test bearer (T12902) ----------

describe('loginToNexusDevice: CLEO_NEXUS_TEST_BEARER (staging only, T12902)', () => {
  /** Every surface a secret could leak through. */
  function expectNoLeak(value: unknown, secret: string): void {
    expect(JSON.stringify(value) ?? '').not.toContain(secret);
    expect(inspect(value, { depth: 10 })).not.toContain(secret);
    if (value instanceof Error) {
      expect(value.message).not.toContain(secret);
      expect(String((value as NexusAccountError).fix ?? '')).not.toContain(secret);
    }
  }

  it('against staging, skips the device code and runs E2 then E1 with the bearer, storing nexus-device.json', async () => {
    const bearer = server.session();
    process.env[NEXUS_TEST_BEARER_ENV] = bearer;
    let codes = 0;
    const result = await loginToNexusDevice(
      flow({
        apiUrl: NEXUS_STAGING_API_ORIGIN,
        onCode: () => {
          codes += 1;
        },
      }),
    );
    expect(codes).toBe(0);
    expect(server.calls.some((c) => c.path.startsWith('/api/auth/device'))).toBe(false);
    expect(server.calls.map((c) => c.path)).toEqual([
      '/v1/whoami',
      '/v1/devices/enroll',
      '/api/auth/sign-out',
      '/v1/whoami',
    ]);
    expect(server.calls[0]?.auth).toBe(bearer);
    expect(server.calls[1]?.auth).toBe(bearer);
    expect(result.apiUrl).toBe(NEXUS_STAGING_API_ORIGIN);
    expect(result.device?.created).toBe(true);
    const stored = (await devices.get(NEXUS_STAGING_API_ORIGIN, USER))?.currentBearer() ?? null;
    expect(stored).toBe(server.live(result.device?.deviceId ?? '')[0]?.token);
    expect(result.warnings.some((w) => w.includes(W_NEXUS_TEST_BEARER_IGNORED))).toBe(false);
    expectNoLeak(result, bearer);
    expect(readFileSync(devices.location, 'utf-8')).not.toContain(bearer);
  });

  it('against any other origin, is ignored with a warning and never sent: the device code runs', async () => {
    const bearer = server.session();
    process.env[NEXUS_TEST_BEARER_ENV] = bearer;
    const others = [
      ['https://api.cleocode.dev', 'https://cleocode.dev/device'],
      ['https://api.staging.cleocode.dev:8443', 'https://staging.cleocode.dev/device'],
      [API, 'https://nexus.test/device'],
    ] as const;
    for (const [apiUrl, verificationUri] of others) {
      server.calls.length = 0;
      server.verificationUri = verificationUri;
      const result = await loginToNexusDevice(flow({ apiUrl }));
      expect(server.count('/api/auth/device/code')).toBe(1);
      expect(server.calls.some((c) => c.auth === bearer)).toBe(false);
      const warning = result.warnings.find((w) => w.startsWith(W_NEXUS_TEST_BEARER_IGNORED));
      expect(warning).toContain(NEXUS_TEST_BEARER_ENV);
      expectNoLeak(result, bearer);
    }
  });

  it('review LOW-4: the staging guard compares the resolved origin, exactly', async () => {
    const honoured = [
      'HTTPS://API.STAGING.CLEOCODE.DEV',
      'https://api.staging.cleocode.dev:443/',
      'https://api.staging.cleocode.dev/some/path',
    ];
    for (const apiUrl of honoured) {
      const bearer = server.session();
      process.env[NEXUS_TEST_BEARER_ENV] = bearer;
      server.calls.length = 0;
      const result = await loginToNexusDevice(flow({ apiUrl }));
      expect(result.apiUrl).toBe(NEXUS_STAGING_API_ORIGIN);
      expect(server.count('/api/auth/device/code')).toBe(0);
      expect(server.calls[0]?.auth).toBe(bearer);
      expect(result.warnings.some((w) => w.includes(W_NEXUS_TEST_BEARER_IGNORED))).toBe(false);
    }
    const ignored = [
      ['https://api.staging.cleocode.dev.', 'https://staging.cleocode.dev./device'],
      ['https://api.staging.cleocode.dev.evil.com', 'https://staging.cleocode.dev.evil.com/device'],
      ['https://evil.com/api.staging.cleocode.dev', 'https://evil.com/device'],
    ] as const;
    for (const [apiUrl, verificationUri] of ignored) {
      const bearer = server.session();
      process.env[NEXUS_TEST_BEARER_ENV] = bearer;
      server.calls.length = 0;
      server.verificationUri = verificationUri;
      const result = await loginToNexusDevice(flow({ apiUrl }));
      expect(server.count('/api/auth/device/code')).toBe(1);
      expect(server.calls.some((c) => c.auth === bearer)).toBe(false);
      expect(result.warnings.some((w) => w.startsWith(W_NEXUS_TEST_BEARER_IGNORED))).toBe(true);
      expect(JSON.stringify(result)).not.toContain(bearer);
    }
    for (const apiUrl of [
      'http://api.staging.cleocode.dev',
      'https://u:p@api.staging.cleocode.dev',
    ]) {
      const bearer = server.session();
      process.env[NEXUS_TEST_BEARER_ENV] = bearer;
      server.calls.length = 0;
      const err = await accountError(
        loginToNexusDevice(flow({ apiUrl })),
        'E_NEXUS_INVALID_API_URL',
      );
      expect(err.message).not.toContain(bearer);
      expect(server.calls.some((c) => c.auth === bearer)).toBe(false);
    }
  });

  it('a bearer the staging server refuses fails without quoting it', async () => {
    const bearer = `sess_${randomBytes(16).toString('hex')}`; // never minted
    process.env[NEXUS_TEST_BEARER_ENV] = bearer;
    const err = await accountError(
      loginToNexusDevice(flow({ apiUrl: NEXUS_STAGING_API_ORIGIN })),
      'E_NEXUS_NOT_SIGNED_IN',
    );
    expectNoLeak(err, bearer);
    expect(server.count('/api/auth/device/code')).toBe(0);
    expect(server.count('/v1/devices/enroll')).toBe(0);
  });

  it('a value that is not a header token is refused before any request, without quoting it', async () => {
    const bearer = `bad token\n${randomBytes(8).toString('hex')}`;
    process.env[NEXUS_TEST_BEARER_ENV] = bearer;
    const err = await accountError(
      loginToNexusDevice(flow({ apiUrl: NEXUS_STAGING_API_ORIGIN })),
      'E_NEXUS_NOT_SIGNED_IN',
    );
    expectNoLeak(err, bearer);
    expect(err.message).toContain(NEXUS_TEST_BEARER_ENV);
    expect(server.calls.filter((c) => c.path !== '/api/auth/sign-out')).toHaveLength(0);
  });
});

// ---------- error mapping (§4.0.4) ----------

describe('nexusApiErrorToAccountError (§4.0.4)', () => {
  const map = (status: number, reason?: string, code = 'E_X'): string => {
    const err = new NexusError(
      code as 'E_CONFLICT',
      'm',
      status,
      'r',
      reason ? { reason } : undefined,
    );
    const mapped = nexusApiErrorToAccountError(err);
    return mapped instanceof NexusAccountError ? mapped.code : 'not-mapped';
  };

  it('maps every reason to its CLI code', () => {
    expect(map(401, 'invalid')).toBe('E_NEXUS_NOT_SIGNED_IN');
    expect(map(401, 'missing')).toBe('E_NEXUS_NOT_SIGNED_IN');
    expect(map(401, 'credential-revoked')).toBe('E_NEXUS_CREDENTIAL_COMPROMISED');
    expect(map(401, 'credential-expired')).toBe('E_NEXUS_SESSION_EXPIRED');
    expect(map(401, 'device-signed-out')).toBe('E_NEXUS_DEVICE_SIGNED_OUT');
    expect(map(401, 'device-revoked')).toBe('E_NEXUS_DEVICE_REVOKED');
    expect(map(401, 'session-bearer-retired')).toBe('E_NEXUS_SESSION_EXPIRED');
    expect(map(401, 'session-used')).toBe('E_NEXUS_SESSION_EXPIRED');
    expect(map(403, 'insufficient-scope')).toBe('E_NEXUS_INSUFFICIENT_SCOPE');
    expect(map(403, 'session-not-fresh')).toBe('E_NEXUS_SESSION_EXPIRED');
    expect(map(403, 'bearer-session-required')).toBe('E_NEXUS_SESSION_EXPIRED');
    expect(map(403, 'device-limit')).toBe('E_NEXUS_REQUEST_FAILED');
    expect(map(403, 'device-flow-session-required')).toBe('E_NEXUS_SESSION_EXPIRED');
    expect(map(403, 'device-not-enrolled')).toBe('E_NEXUS_NOT_SIGNED_IN');
    expect(map(403, 'session-required')).toBe('E_NEXUS_REQUEST_FAILED');
    expect(map(409, 'replica-copied')).toBe('E_NEXUS_REPLICA_COPIED');
    expect(map(409, 'project-other-account')).toBe('E_NEXUS_REQUEST_FAILED');
    expect(map(409, 'device-id-taken')).toBe('E_NEXUS_REQUEST_FAILED');
    expect(map(409, 'project-id-taken')).toBe('E_NEXUS_REQUEST_FAILED');
    expect(map(429)).toBe('E_NEXUS_REQUEST_FAILED');
    expect(map(0, undefined, 'E_NETWORK')).toBe('E_NEXUS_UNREACHABLE');
  });

  it('gives the R2 message for an unexplained credential-revoked', () => {
    const mapped = nexusApiErrorToAccountError(
      new NexusError('E_UNAUTHENTICATED', 'm', 401, 'r', { reason: 'credential-revoked' }),
    );
    expect(mapped.message).toContain('possibly used from another machine');
    expect((mapped as NexusAccountError).fix).toContain('revoke this device on cleocode.dev');
  });
});

// ---------- project link with the device credential ----------

describe('linkProjectToNexus with CLEO_NEXUS_DEVICE=1', () => {
  const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  let projectRoot: string;
  let savedCleoDir: string | undefined;

  beforeEach(() => {
    projectRoot = join(base, 'proj');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    writeFileSync(join(projectRoot, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
    savedCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
  });
  afterEach(() => {
    if (savedCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = savedCleoDir;
  });

  it('upgrades the v1 session, registers with the device credential, and retries once on project-id-taken', async () => {
    await seedV1Session();
    let posts = 0;
    const REPLICA = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === `/v1/projects/${PROJECT_ID}/replicas`) {
        return ok({ projectId: PROJECT_ID, replicaId: REPLICA, deviceId: 'd' });
      }
      if (path === `/v1/projects/${PROJECT_ID}/replicas/${REPLICA}/presence`) {
        return ok({
          projectId: PROJECT_ID,
          replicaId: REPLICA,
          presenceAt: '2026-10-01T00:00:00.000Z',
        });
      }
      if (path !== '/v1/projects') return server.fetch(url, init);
      posts += 1;
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      expect(auth.startsWith('Bearer cnx_d1_')).toBe(true);
      if (posts === 1) return fail(409, 'E_CONFLICT', 'project-id-taken');
      return ok({
        project: {
          projectId: PROJECT_ID,
          label: 'proj',
          encryptedName: null,
          remoteUrl: null,
          organizationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
          createdByUserId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
          createdAt: '2026-09-28T00:00:00.000Z',
        },
        streamId: `project:${PROJECT_ID}`,
      });
    };
    const result = await linkProjectToNexus({
      apiUrl: API,
      store: sessions,
      deviceStore: devices,
      projectRoot,
      label: 'proj',
      fetch: fetchImpl,
      cliVersion: '2026.10.0',
      replicaBinder: {
        ensure: async () => ({ replicaId: REPLICA }),
        rebindReenrolled: async () => {
          throw new Error('not expected');
        },
      },
    });
    expect(posts).toBe(2);
    expect(result.alreadyLinked).toBe(true);
    expect(result.replica).toMatchObject({
      replicaId: REPLICA,
      presenceAt: '2026-10-01T00:00:00.000Z',
    });
    expect(result.link.replicaId).toBe(REPLICA);
    expect(server.count('/v1/devices/enroll')).toBe(1);
    expect(await sessions.get(API)).toBeNull();
  });
  it('an attach the server refuses never fails the link: the binding is written and the warning names --rebind (review M1)', async () => {
    await seedV1Session();
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === `/v1/projects/${PROJECT_ID}/replicas`) {
        return fail(409, 'E_CONFLICT', 'x');
      }
      if (path !== '/v1/projects') return server.fetch(url, init);
      return ok({
        project: {
          projectId: PROJECT_ID,
          label: 'proj',
          encryptedName: null,
          remoteUrl: null,
          organizationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
          createdByUserId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
          createdAt: '2026-09-28T00:00:00.000Z',
        },
        streamId: `project:${PROJECT_ID}`,
      });
    };
    // A cache from an earlier attach by another (now revoked) device.
    writeFileSync(
      join(projectRoot, '.cleo', 'nexus-link.json'),
      JSON.stringify({
        version: 1,
        links: {
          [API]: {
            apiUrl: API,
            localProjectId: PROJECT_ID,
            remoteProjectId: PROJECT_ID,
            organizationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
            label: 'proj',
            streamId: `project:${PROJECT_ID}`,
            linkedAt: '2026-09-30T00:00:00.000Z',
            replicaId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61',
            nexusDeviceId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62',
            attachedAt: '2026-09-30T00:00:00.000Z',
          },
        },
      }),
    );
    const result = await linkProjectToNexus({
      apiUrl: API,
      store: sessions,
      deviceStore: devices,
      projectRoot,
      label: 'proj',
      fetch: fetchImpl,
      cliVersion: '2026.10.0',
      replicaBinder: {
        ensure: async () => ({ replicaId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60' }),
        rebindReenrolled: async () => {
          throw new Error('not expected');
        },
      },
    });
    expect(result.replica).toBeNull();
    expect(result.warnings.join('\n')).toMatch(
      /E_NEXUS_REPLICA_COPIED.*cleo project link --rebind/,
    );
    expect(readFileSync(result.linkPath, 'utf8')).toContain(PROJECT_ID);
    expect(result.attachError?.code).toBe('E_NEXUS_REPLICA_COPIED');
    expect(result.link.replicaId).toBeUndefined();
    const file = JSON.parse(readFileSync(result.linkPath, 'utf8')) as {
      links: Record<string, Record<string, string | null>>;
    };
    expect(file.links[API]?.['replicaId']).toBeNull();
    expect(file.links[API]?.['nexusDeviceId']).toBeNull();
  });
});

// ---------- security review of #1759 (M1, M2, L2, L3, L4, L7) ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER2 = '0198a1b2-0000-7000-8000-0000000000bb';

async function seedEntry(userId: string, deviceId: string): Promise<string> {
  const token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  await devices.update((tx) => {
    tx.set(
      API,
      userId,
      applyEnrolment(
        tx.get(API, userId),
        new NexusDeviceEnrolment({
          deviceId,
          keys: keyPairs(),
          credential: {
            credentialId: serverUuid(),
            token,
            profile: 'device',
            scopes: ['account:read'],
            createdAt: new Date().toISOString(),
          },
        }),
      ),
    );
  });
  return token;
}

describe('review M1: the upgrade intent never goes stale under a live owner', () => {
  it('a live owner past E1 timeout is not taken over: one E1 on one exempt session', async () => {
    await seedV1Session();
    // Staleness (E2 + E1 timeouts + margin = 11 s) is judged on an injected
    // clock that only A's simulated work advances: A runs 5.5 s past the E1
    // timeout, then 1 s more, so its intent is live whatever the machine's
    // load. The real timeouts are wide enough that no call aborts (T12910).
    let t = Date.parse('2026-10-01T00:00:00.000Z');
    const opts = flow({
      enrolTimeoutMs: 5000,
      whoamiTimeoutMs: 5000,
      intentMarginMs: 1000,
      upgradeWaitMs: 60_000,
      now: () => new Date(t),
    });
    const aInWhoami = deferred();
    let first = true;
    server.beforeWhoami = async () => {
      if (first) {
        first = false;
        t += 5500;
        aInWhoami.resolve();
        await sleep(30);
      }
    };
    server.beforeEnrol = async () => {
      t += 1000;
      await sleep(30);
      return undefined;
    };
    const a = upgradeNexusSession(opts).then(
      (r) => r,
      (e: Error) => e,
    );
    await aInWhoami.promise;
    const b = upgradeNexusSession(opts).then(
      (r) => r,
      (e: Error) => e,
    );
    const [ra, rb] = await Promise.all([a, b]);
    expect(server.count('/v1/devices/enroll')).toBe(1);
    expect(ra).not.toBeInstanceOf(Error);
    expect(rb).not.toBeInstanceOf(Error);
  });

  it('refreshes startedAt with an owner CAS right before E1', async () => {
    await seedV1Session();
    let atWhoami: string | null = null;
    let atEnrol: string | null = null;
    const read = async () =>
      (await devices.get(API, USER))?.unseal().enrolIntent?.startedAt ?? null;
    server.beforeWhoami = async () => {
      if (atWhoami === null) atWhoami = await read();
      await sleep(20);
    };
    server.beforeEnrol = async () => {
      atEnrol = await read();
      return undefined;
    };
    await upgradeNexusSession(flow());
    expect(atWhoami).not.toBeNull();
    expect(atEnrol).not.toBeNull();
    expect(Date.parse(atEnrol ?? '')).toBeGreaterThan(Date.parse(atWhoami ?? ''));
  });

  it('waits on a live LOGIN intent too while a v1 session exists (no E1, no E2)', async () => {
    await seedV1Session();
    const deviceId = '0198a1b2-0000-7000-8000-00000000abcf';
    await devices.update((tx) => {
      tx.set(
        API,
        USER,
        applyEnrolIntent(null, {
          deviceId,
          keys: keyPairs(),
          intent: {
            deviceId,
            kind: 'login',
            owner: 'd'.repeat(32),
            startedAt: new Date().toISOString(),
          },
        }),
      );
    });
    await accountError(upgradeNexusSession(flow({ upgradeWaitMs: 150 })), 'E_NEXUS_BUSY');
    expect(server.count('/v1/devices/enroll')).toBe(0);
    expect(server.count('/v1/whoami')).toBe(0);
  });
});

describe('review M2(b): credential-revoked by re-enrolment', () => {
  it('maps revokedReason reenrolled to a login-required error, not COMPROMISED', () => {
    const mapped = nexusApiErrorToAccountError(
      new NexusError('E_UNAUTHENTICATED', 'm', 401, 'r', {
        reason: 'credential-revoked',
        revokedReason: 'reenrolled',
      }),
    );
    expect((mapped as NexusAccountError).code).toBe('E_NEXUS_NOT_SIGNED_IN');
    expect((mapped as NexusAccountError).fix).toContain('cleo login nexus');
    expect(mapped.message).not.toContain('possibly used');
  });
});

describe('review L2: one account per origin, or an explicit user', () => {
  it('refuses when several accounts hold a credential on the origin, and lists them', async () => {
    await seedEntry(USER, '0198a1b2-0000-7000-8000-0000000000c1');
    await seedEntry(USER2, '0198a1b2-0000-7000-8000-0000000000c2');
    const err = await accountError(
      ensureNexusDeviceCredential(flow()),
      'E_NEXUS_ACCOUNT_AMBIGUOUS',
    );
    expect(err.message).toContain(USER);
    expect(err.message).toContain(USER2);
  });

  it('an explicit user picks that account', async () => {
    await seedEntry(USER, '0198a1b2-0000-7000-8000-0000000000c1');
    const token2 = await seedEntry(USER2, '0198a1b2-0000-7000-8000-0000000000c2');
    const handle = await ensureNexusDeviceCredential(flow({ userId: USER2 }));
    expect(handle.device.currentBearer()).toBe(token2);
  });
});

describe("review L3: step 7 never retires another device's credential", () => {
  it('refuses when the identity changed between steps 5 and 7, leaving the other device intact', async () => {
    const other = '0198a1b2-0000-7000-8000-0000000000d1';
    let otherToken = '';
    server.afterEnrol = async (n) => {
      if (n === 1) otherToken = await seedEntry(USER, other);
      return undefined;
    };
    await accountError(loginToNexusDevice(flow()), 'E_NEXUS_BUSY');
    const entry = (await devices.get(API, USER))?.unseal();
    expect(entry?.deviceId).toBe(other);
    expect(entry?.current?.token).toBe(otherToken);
    expect(entry?.retired ?? []).toEqual([]);
  });
});

describe('review L4: a busy v1 file maps to E_NEXUS_BUSY', () => {
  it('an ELOCKED while removing the leftover session is E_NEXUS_BUSY', async () => {
    await loginToNexusDevice(flow());
    await seedV1Session(false);
    const locked: NexusTokenStore = {
      location: sessions.location,
      get: (u) => sessions.get(u),
      put: (u, v) => sessions.put(u, v),
      list: () => sessions.list(),
      delete: async () => {
        throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
      },
    };
    await accountError(upgradeNexusSession(flow({ store: locked })), 'E_NEXUS_BUSY');
  });
});

describe('review L7: guarded key material', () => {
  it('guardNexusDeviceSecrets hides private keys from inspect and JSON', () => {
    const keys = keyPairs();
    const guarded = guardNexusDeviceSecrets({ deviceId: 'x', keys });
    const priv = keys.signing.privateKey;
    expect(inspect(guarded, { depth: 10 })).not.toContain(priv);
    expect(JSON.stringify(guarded)).not.toContain(priv);
  });
});

describe('re-check P5: a parked candidate is always probed, even with no current', () => {
  /** A logged-in entry whose current is dropped and a candidate parked instead. */
  async function parkOnly(): Promise<{ candidateToken: string; candidateId: string }> {
    await loginToNexusDevice(flow());
    const cred = server.creds[0];
    if (!cred) throw new Error('no credential');
    await devices.update((tx) => {
      const entry = tx.get(API, USER);
      if (!entry?.current) throw new Error('no entry');
      const current = entry.current;
      tx.set(
        API,
        USER,
        applySetRaceCandidate(applyDropCurrent(entry, current.credentialId), {
          credentialId: current.credentialId,
          token: current.token,
          profile: current.profile,
          scopes: current.scopes,
          createdAt: current.createdAt,
        }),
      );
    });
    return { candidateToken: cred.token, candidateId: cred.id };
  }

  it('drops a candidate the server refuses (401), never promoting it', async () => {
    await parkOnly();
    for (const c of server.creds) c.live = false;
    const before = server.count('/v1/whoami');
    await accountError(
      ensureNexusDeviceCredential(flow({ userId: USER })),
      'E_NEXUS_NOT_SIGNED_IN',
    );
    expect(server.count('/v1/whoami')).toBe(before + 1);
    const entry = (await devices.get(API, USER))?.unseal();
    expect(entry?.current ?? null).toBeNull();
    expect(entry?.raceCandidate ?? null).toBeNull();
  });

  it('promotes a candidate only on 200', async () => {
    const { candidateToken } = await parkOnly();
    const before = server.count('/v1/whoami');
    const handle = await ensureNexusDeviceCredential(flow({ userId: USER }));
    expect(server.count('/v1/whoami')).toBe(before + 1);
    expect(handle.device.currentBearer()).toBe(candidateToken);
  });

  it('keeps a candidate the server cannot confirm (5xx), and does not promote it', async () => {
    const { candidateToken } = await parkOnly();
    server.whoamiDeviceStatus = 503;
    await accountError(ensureNexusDeviceCredential(flow({ userId: USER })), 'E_NEXUS_UNREACHABLE');
    const entry = (await devices.get(API, USER))?.unseal();
    expect(entry?.current ?? null).toBeNull();
    expect(entry?.raceCandidate?.token).toBe(candidateToken);
  });
});
