/**
 * CLI wiring for the read-only `cleo cloud` commands (T12871): envelopes,
 * operations, exit codes, the offline `details`, and that no token is ever
 * printed. The REAL core flows run against a temp CLEO home and project; only
 * the network is replaced by a stubbed global `fetch`.
 *
 * @task T12871
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519, generateX25519 } from '@cleocode/core/cloud/crypto.js';
import {
  applyEnrolment,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '@cleocode/core/cloud/nexus-device.js';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudProjectShowSummary,
  cloudStatusSummary,
  devicesClause,
} from '../../lib/nexus-cloud-cli.js';
import { cloudCommand } from '../cloud.js';

const API = 'https://api.nexus.test';
const USER = '0198a1b2-0000-7000-8000-0000000000aa';
const DEVICE = '0198a1b2-0000-7000-8000-0000000000d1';
const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = '2026-09-30T12:00:00.000Z';

const mockFetch = vi.fn(async (url: string): Promise<Response> => {
  const path = new URL(url).pathname;
  if (path === '/v1/whoami') {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          user: { id: USER, email: 'dev@example.test', name: 'Dev' },
          organizations: [],
          credential: { kind: 'device', profile: 'device', scopes: ['account:read'] },
          device: { deviceId: DEVICE, name: 'laptop', state: 'active', current: true },
        },
        meta: { requestId: 'r' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  throw new Error('getaddrinfo ENOTFOUND');
});

let base: string;
let token: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'CLEO_HOME',
  'CLEO_DIR',
  'CLEO_ROOT',
  'CLEO_NEXUS_DEVICE',
  'CLEO_NEXUS_API_URL',
  'CLEO_FORMAT',
];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  base = mkdtempSync(join(tmpdir(), 'cloud-cli-'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const project = join(base, 'proj');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  writeFileSync(join(project, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
  process.env['CLEO_HOME'] = home;
  process.env['CLEO_DIR'] = join(project, '.cleo');
  process.env['CLEO_ROOT'] = project;
  process.env['CLEO_NEXUS_DEVICE'] = '1';
  process.env['CLEO_NEXUS_API_URL'] = API;
  process.env['CLEO_FORMAT'] = 'json';
  mockFetch.mockClear();
  vi.stubGlobal('fetch', mockFetch);
  token = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(base, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  const home = process.env['CLEO_HOME'] ?? '';
  const store = new NexusDeviceStore(join(home, 'nexus-device.json'), { cleoHome: home });
  const enc = generateX25519();
  const sig = generateEd25519();
  await store.update((tx) => {
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
            scopes: ['account:read'],
            createdAt: NOW,
          },
        }),
      ),
    );
  });
}

async function sub(name: string): Promise<CommandDef> {
  const subs = cloudCommand.subCommands as Record<string, CommandDef>;
  const found = subs[name];
  if (!found) throw new Error(`no subcommand ${name}`);
  return found;
}

/** Run a subcommand, capturing stdout/stderr; `process.exit` throws `__EXIT_<code>__`. */
async function run(name: string, args: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      err.push(String(s));
      return true;
    }),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never),
  ];
  let exit: string | null = null;
  try {
    const cmd = (await sub(name)) as { run: (ctx: object) => Promise<void> };
    await cmd.run({ args, rawArgs: [], cmd });
  } catch (e) {
    exit = e instanceof Error ? e.message : String(e);
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const line = out.filter((l) => l.trim().startsWith('{')).at(-1) ?? '{}';
  return { envelope: JSON.parse(line), out: out.join(''), err: err.join(''), exit };
}

