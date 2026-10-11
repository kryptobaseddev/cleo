/**
 * The cloud presence refresh during normal CLI use (T13289): at most once an
 * hour per project, only for a replica this device attached, best-effort and
 * never throwing, with the same path-free body as the attach. Everything runs
 * against a sandboxed CLEO home and project, a stubbed `fetch` and an
 * in-memory device entry; nothing touches the network.
 *
 * @task T13289
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { SealedNexusDevice } from '../nexus-device.js';
import {
  NEXUS_PRESENCE_REFRESH_ENV,
  NEXUS_PRESENCE_REFRESH_INTERVAL_MS,
  refreshProjectPresence,
  startProjectPresenceRefresh,
} from '../nexus-presence-refresh.js';

const API = 'https://nexus.example.test';
const USER = 'user-1';
const DEVICE = '01929a3e-7f00-7000-8000-0000000000d1';
const OTHER_DEVICE = '01929a3e-7f00-7000-8000-0000000000d2';
const CREDENTIAL = '01929a3e-7f00-7000-8000-0000000000c1';
const REMOTE = 'proj-remote-1';
const REPLICA = '01929a3e-7f00-7000-8000-0000000000a1';

let base: string;
let home: string;
let projectRoot: string;
let token: string;
let savedCleoDir: string | undefined;

function device(deviceId: string = DEVICE): SealedNexusDevice {
  const at = new Date('2026-10-01T00:00:00.000Z').toISOString();
  return new SealedNexusDevice(new URL(API).origin, USER, {
    deviceId,
    createdAt: at,
    keys: null,
    current: { credentialId: CREDENTIAL, token, profile: 'device', scopes: [], createdAt: at },
    pending: null,
    pendingSignOut: null,
    pendingRevoke: null,
  });
}

function writeLink(fields: Record<string, unknown> = {}): void {
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.cleo', 'nexus-link.json'),
    JSON.stringify({
      version: 1,
      links: {
        [new URL(API).origin]: {
          apiUrl: API,
          localProjectId: 'local-1',
          remoteProjectId: REMOTE,
          organizationId: 'org-1',
          label: 'p',
          streamId: 'project:p',
          linkedAt: '2026-10-01T00:00:00.000Z',
          replicaId: REPLICA,
          nexusDeviceId: DEVICE,
          ...fields,
        },
      },
    }),
  );
}

function okFetch() {
  return vi.fn(
    async (_input: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ success: true, data: { presenceAt: '2026-10-05T12:00:00.000Z' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
}

const OTHER_API = 'https://other.example.test';

/** The project linked to two Nexus origins from this device; returns the second origin's device. */
function linkTwoOrigins(): { otherApi: string; otherDevice: SealedNexusDevice } {
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  const entry = (apiUrl: string) => ({
    apiUrl,
    localProjectId: 'local-1',
    remoteProjectId: REMOTE,
    organizationId: 'org-1',
    label: 'p',
    streamId: 'project:p',
    linkedAt: '2026-10-01T00:00:00.000Z',
    replicaId: REPLICA,
    nexusDeviceId: DEVICE,
  });
  writeFileSync(
    join(projectRoot, '.cleo', 'nexus-link.json'),
    JSON.stringify({
      version: 1,
      links: { [new URL(OTHER_API).origin]: entry(OTHER_API), [new URL(API).origin]: entry(API) },
    }),
  );
  const at = new Date('2026-10-01T00:00:00.000Z').toISOString();
  const otherDevice = new SealedNexusDevice(new URL(OTHER_API).origin, USER, {
    deviceId: DEVICE,
    createdAt: at,
    keys: null,
    current: { credentialId: CREDENTIAL, token, profile: 'device', scopes: [], createdAt: at },
    pending: null,
    pendingSignOut: null,
    pendingRevoke: null,
  });
  return { otherApi: OTHER_API, otherDevice };
}

const T0 = new Date('2026-10-05T12:00:00.000Z');
const run = (extra: Partial<Parameters<typeof refreshProjectPresence>[0]> = {}) =>
  refreshProjectPresence({
    projectRoot,
    cliVersion: '2026.10.5',
    cleoHome: home,
    now: () => T0,
    deviceStore: { list: async () => [device()] },
    env: {},
    ...extra,
  });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cleo-presence-refresh-'));
  home = join(base, 'home');
  projectRoot = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  savedCleoDir = process.env['CLEO_DIR'];
  process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
});

