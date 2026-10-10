/**
 * `cleo cloud status|whoami|devices|projects` against a mocked Nexus API
 * (cleo-nexus device contract v2.15 §4.0.3, §4.0.4, §4.2 E2/E3/E5/E13/E14/E15,
 * §4.4). Every test uses its own temp CLEO home and project; nothing touches
 * the real ones, and no request leaves the process.
 *
 * @task T12871
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEd25519, generateX25519 } from '../crypto.js';
import type { FetchLike } from '../http.js';
import { NexusError } from '../http.js';
import { NexusAccountError } from '../nexus-auth.js';
import {
  listNexusCloudDevices,
  listNexusCloudProjects,
  nexusCloudWhoami,
  showNexusCloudProject,
} from '../nexus-cloud.js';
import {
  getNexusCloudStatus,
  NexusCloudOfflineError,
  nexusStatusVerdict,
  readNexusLocalReplicaId,
  W_NEXUS_NO_REPLICA,
  W_NEXUS_NOT_LINKED_LOCALLY,
  W_NEXUS_REPLICA_UNREADABLE,
  W_NEXUS_STATUS_COMPOSED,
  W_NEXUS_STATUS_HOLDERS,
} from '../nexus-cloud-status.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  applyEnrolment,
  NEXUS_DEVICE_ENV,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '../nexus-device.js';
import { nexusApiErrorToAccountError } from '../nexus-enrol.js';

const API = 'https://api.nexus.test';
const USER = '0198a1b2-0000-7000-8000-0000000000aa';
const DEVICE = '0198a1b2-0000-7000-8000-0000000000d1';
const OTHER_DEVICE = '0198a1b2-0000-7000-8000-0000000000d2';
const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const REMOTE_PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99';
const REPLICA = '0198a1b2-0000-7000-8000-0000000000e1';
const ORG = '0198a1b2-0000-7000-8000-0000000000f1';
const NOW = '2026-09-30T12:00:00.000Z';
const GLOBAL_REPLICA = '0198a1b2-0000-7000-8000-0000000000e7';
const OTHER_GLOBAL_REPLICA = '0198a1b2-0000-7000-8000-0000000000e8';
const THIRD_GLOBAL_REPLICA = '0198a1b2-0000-7000-8000-0000000000e9';

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
  });
}

function ok(data: object): Response {
  return json(200, { success: true, data, meta: { requestId: 'r' } });
}

function fail(status: number, code: string, details?: Record<string, string>): Response {
  return json(status, {
    success: false,
    error: {
      code,
      message: `${code} from server`,
      requestId: 'r',
      ...(details ? { details } : {}),
    },
  });
}

interface Call {
  method: string;
  url: URL;
  auth: string;
}

type Handler = (url: URL) => Response | Promise<Response>;

/** A routing mock: `routes[pathname]` answers; anything else is the server's 404. */
function mockServer(routes: Record<string, Handler>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers).get('authorization') ?? '',
    });
    const handler = routes[url.pathname];
    return handler ? handler(url) : fail(404, 'E_NOT_FOUND');
  };
  return { fetch, calls };
}

const deviceView = {
  deviceId: DEVICE,
  name: 'laptop',
  platform: 'darwin',
  arch: 'arm64',
  cliVersion: '2026.9.99',
  createdAt: NOW,
  lastSeenAt: null,
  state: 'active',
  profile: 'device',
  current: true,
};

const whoami = {
  serverTime: NOW,
  user: { id: USER, email: 'dev@example.test', name: 'Dev' },
  organizations: [{ id: ORG, name: 'Personal', slug: 'personal', role: 'owner', personal: true }],
  credential: {
    kind: 'device',
    credentialId: '0198a1b2-0000-7000-8000-0000000000c1',
    profile: 'device',
    scopes: ['account:read', 'devices:read', 'projects:read'],
    createdAt: NOW,
    lastUsedAt: null,
    idleExpiresAt: NOW,
  },
  device: deviceView,
};

function replicaRow(replicaId: string, deviceId = DEVICE): Record<string, string | null> {
  return {
    projectId: PROJECT_ID,
    replicaId,
    deviceId,
    deviceName: 'laptop',
    deviceState: 'active',
    attachedAt: NOW,
    lastSyncAt: null,
    presence: null,
    presenceAt: NOW,
  };
}