describe('cleo cloud', () => {
  it('status without a credential: success envelope, verdict not-signed-in, no request', async () => {
    const r = await run('status', {});
    expect(r.exit).toBeNull();
    expect(r.envelope.success).toBe(true);
    expect(r.envelope.data.verdict).toBe('not-signed-in');
    expect(r.envelope.data.local.projectId).toBe(PROJECT_ID);
    expect(r.envelope.meta.operation).toBe('cloud.status');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('status offline: E_NEXUS_UNREACHABLE with the local facts in details, exit 1', async () => {
    await signIn();
    const r = await run('status', {});
    expect(r.exit).toBe('__EXIT_1__');
    expect(r.envelope.success).toBe(false);
    expect(r.envelope.error.codeName).toBe('E_NEXUS_UNREACHABLE');
    expect(r.envelope.error.details.local.nexusDeviceId).toBe(DEVICE);
    expect(r.envelope.error.details.summary.headSeq).toBeNull();
    expect(r.out + r.err).not.toContain(token);
  });

  it('status offline prints the warnings collected before the failure (review LOW-4)', async () => {
    await signIn();
    writeFileSync(join(process.env['CLEO_DIR'] ?? '', 'cleo.db'), 'not a sqlite database');
    const r = await run('status', {});
    expect(r.exit).toBe('__EXIT_1__');
    expect(r.err).toContain('W_NEXUS_REPLICA_UNREADABLE');
    expect(r.envelope.error.details.warnings[0].code).toBe('W_NEXUS_REPLICA_UNREADABLE');
  });

  it('forwards no details from an ordinary error (review LOW-6)', async () => {
    await signIn();
    mockFetch.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'E_FORBIDDEN', message: 'no', requestId: 'r', details: { x: 'y' } },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    );
    const r = await run('whoami', {});
    expect(r.exit).toBe('__EXIT_1__');
    expect(r.envelope.error.details).toBeUndefined();
  });

  it('whoami: envelope with the user, the token never printed', async () => {
    await signIn();
    const r = await run('whoami', {});
    expect(r.exit).toBeNull();
    expect(r.envelope.data.user.email).toBe('dev@example.test');
    expect(r.envelope.meta.operation).toBe('cloud.whoami');
    expect(r.out + r.err).not.toContain('cnx_d1_');
  });

  it('devices --state bogus is a validation failure (exit 6) before any request', async () => {
    await signIn();
    const r = await run('devices', { state: 'bogus' });
    expect(r.exit).toBe('__EXIT_6__');
    expect(r.envelope.error.codeName).toBe('E_VALIDATION');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('projects with an unknown action is a validation failure', async () => {
    const r = await run('projects', { action: 'delete' });
    expect(r.exit).toBe('__EXIT_6__');
    expect(r.envelope.error.codeName).toBe('E_VALIDATION');
  });

  it('refuses with E_NEXUS_DEVICE_REQUIRED when CLEO_NEXUS_DEVICE=0', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = '0';
    const r = await run('status', {});
    expect(r.exit).toBe('__EXIT_6__');
    expect(r.envelope.error.codeName).toBe('E_NEXUS_DEVICE_REQUIRED');
  });
});

describe('cleo cloud conflicts (T12344 PR-6)', () => {
  it('on a store that never applied a stream: no conflicts, a warning, no request', async () => {
    const r = await run('conflicts', {});
    expect(r.exit).toBeNull();
    expect(r.envelope.success).toBe(true);
    expect(r.envelope.meta.operation).toBe('cloud.conflicts');
    expect(r.envelope.data).toMatchObject({ open: 0, total: 0, conflicts: [] });
    expect(r.envelope.data.warnings).toEqual([
      expect.objectContaining({ code: 'W_SYNC_NOT_ENABLED' }),
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lists open conflicts, resolves one by id, and lists every one with --all', async () => {
    const { getDualScopeNativeDb, openDualScopeDb } = await import(
      '@cleocode/core/store/dual-scope-db.js'
    );
    const { ensureSyncSchema } = await import('@cleocode/core/store/sync/schema.js');
    const db = getDualScopeNativeDb(await openDualScopeDb('project', process.env['CLEO_ROOT']));
    ensureSyncSchema(db);
    db.prepare(
      `INSERT INTO _sync_conflict (stream, seq, txn_idx, op_idx, kind, tbl, uid, columns_json,
         rule, resolution, op_hlc, origin, created_at)
       VALUES ('s', 1, 0, 0, 'typed-rule', 'tasks_tasks', 'u1', '["status"]',
         'task.status.absorbing', 'incoming-dropped', 'h', 'r', '2026-10-05T00:00:00.000Z')`,
    ).run();
    const list = await run('conflicts', {});
    expect(list.envelope.data).toMatchObject({ open: 1, total: 1 });
    expect(list.envelope.data.conflicts[0]).toMatchObject({
      id: 1,
      kind: 'typed-rule',
      columns: ['status'],
      rule: 'task.status.absorbing',
      resolvedAt: null,
    });
    const resolved = await run('conflicts', { action: 'resolve', id: '1' });
    expect(resolved.envelope.data).toMatchObject({ id: 1, resolved: true });
    expect((await run('conflicts', { action: 'resolve', id: '1' })).envelope.data.resolved).toBe(
      false,
    );
    expect((await run('conflicts', {})).envelope.data).toMatchObject({
      open: 0,
      total: 1,
      conflicts: [],
    });
    // Counts follow --stream.
    expect((await run('conflicts', { all: true, stream: 'other' })).envelope.data).toMatchObject({
      open: 0,
      total: 0,
    });
    const all = await run('conflicts', { all: true });
    expect(all.envelope.data.conflicts[0].resolvedAt).toEqual(expect.any(String));
  });

  it('resolve without an id is E_VALIDATION', async () => {
    const r = await run('conflicts', { action: 'resolve' });
    expect(r.exit).toMatch(/__EXIT_6__/);
  });
});

describe('retired replica labels (T13109)', () => {
  const retired = [
    {
      replicaId: 'r-2',
      successor: 'r-3',
      retiredAt: '2026-10-03T02:15:00.000Z',
      reason: 'vault-restore',
    },
    {
      replicaId: 'r-1',
      successor: 'r-2',
      retiredAt: '2026-10-03T00:34:00.000Z',
      reason: 'vault-restore',
    },
  ];

  it("status names this store's retired replicas and their successors", () => {
    const line = cloudStatusSummary({
      verdict: 'ok',
      summary: {
        signedIn: true,
        registered: true,
        profile: 'device',
        linked: true,
        replicaAttached: true,
        devices: 2,
        lastPresenceAt: null,
        lastSyncAt: null,
        headSeq: 3,
        openConflicts: 0,
      },
      local: {
        apiUrl: API,
        signedIn: true,
        nexusDeviceId: 'd-1',
        profile: 'device',
        projectId: 'p-1',
        replicaId: 'r-3',
        retiredReplicas: retired,
        linkPath: null,
        credentialsPath: '/tmp/nexus-device.json',
      },
      remote: null,
      warnings: [],
    });
    expect(line).toContain('retired here: r-2 retired → r-3; r-1 retired → r-2');
  });

  it('status lists the devices holding the project with this machine and presence (T13290)', () => {
    const fresh = new Date(Date.now() - 3_600_000).toISOString();
    const line = cloudStatusSummary({
      verdict: 'ok',
      summary: {
        signedIn: true,
        registered: true,
        profile: 'device',
        linked: true,
        replicaAttached: true,
        devices: 2,
        lastPresenceAt: null,
        lastSyncAt: null,
        headSeq: 3,
        openConflicts: 0,
      },
      local: {
        apiUrl: API,
        signedIn: true,
        nexusDeviceId: 'd-1',
        profile: 'device',
        projectId: 'p-1',
        replicaId: 'r-3',
        retiredReplicas: [],
        linkPath: null,
        credentialsPath: '/tmp/nexus-device.json',
      },
      remote: null,
      holders: [
        {
          deviceId: '0198abcd-0000-7000-8000-000000000001',
          deviceName: 'laptop',
          replicaId: 'r-3',
          presenceAt: fresh,
          fresh: true,
          thisDevice: true,
        },
        {
          deviceId: '0199ef01-0000-7000-8000-000000000002',
          deviceName: 'desk',
          replicaId: 'r-9',
          presenceAt: '2026-01-02T00:00:00.000Z',
          fresh: false,
          thisDevice: false,
        },
      ],
      warnings: [],
    });
    expect(line).toContain(
      'Devices: laptop (0198abcd, this machine, presence fresh); desk (0199ef01, presence stale since 2026-01-02).',
    );
  });

  it('devicesClause merges a device holding several replicas and says when it never reported (T13290)', () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(
      devicesClause([
        { deviceId: 'aaaaaaaa-1', deviceName: 'laptop', presenceAt: null, thisDevice: false },
        { deviceId: 'aaaaaaaa-1', deviceName: 'laptop', presenceAt: recent, thisDevice: false },
        { deviceId: 'bbbbbbbb-2', deviceName: 'new', presenceAt: null, thisDevice: false },
      ]),
    ).toBe(' Devices: laptop (aaaaaaaa, presence fresh); new (bbbbbbbb, no presence yet).');
    expect(devicesClause([])).toBe('');
  });

  it('projects show labels the listed replicas this device retired', () => {
    const replica = (replicaId: string) => ({
      projectId: 'p-1',
      replicaId,
      deviceId: 'd-1',
      deviceName: 'laptop',
      lastSyncAt: null,
      presence: null,
      presenceAt: null,
    });
    const line = cloudProjectShowSummary({
      project: { projectId: 'p-1', label: 'demo', organizationId: 'o-1' },
      role: 'owner',
      openConflicts: 0,
      // r-2 is retired here but still carries a recent presence: it must not
      // make this device look fresh (T13290).
      replicas: [
        replica('r-1'),
        { ...replica('r-2'), presenceAt: new Date().toISOString() },
        replica('r-3'),
      ],
      devices: { active: 1, total: 1 },
      truncated: false,
      stream: { streamId: 'project:p-1', headSeq: 3, headCheckpointId: null },
      apiUrl: API,
      projectId: 'p-1',
      currentProject: true,
      replicaPaging: { pages: 1, truncated: false, pageLimitReached: false },
      retiredHere: retired,
      warnings: [],
    });
    expect(line).toContain(
      '3 replica(s) (retired on this device: r-2 retired → r-3; r-1 retired → r-2)',
    );
    // T13290: the devices holding it are listed; retired replicas are not holders.
    expect(line).toContain('Devices: laptop (d-1, no presence yet).');
  });
});
