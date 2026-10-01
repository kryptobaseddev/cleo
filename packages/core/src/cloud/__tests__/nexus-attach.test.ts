/**
 * `cleo project link` steps 3 to 5 with a device credential (cleo-nexus
 * device contract §3.6, §3.7): attach this store's replica to the Nexus
 * device, report path-free presence, rebind only for this user's own revoked
 * device, and refuse a genuinely copied store.
 *
 * The API is a scripted mock; the replica binder is a stub, except in the
 * `ensureProjectReplica` tests, which bind a temp SQLite file.
 *
 * @task T12905
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anySyncFlagOn } from '../../store/sync/flags.js';
import { activeReplica, ensureProjectReplica } from '../../store/sync/replica.js';
import { ReplicaRegistry } from '../../store/sync/replica-registry.js';
import { classifyTable } from '../../store/table-classification.js';
import type { FetchLike } from '../http.js';
import { attachProjectReplica, type ProjectReplicaBinder } from '../nexus-attach.js';
import { NexusAccountError } from '../nexus-auth.js';

const API = 'https://api.nexus.test';
const PROJECT = 'c78d09c3a8ee';
const DEVICE = '01a0f48f-89db-7e69-95d6-87e4c14da0d1';
const R1 = '01a0f48f-0000-7000-8000-000000000001';
const R2 = '01a0f48f-0000-7000-8000-000000000002';
const TOKEN = `cnx_d1_${'A'.repeat(43)}`;

interface Call {
  method: string;
  path: string;
  deviceHeader: string | null;
  body: unknown;
}

type Reply = { status: number; data?: unknown; details?: Record<string, unknown> };

function api(replies: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: new URL(input).pathname,
      deviceHeader: headers.get('x-cleo-device-id'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const r = replies(call);
    const body =
      r.status < 300
        ? { success: true, data: r.data ?? {} }
        : {
            success: false,
            error: { code: 'E_CONFLICT', message: 'no', requestId: 'r', details: r.details },
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
    ? { status: 200, data: { presenceAt: '2026-10-01T00:00:00.000Z' } }
    : { status: 200, data: { replicaId: (call.body as { replicaId: string }).replicaId } };

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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-attach-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(fetch: FetchLike, b: ProjectReplicaBinder) {
  return attachProjectReplica({
    apiUrl: API,
    bearer: TOKEN,
    deviceId: DEVICE,
    projectId: PROJECT,
    projectRoot: dir,
    cliVersion: '2026.10.0',
    binder: b,
    fetch,
  });
}

describe('attachProjectReplica', () => {
  it('attaches the replica from this device, then sends path-free presence', async () => {
    const m = api(ok);
    const r = await run(m.fetch, binder());

    expect(m.calls.map((c) => [c.method, c.path, c.deviceHeader])).toEqual([
      ['POST', `/v1/projects/${PROJECT}/replicas`, DEVICE],
      ['PUT', `/v1/projects/${PROJECT}/replicas/${R1}/presence`, DEVICE],
    ]);
    expect(m.calls[0]?.body).toEqual({ deviceId: DEVICE, replicaId: R1 });
    const presence = JSON.stringify(m.calls[1]?.body);
    expect(presence).toContain('"cliVersion":"2026.10.0"');
    expect(presence).not.toContain(dir);
    expect(r).toEqual({
      replica: {
        replicaId: R1,
        deviceId: DEVICE,
        reboundFrom: null,
        presenceAt: '2026-10-01T00:00:00.000Z',
      },
      warnings: [],
    });
  });

  it("rebinds and re-attaches only when this user's own revoked device holds the replica", async () => {
    const m = api((call) =>
      call.method === 'POST' && (call.body as { replicaId: string }).replicaId === R1
        ? { status: 409, details: { holderState: 'revoked', holderSameUser: true } }
        : ok(call),
    );
    const b = binder();
    const r = await run(m.fetch, b);
    expect(b.rebinds).toBe(1);
    expect(r.replica).toMatchObject({ replicaId: R2, reboundFrom: R1 });
    expect(m.calls.map((c) => c.path)).toEqual([
      `/v1/projects/${PROJECT}/replicas`,
      `/v1/projects/${PROJECT}/replicas`,
      `/v1/projects/${PROJECT}/replicas/${R2}/presence`,
    ]);
  });

  it('refuses a copied store held by another live device, with no rebind', async () => {
    for (const details of [
      { holderState: 'active', holderSameUser: true },
      { holderState: 'revoked', holderSameUser: false },
      {},
    ]) {
      const m = api((call) => (call.method === 'POST' ? { status: 409, details } : ok(call)));
      const b = binder();
      const err = await run(m.fetch, b).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NexusAccountError);
      expect((err as NexusAccountError).code).toBe('E_NEXUS_REPLICA_COPIED');
      expect(b.rebinds).toBe(0);
      expect(m.calls.some((c) => c.method === 'PUT')).toBe(false);
    }
  });

  it('a failed presence report is a warning; the attach stands', async () => {
    const m = api((call) => (call.method === 'PUT' ? { status: 400 } : ok(call)));
    const r = await run(m.fetch, binder());
    expect(r.replica).toMatchObject({ replicaId: R1, presenceAt: null });
    expect(r.warnings.join('\n')).toMatch(/presence report failed.*cleo project link/);
  });
});

describe('ensureProjectReplica', () => {
  it('binds an unbound store once with every sync flag still off, then only reads', () => {
    const dbPath = join(dir, 'cleo.db');
    const db = new DatabaseSync(dbPath);
    const registry = new ReplicaRegistry(join(dir, 'registry.json'), 'host-1');
    try {
      const first = ensureProjectReplica(db, { dbPath, mode: 'test', registry });
      expect(first.reboundFrom).toBeUndefined();
      expect(activeReplica(db, 'project')?.replicaId).toBe(first.replicaId);
      expect(anySyncFlagOn(db)).toBe(false);

      const again = ensureProjectReplica(db, { dbPath, mode: 'test', registry });
      expect(again.replicaId).toBe(first.replicaId);
    } finally {
      db.close();
    }
  });

  it("refuses mode 'off'", () => {
    const dbPath = join(dir, 'cleo.db');
    const db = new DatabaseSync(dbPath);
    try {
      expect(() => ensureProjectReplica(db, { dbPath, mode: 'off' })).toThrow(/live or test/);
    } finally {
      db.close();
    }
  });
});

describe('attachProjectReplica against the deployed server (review H1)', () => {
  it("today's 409 (details: { remedy } only) names both causes and the --rebind remedy", async () => {
    const m = api((call) =>
      call.method === 'POST'
        ? {
            status: 409,
            details: { remedy: 'the copied store must mint a new replica id before syncing' },
          }
        : ok(call),
    );
    const b = binder();
    const err = await run(m.fetch, b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NexusAccountError);
    expect((err as NexusAccountError).code).toBe('E_NEXUS_REPLICA_COPIED');
    expect((err as NexusAccountError).fix).toContain('cleo project link --rebind');
    expect(b.rebinds).toBe(0);
  });

  it('--rebind mints a new replica id before attaching, and attaches that one', async () => {
    const m = api(ok);
    const b = binder();
    const r = await attachProjectReplica({
      apiUrl: API,
      bearer: TOKEN,
      deviceId: DEVICE,
      projectId: PROJECT,
      projectRoot: dir,
      cliVersion: '2026.10.0',
      binder: b,
      fetch: m.fetch,
      rebind: true,
    });
    expect(b.rebinds).toBe(1);
    expect(r.replica).toMatchObject({ replicaId: R2, reboundFrom: R1 });
    expect(m.calls[0]?.body).toEqual({ deviceId: DEVICE, replicaId: R2 });
  });
});

describe('presence and binding hold their guarantees (review M3)', () => {
  it('presence from a real git repo carries no path, hostname, remote URL, credential or branch', async () => {
    // Isolated from the developer's git config (signing, hooks, templates).
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe', env });
    git('init', '-q', '-b', 'secret-branch');
    git('config', 'user.email', 't@example.test');
    git('config', 'user.name', 't');
    git('remote', 'add', 'origin', 'https://user:tok123@git.example.test/x.git');
    writeFileSync(join(dir, 'f.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const m = api(ok);
    await run(m.fetch, binder());
    const body = JSON.stringify(m.calls[1]?.body);
    expect(body).toContain('"git"');
    for (const leak of [dir, hostname(), 'git.example.test', 'tok123', 'secret-branch']) {
      expect(body).not.toContain(leak);
    }
  });

  it('a copied store rebinds to a new replica id; the original keeps its own', () => {
    const dbPath = join(dir, 'cleo.db');
    const registry = new ReplicaRegistry(join(dir, 'registry.json'), 'host-1');
    const db = new DatabaseSync(dbPath);
    const first = ensureProjectReplica(db, { dbPath, mode: 'test', registry });
    db.close();
    const copyPath = join(dir, 'copy.db');
    copyFileSync(dbPath, copyPath);
    const copy = new DatabaseSync(copyPath);
    const original = new DatabaseSync(dbPath);
    try {
      const copied = ensureProjectReplica(copy, { dbPath: copyPath, mode: 'test', registry });
      expect(copied.reboundFrom).toBe(first.replicaId);
      expect(copied.replicaId).not.toBe(first.replicaId);
      expect(ensureProjectReplica(original, { dbPath, mode: 'test', registry }).replicaId).toBe(
        first.replicaId,
      );
    } finally {
      copy.close();
      original.close();
    }
  });

  it('binding adds only local-only _sync tables and no trigger', () => {
    const dbPath = join(dir, 'cleo.db');
    const db = new DatabaseSync(dbPath);
    try {
      ensureProjectReplica(db, {
        dbPath,
        mode: 'test',
        registry: new ReplicaRegistry(join(dir, 'registry.json'), 'host-1'),
      });
      const objects = db
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ type: string; name: string }>;
      expect(objects.filter((o) => o.type === 'trigger')).toEqual([]);
      const tables = objects.filter((o) => o.type === 'table').map((o) => o.name);
      // The bookkeeping tables, S2's capture outbox (T12343) and S3a's sealer
      // tables (T12984): all empty, all this-device-only; capture triggers
      // come only with a sync.* flag.
      expect(tables).toEqual([
        '_sync_capture',
        '_sync_clock',
        '_sync_frame',
        '_sync_ledger',
        '_sync_meta',
        '_sync_op',
        '_sync_replica',
        '_sync_row_meta',
        '_sync_txn',
        '_sync_undo',
      ]);
      for (const name of tables) expect(classifyTable('project', name).class).toBe('local-only');
    } finally {
      db.close();
    }
  });
});