afterEach(() => {
  if (savedCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = savedCleoDir;
  rmSync(base, { recursive: true, force: true });
});

describe('refreshProjectPresence (T13289)', () => {
  it("sends the attached replica's path-free presence with this device's credential", async () => {
    writeLink();
    const fetch = okFetch();
    expect(await run({ fetch })).toBe('sent');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/v1/projects/${REMOTE}/replicas/${REPLICA}/presence`);
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(String(init?.body)).not.toContain(projectRoot);
  });

  it('is throttled to once an hour per project, then sends again', async () => {
    writeLink();
    const fetch = okFetch();
    expect(await run({ fetch })).toBe('sent');
    const later = new Date(T0.getTime() + NEXUS_PRESENCE_REFRESH_INTERVAL_MS - 60_000);
    expect(await run({ fetch, now: () => later })).toBe('throttled');
    expect(fetch).toHaveBeenCalledTimes(1);
    const due = new Date(T0.getTime() + NEXUS_PRESENCE_REFRESH_INTERVAL_MS + 60_000);
    expect(await run({ fetch, now: () => due })).toBe('sent');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for an unlinked project, and leaves no stamp', async () => {
    const fetch = okFetch();
    expect(await run({ fetch })).toBe('not-linked');
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'nexus-presence'))).toBe(false);
  });

  it('sends nothing for a link attached from another device', async () => {
    writeLink({ nexusDeviceId: OTHER_DEVICE });
    const fetch = okFetch();
    expect(await run({ fetch })).toBe('no-credential');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends nothing for a link with no replica attached yet', async () => {
    writeLink({ replicaId: null, nexusDeviceId: null });
    const fetch = okFetch();
    expect(await run({ fetch })).toBe('not-linked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends nothing for a link whose replica is not attached, even with a device id', async () => {
    writeLink({ replicaId: null });
    const fetch = okFetch();
    expect(await run({ fetch })).toBe('not-linked');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('one origin failing does not stop the other from being refreshed', async () => {
    const { otherApi, otherDevice } = linkTwoOrigins();
    const ok = okFetch();
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith(otherApi)) throw new Error('other origin down');
      return ok(input, init);
    });
    expect(await run({ fetch, deviceStore: { list: async () => [otherDevice, device()] } })).toBe(
      'sent',
    );
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('sends to every origin at once, so teardown waits one timeout at most (T13308)', async () => {
    const { otherDevice } = linkTwoOrigins();
    let inFlight = 0;
    let most = 0;
    const ok = okFetch();
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return ok(input, init);
    });
    expect(await run({ fetch, deviceStore: { list: async () => [otherDevice, device()] } })).toBe(
      'sent',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(most).toBe(2);
  });

  it('every origin failing is failed, after trying each once', async () => {
    const { otherDevice } = linkTwoOrigins();
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(
      await run({ fetch: down, deviceStore: { list: async () => [otherDevice, device()] } }),
    ).toBe('failed');
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('a failing network is an outcome, never a throw, and is retried an hour later', async () => {
    writeLink();
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await run({ fetch })).toBe('failed');
    expect(await run({ fetch })).toBe('throttled');
  });

  it('is off with the environment switch or without device credentials', async () => {
    writeLink();
    const fetch = okFetch();
    expect(await run({ fetch, env: { [NEXUS_PRESENCE_REFRESH_ENV]: '1' } })).toBe('disabled');
    expect(await run({ fetch, env: { CLEO_NEXUS_DEVICE: '0' } })).toBe('disabled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts in the background without awaiting, and the background registry drains it', async () => {
    writeLink();
    const fetch = okFetch();
    const returned = startProjectPresenceRefresh({
      projectRoot,
      cliVersion: '2026.10.5',
      cleoHome: home,
      now: () => T0,
      deviceStore: { list: async () => [device()] },
      env: {},
      fetch,
    });
    expect(returned).toBeUndefined();
    await awaitBackgroundOps();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