const projectDetail = {
  project: {
    projectId: PROJECT_ID,
    label: 'proj',
    encryptedName: null,
    remoteUrl: null,
    organizationId: ORG,
    createdByUserId: USER,
    createdAt: NOW,
    organizationName: 'Personal',
    deletedAt: null,
  },
  role: 'owner',
  canTrash: true,
  openConflicts: 0,
  replicas: [replicaRow(REPLICA)],
  devices: { active: 1, total: 1 },
  replicaCount: 1,
  lastSyncAt: null,
  truncated: false,
  stream: { streamId: `project:${PROJECT_ID}`, headSeq: 7, headCheckpointId: null },
  checkpoints: [],
};

let base: string;
let home: string;
let projectRoot: string;
let devices: NexusDeviceStore;
let sessions: FileNexusTokenStore;
let savedFlag: string | undefined;
let savedHome: string | undefined;
let savedCleoDir: string | undefined;
let token: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'nexus-cloud-'));
  home = join(base, 'cleo-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  projectRoot = join(base, 'proj');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  writeFileSync(join(projectRoot, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
  savedFlag = process.env[NEXUS_DEVICE_ENV];
  savedHome = process.env['CLEO_HOME'];
  savedCleoDir = process.env['CLEO_DIR'];
  process.env[NEXUS_DEVICE_ENV] = '1';
  process.env['CLEO_HOME'] = home;
  // The project's .cleo/ (the test harness pins CLEO_DIR elsewhere otherwise).
  process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
  devices = new NexusDeviceStore(join(home, 'nexus-device.json'), {
    cleoHome: home,
    lockWaitMs: 10_000,
  });
  sessions = new FileNexusTokenStore(join(home, 'nexus-credentials.json'));
  token = '';
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[NEXUS_DEVICE_ENV];
  else process.env[NEXUS_DEVICE_ENV] = savedFlag;
  if (savedHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedHome;
  if (savedCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = savedCleoDir;
  rmSync(base, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  const enc = generateX25519();
  const sig = generateEd25519();
  await devices.update((tx) => {
    tx.set(
      API,
      USER,
      applyEnrolment(
        tx.get(API, USER),
        new NexusDeviceEnrolment({
          deviceId: DEVICE,
          keys: {
            encryption: {
              publicKey: enc.publicKey.toString('base64'),
              privateKey: enc.privateKey.toString('base64'),
            },
            signing: {
              publicKey: sig.publicKey.toString('base64'),
              privateKey: sig.privateKey.toString('base64'),
            },
          },
          credential: {
            credentialId: '0198a1b2-0000-7000-8000-0000000000c1',
            token,
            profile: 'device',
            scopes: ['account:read', 'devices:read', 'projects:read'],
            createdAt: NOW,
          },
        }),
      ),
    );
  });
}

function linkProject(remoteProjectId = PROJECT_ID): void {
  writeFileSync(
    join(projectRoot, '.cleo', 'nexus-link.json'),
    JSON.stringify({
      version: 1,
      links: {
        [API]: {
          apiUrl: API,
          localProjectId: PROJECT_ID,
          remoteProjectId,
          organizationId: ORG,
          label: 'proj',
          streamId: `project:${PROJECT_ID}`,
          linkedAt: NOW,
        },
      },
    }),
  );
}

/** A project store with one active replica row (the S1 `_sync_replica` shape). */
function bindReplica(): void {
  const db = new DatabaseSync(join(projectRoot, '.cleo', 'cleo.db'));
  db.exec(
    `CREATE TABLE _sync_replica (replica_id TEXT PRIMARY KEY, scope TEXT, nonce TEXT, device_id TEXT,
       file_ino INTEGER, file_birth INTEGER, bound_at TEXT, bound_why TEXT, retired_at TEXT, successor TEXT)`,
  );
  db.prepare(
    `INSERT INTO _sync_replica VALUES (?, 'project', 'n', 'host', 1, NULL, ?, 'first-open', NULL, NULL)`,
  ).run(REPLICA, NOW);
  db.close();
}

function opts(fetch: FetchLike, extra: Record<string, string | number | (() => Date)> = {}) {
  return { apiUrl: API, fetch, deviceStore: devices, store: sessions, projectRoot, ...extra };
}

async function failure(p: Promise<object>): Promise<NexusAccountError> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(NexusAccountError);
  return err as NexusAccountError;
}

describe('cloud whoami (E2)', () => {
  it('returns the caller with the device credential and never the token', async () => {
    await signIn();
    const server = mockServer({ '/v1/whoami': () => ok(whoami) });
    const result = await nexusCloudWhoami(opts(server.fetch));
    expect(result.apiUrl).toBe(API);
    expect(result.credential.profile).toBe('device');
    expect(result.device?.deviceId).toBe(DEVICE);
    expect(server.calls.every((c) => c.auth === `Bearer ${token}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('cnx_d1_');
  });

  it('refuses with E_NEXUS_DEVICE_REQUIRED when CLEO_NEXUS_DEVICE=0', async () => {
    process.env[NEXUS_DEVICE_ENV] = '0';
    const server = mockServer({});
    const err = await failure(nexusCloudWhoami(opts(server.fetch)));
    expect(err.code).toBe('E_NEXUS_DEVICE_REQUIRED');
    expect(server.calls).toHaveLength(0);
  });

  it('is E_NEXUS_NOT_SIGNED_IN with no credential', async () => {
    const err = await failure(nexusCloudWhoami(opts(mockServer({}).fetch)));
    expect(err.code).toBe('E_NEXUS_NOT_SIGNED_IN');
  });
});

describe('cloud devices (E5)', () => {
  it('follows nextCursor across pages, sends limit and state, and reports truncation', async () => {
    await signIn();
    const server = mockServer({
      '/v1/devices': (url) =>
        url.searchParams.get('cursor') === null
          ? ok({ devices: [deviceView], nextCursor: 'c1', truncated: false })
          : ok({
              devices: [{ ...deviceView, deviceId: OTHER_DEVICE, current: false }],
              nextCursor: null,
              truncated: true,
            }),
    });
    const result = await listNexusCloudDevices({ ...opts(server.fetch), state: 'all' });
    expect(result.devices.map((d) => d.deviceId)).toEqual([DEVICE, OTHER_DEVICE]);
    expect(result.count).toBe(2);
    expect(result.paging).toEqual({ pages: 2, truncated: true, pageLimitReached: false });
    expect(result.warnings.map((w) => w.code)).toContain('W_NEXUS_TRUNCATED');
    expect(server.calls[0]?.url.searchParams.get('limit')).toBe('200');
    expect(server.calls[0]?.url.searchParams.get('state')).toBe('all');
    expect(server.calls[1]?.url.searchParams.get('cursor')).toBe('c1');
  });

  it('maps a 403 insufficient-scope per §4.0.4', async () => {
    await signIn();
    const server = mockServer({
      '/v1/devices': () =>
        fail(403, 'E_FORBIDDEN', { reason: 'insufficient-scope', requiredScope: 'devices:read' }),
    });
    const err = await failure(listNexusCloudDevices(opts(server.fetch)));
    expect(err.code).toBe('E_NEXUS_INSUFFICIENT_SCOPE');
    expect(err.message).toContain('devices:read');
  });
});

describe('cloud projects (E13, E14, E15)', () => {
  const item = {
    ...projectDetail.project,
    role: 'owner',
    streamId: `project:${PROJECT_ID}`,
    headSeq: 7,
    headCheckpointId: null,
    maxSchemaVersion: null,
    openConflicts: 0,
    replicas: [replicaRow(REPLICA)],
    devices: { active: 1, total: 1 },
    replicaCount: 1,
    lastSyncAt: null,
    replicasTruncated: false,
  };

  it('stops at the page budget and says so', async () => {
    await signIn();
    const server = mockServer({
      '/v1/projects': () =>
        ok({ projects: [item], nextCursor: 'more', projectsTruncated: false, truncated: false }),
    });
    const result = await listNexusCloudProjects({
      ...opts(server.fetch, { maxPages: 1 }),
      organizationId: ORG,
    });
    expect(result.count).toBe(1);
    expect(result.paging.pageLimitReached).toBe(true);
    expect(result.paging.projectsTruncated).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain('W_NEXUS_PAGE_LIMIT');
    expect(server.calls[0]?.url.searchParams.get('organizationId')).toBe(ORG);
  });

  it('show defaults to the current project and reads the full replica list from E15 when E14 cut it', async () => {
    await signIn();
    const server = mockServer({
      [`/v1/projects/${PROJECT_ID}`]: () => ok({ ...projectDetail, truncated: true }),
      [`/v1/projects/${PROJECT_ID}/replicas`]: (url) =>
        url.searchParams.get('cursor') === null
          ? ok({ replicas: [replicaRow(REPLICA)], nextCursor: 'r2', truncated: false })
          : ok({ replicas: [replicaRow(OTHER_DEVICE)], nextCursor: null, truncated: false }),
    });
    const result = await showNexusCloudProject(opts(server.fetch));
    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.currentProject).toBe(true);
    expect(result.devices.active).toBe(1);
    expect(result.replicas).toHaveLength(2);
    expect(result.replicaPaging.pages).toBe(2);
  });

  it('show without an id outside a project is E_NEXUS_NOT_A_PROJECT, before any request', async () => {
    await signIn();
    const server = mockServer({});
    const outside = join(base, 'empty');
    mkdirSync(outside);
    const err = await failure(
      showNexusCloudProject({ ...opts(server.fetch), projectRoot: outside }),
    );
    expect(err.code).toBe('E_NEXUS_NOT_A_PROJECT');
    expect(server.calls).toHaveLength(0);
  });

  it('show of an unknown project is a mapped request failure', async () => {
    await signIn();
    const err = await failure(
      showNexusCloudProject({ ...opts(mockServer({}).fetch), projectId: 'nope' }),
    );
    expect(err.code).toBe('E_NEXUS_REQUEST_FAILED');
  });
});

describe('cloud status (E3, §4.4)', () => {
  const remote = {
    serverTime: NOW,
    apiVersion: 'v1',
    user: whoami.user,
    credential: whoami.credential,
    device: deviceView,
    project: {
      projectId: PROJECT_ID,
      registered: true,
      organizationId: ORG,
      organizationName: 'Personal',
      role: 'owner',
    },
    replica: {
      replicaId: REPLICA,
      attached: true,
      attachedElsewhere: false,
      attachedAt: NOW,
      lastSyncAt: null,
      presenceAt: NOW,
      lastReplicaSeq: null,
    },
    stream: {
      streamId: `project:${PROJECT_ID}`,
      headSeq: 7,
      headCheckpointId: null,
      openConflicts: 0,
      devices: { active: 2, total: 3 },
    },
    checks: [
      { id: 'credential.valid', ok: true, required: true, detail: '' },
      { id: 'device.registered', ok: true, required: true, detail: '' },
      { id: 'device.active', ok: true, required: true, detail: '' },
      { id: 'project.registered', ok: true, required: true, detail: '' },
      { id: 'replica.attached', ok: true, required: true, detail: '' },
    ],
    verdict: 'ok',
  };

  it('is not-signed-in with no credential, and makes no network call', async () => {
    const server = mockServer({});
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.verdict).toBe('not-signed-in');
    expect(result.remote).toBeNull();
    expect(result.summary.signedIn).toBe(false);
    expect(result.local.credentialsPath).toBe(devices.location);
    expect(server.calls).toHaveLength(0);
  });

  it('lists the devices holding the project, with fresh or stale presence (T13290)', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const stale = new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString();
    const server = mockServer({
      '/v1/status': () => ok(remote),
      [`/v1/projects/${PROJECT_ID}/replicas`]: () =>
        ok({
          replicas: [
            replicaRow(REPLICA),
            { ...replicaRow('r-other', OTHER_DEVICE), deviceName: 'desk', presenceAt: stale },
          ],
          nextCursor: null,
          truncated: false,
        }),
    });
    const result = await getNexusCloudStatus({ ...opts(server.fetch), now: () => new Date(NOW) });
    expect(result.holders).toEqual([
      {
        deviceId: DEVICE,
        deviceName: 'laptop',
        replicaId: REPLICA,
        presenceAt: NOW,
        fresh: true,
        thisDevice: true,
      },
      {
        deviceId: OTHER_DEVICE,
        deviceName: 'desk',
        replicaId: 'r-other',
        presenceAt: stale,
        fresh: false,
        thisDevice: false,
      },
    ]);
    expect(result.warnings.map((w) => w.code)).not.toContain(W_NEXUS_STATUS_HOLDERS);
  });

  it('a replica list that cannot be read is a warning, never a failure (T13290)', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({ '/v1/status': () => ok(remote) });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.verdict).toBe('ok');
    expect(result.holders).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toContain(W_NEXUS_STATUS_HOLDERS);
  });

  it('reports ok for a linked project with a bound replica, sending projectId and replicaId', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({ '/v1/status': () => ok(remote) });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.verdict).toBe('ok');
    expect(result.summary).toMatchObject({
      signedIn: true,
      registered: true,
      linked: true,
      replicaAttached: true,
      devices: 2,
      headSeq: 7,
      openConflicts: 0,
      lastPresenceAt: NOW,
    });
    expect(result.local).toMatchObject({
      nexusDeviceId: DEVICE,
      profile: 'device',
      projectId: PROJECT_ID,
      replicaId: REPLICA,
    });
    expect(result.local.linkPath).toContain('nexus-link.json');
    const q = server.calls[0]?.url.searchParams;
    expect(q?.get('projectId')).toBe(PROJECT_ID);
    expect(q?.get('replicaId')).toBe(REPLICA);
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('cnx_d1_');
  });

  it('downgrades to not-linked without a local link entry', async () => {
    await signIn();
    bindReplica();
    const server = mockServer({ '/v1/status': () => ok(remote) });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.verdict).toBe('not-linked');
    expect(result.summary.linked).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain(W_NEXUS_NOT_LINKED_LOCALLY);
  });

  it('downgrades to not-linked with no bound replica, and sends no replicaId', async () => {
    await signIn();
    linkProject();
    const server = mockServer({ '/v1/status': () => ok({ ...remote, replica: null }) });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.verdict).toBe('not-linked');
    expect(result.local.replicaId).toBeNull();
    expect(server.calls[0]?.url.searchParams.has('replicaId')).toBe(false);
  });

  it('outside a project asks about the device only', async () => {
    await signIn();
    const outside = join(base, 'empty');
    mkdirSync(outside);
    const server = mockServer({
      '/v1/status': () => ok({ ...remote, project: null, replica: null, stream: null }),
    });
    const result = await getNexusCloudStatus({ ...opts(server.fetch), projectRoot: outside });
    expect(result.verdict).toBe('ok');
    expect(result.local.projectId).toBeNull();
    expect(server.calls[0]?.url.search).toBe('');
  });

  it('composes the status from E2 and E14 when the server has no E3', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({
      '/v1/whoami': () => ok(whoami),
      [`/v1/projects/${PROJECT_ID}`]: () => ok(projectDetail),
    });
    const result = await getNexusCloudStatus(opts(server.fetch, { now: () => new Date(NOW) }));
    expect(result.warnings.map((w) => w.code)).toContain(W_NEXUS_STATUS_COMPOSED);
    expect(result.verdict).toBe('ok');
    expect(result.summary.replicaAttached).toBe(true);
    expect(result.summary.devices).toBe(1);
    expect(result.remote?.checks.map((c) => c.id)).toEqual([
      'credential.valid',
      'device.registered',
      'device.active',
      'project.registered',
      'project.writable',
      'replica.attached',
      'presence.fresh',
      'replica.synced',
      'conflicts.none',
    ]);
  });

  it('composed: a replica attached from another device is not-linked', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({
      '/v1/whoami': () => ok(whoami),
      [`/v1/projects/${PROJECT_ID}`]: () =>
        ok({ ...projectDetail, replicas: [replicaRow(REPLICA, OTHER_DEVICE)] }),
    });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.verdict).toBe('not-linked');
    expect(result.remote?.replica?.attachedElsewhere).toBe(true);
  });

  it('offline is E_NEXUS_UNREACHABLE carrying the local facts', async () => {
    await signIn();
    linkProject();
    const fetch: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const err = await failure(getNexusCloudStatus(opts(fetch)));
    expect(err).toBeInstanceOf(NexusCloudOfflineError);
    expect(err.code).toBe('E_NEXUS_UNREACHABLE');
    const details = (err as NexusCloudOfflineError).publicDetails;
    expect(details.local.projectId).toBe(PROJECT_ID);
    expect(details.local.signedIn).toBe(true);
    expect(details.summary.headSeq).toBeNull();
    expect(Array.isArray(details.warnings)).toBe(true);
  });

  it('offline keeps the warnings collected before the failure', async () => {
    await signIn();
    linkProject();
    writeFileSync(join(projectRoot, '.cleo', 'cleo.db'), 'this is not a sqlite database');
    const fetch: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const err = await failure(getNexusCloudStatus(opts(fetch)));
    const codes = (err as NexusCloudOfflineError).publicDetails.warnings.map((w) => w.code);
    expect(codes).toContain(W_NEXUS_REPLICA_UNREADABLE);
  });

  it('a revoked device is mapped, not reported as a verdict', async () => {
    await signIn();
    const server = mockServer({
      '/v1/status': () => fail(401, 'E_UNAUTHENTICATED', { reason: 'device-revoked' }),
    });
    const err = await failure(getNexusCloudStatus(opts(server.fetch)));
    expect(err.code).toBe('E_NEXUS_DEVICE_REVOKED');
  });

  it('review M1: an unreadable store is attention, never not-linked, and not reported as unbound', async () => {
    await signIn();
    linkProject();
    writeFileSync(join(projectRoot, '.cleo', 'cleo.db'), 'this is not a sqlite database');
    const server = mockServer({ '/v1/status': () => ok({ ...remote, replica: null }) });
    const result = await getNexusCloudStatus(opts(server.fetch));
    const codes = result.warnings.map((w) => w.code);
    expect(result.local.replicaId).toBeNull();
    expect(result.verdict).toBe('attention');
    expect(codes).toContain(W_NEXUS_REPLICA_UNREADABLE);
    expect(codes).not.toContain(W_NEXUS_NO_REPLICA);
  });

  it('review LOW-1: no -wal and a read-only .cleo directory skips the open (no sidecars)', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const dir = join(projectRoot, '.cleo');
    chmodSync(dir, 0o500);
    try {
      const read = await readNexusLocalReplicaId(projectRoot);
      expect(read.unreadable).toBe(true);
      expect(read.replicaId).toBeNull();
      expect(existsSync(join(dir, 'cleo.db-shm'))).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('review LOW-5: --project naming the local id asks about the linked remote id', async () => {
    await signIn();
    linkProject(REMOTE_PROJECT_ID);
    bindReplica();
    const server = mockServer({ '/v1/status': () => ok(remote) });
    const result = await getNexusCloudStatus({ ...opts(server.fetch), projectId: PROJECT_ID });
    expect(server.calls[0]?.url.searchParams.get('projectId')).toBe(REMOTE_PROJECT_ID);
    expect(server.calls[0]?.url.searchParams.get('replicaId')).toBe(REPLICA);
    expect(result.local.projectId).toBe(REMOTE_PROJECT_ID);
  });

  it('review LOW-3: unknown check ids are dropped, an unknown device state is not active, an unknown verdict is attention', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({
      '/v1/status': () =>
        ok({
          ...remote,
          device: { ...deviceView, state: 'quarantined' },
          checks: [
            ...remote.checks,
            { id: 'device.future', ok: false, required: true, detail: '' },
          ],
          verdict: 'needs-review',
        }),
    });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.remote?.checks.map((c) => c.id)).not.toContain('device.future');
    expect(result.remote?.device?.state).toBe('unknown');
    expect(result.remote?.verdict).toBe('attention');
    expect(result.verdict).toBe('attention');
  });

  it('review LOW-3 (composed): an unknown device state fails device.active', async () => {
    await signIn();
    const outside = join(base, 'empty');
    mkdirSync(outside);
    const server = mockServer({
      '/v1/whoami': () => ok({ ...whoami, device: { ...deviceView, state: 'quarantined' } }),
    });
    const result = await getNexusCloudStatus({ ...opts(server.fetch), projectRoot: outside });
    expect(result.verdict).toBe('not-registered');
  });

  it('adds the global store: attached, its replica and the devices with one', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({
      '/v1/status': () => ok(remote),
      '/v1/account/home/replicas': () =>
        ok({
          replicas: [
            { replicaId: GLOBAL_REPLICA, deviceId: DEVICE, presenceAt: NOW, attachedAt: NOW },
            { replicaId: OTHER_GLOBAL_REPLICA, deviceId: OTHER_DEVICE, presenceAt: null },
            { replicaId: THIRD_GLOBAL_REPLICA, deviceId: OTHER_DEVICE, presenceAt: null },
          ],
        }),
    });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.verdict).toBe('ok');
    expect(result.global).toEqual({
      supported: true,
      attached: true,
      replicaId: GLOBAL_REPLICA,
      presenceAt: NOW,
      devices: 2,
    });
    expect(result.warnings.map((w) => w.code)).not.toContain('W_NEXUS_GLOBAL_NOT_ATTACHED');
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it("warns W_NEXUS_GLOBAL_NOT_ATTACHED when this device's global store is not listed", async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({
      '/v1/status': () => ok(remote),
      '/v1/account/home/replicas': () =>
        ok({ replicas: [{ replicaId: OTHER_GLOBAL_REPLICA, deviceId: OTHER_DEVICE }] }),
    });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.global).toEqual({
      supported: true,
      attached: false,
      replicaId: null,
      presenceAt: null,
      devices: 1,
    });
    const w = result.warnings.find((x) => x.code === 'W_NEXUS_GLOBAL_NOT_ATTACHED');
    expect(w?.message).toContain('cleo login nexus');
    // The global store does not change the project verdict.
    expect(result.verdict).toBe('ok');
  });

  it('reports the global store as unsupported when the server answers 404', async () => {
    await signIn();
    linkProject();
    bindReplica();
    const server = mockServer({ '/v1/status': () => ok(remote) });
    const result = await getNexusCloudStatus(opts(server.fetch));
    expect(result.global).toEqual({
      supported: false,
      attached: false,
      replicaId: null,
      presenceAt: null,
      devices: 0,
    });
    expect(result.warnings.map((w) => w.code)).not.toContain('W_NEXUS_GLOBAL_NOT_ATTACHED');
    expect(result.verdict).toBe('ok');
  });
});

describe('verdict rules (E3)', () => {
  const c = (id: string, okay: boolean, required = true) => ({
    id: id as 'device.active',
    ok: okay,
    required,
    detail: '',
  });
  it('applies the first matching rule', () => {
    expect(nexusStatusVerdict([c('device.active', false), c('project.registered', false)])).toBe(
      'not-registered',
    );
    expect(nexusStatusVerdict([c('project.registered', false)])).toBe('not-linked');
    expect(nexusStatusVerdict([c('conflicts.none', false)])).toBe('attention');
    expect(nexusStatusVerdict([c('presence.fresh', false, false)])).toBe('ok');
  });
});

describe('error mapping table (§4.0.4, contracts)', () => {
  const map = (status: number, code: string, details: Record<string, string>) =>
    nexusApiErrorToAccountError(
      new NexusError(code as 'E_UNAUTHENTICATED', 'server says no', status, 'r', details),
    ) as NexusAccountError;

  it('maps credential-revoked by revokedReason', () => {
    const r = (revokedReason: string) =>
      map(401, 'E_UNAUTHENTICATED', { reason: 'credential-revoked', revokedReason }).code;
    expect(r('reenrolled')).toBe('E_NEXUS_NOT_SIGNED_IN');
    expect(r('signed-out')).toBe('E_NEXUS_NOT_SIGNED_IN');
    expect(r('revoked')).toBe('E_NEXUS_DEVICE_REVOKED');
    expect(r('rotated')).toBe('E_NEXUS_CREDENTIAL_COMPROMISED');
    expect(map(401, 'E_UNAUTHENTICATED', { reason: 'credential-revoked' }).code).toBe(
      'E_NEXUS_CREDENTIAL_COMPROMISED',
    );
  });

  it('maps the other reasons', () => {
    expect(map(401, 'E_UNAUTHENTICATED', { reason: 'session-used' }).code).toBe(
      'E_NEXUS_SESSION_EXPIRED',
    );
    expect(map(401, 'E_UNAUTHENTICATED', { reason: 'something-new' }).code).toBe(
      'E_NEXUS_NOT_SIGNED_IN',
    );
    expect(map(409, 'E_CONFLICT', { reason: 'rotation-conflict' }).code).toBe(
      'E_NEXUS_CREDENTIAL_COMPROMISED',
    );
    const undeclared = map(403, 'E_FORBIDDEN', { reason: 'route-undeclared' });
    expect(undeclared.code).toBe('E_NEXUS_REQUEST_FAILED');
    expect(undeclared.message).toContain('server says no');
    const limit = map(403, 'E_FORBIDDEN', { reason: 'device-limit', remedy: 'server remedy' });
    expect(limit.fix).toBe('server remedy');
    expect(map(429, 'E_RATE_LIMITED', {}).message).toContain('retryable');
  });
});
