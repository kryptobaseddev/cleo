/**
 * The server half of a rebind at head (T13278; contract v2.28 E31, journal
 * spec §3.5 D5): attach the successor, record it in the link, retire the old
 * replica with a signature the server can check, then clear the pending
 * rebind. A refusal keeps it pending.
 *
 * @task T13278
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../store/dual-scope-db.js';
import { setSyncFlag } from '../../store/sync/flags.js';
import { type PendingRebind, pendingRebind, REBIND_PENDING_KEY } from '../../store/sync/rebind.js';
import { recordRetirement, retiredReplicas } from '../../store/sync/retire.js';
import { generateEd25519, verifyEd25519 } from '../crypto.js';
import { NexusError } from '../http.js';
import { nexusLinkPath, readNexusProjectLink } from '../nexus-link.js';
import { completeServerRebind } from '../replica-rebind.js';
import { replicaRetireMessage } from '../signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');
const API = 'https://nexus.test';
const DEVICE = '0192dddd-7f00-7000-8000-00000000000d';
const PROJECT = '0192cccc-7f00-7000-8000-00000000000c';
const STREAM = `project:${PROJECT}`;
const FROM = '0192aaaa-7f00-7000-8000-00000000000a';
const TO = '0192bbbb-7f00-7000-8000-00000000000b';
const KEYS = { encryption: generateEd25519(), signing: generateEd25519() };
let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-replica-rebind-'));
  root = join(dir, 'project');
  mkdirSync(join(root, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function storeWith(pending: PendingRebind | null): Promise<DatabaseSync> {
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(root, '.cleo', 'cleo.db')),
  );
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  if (pending) {
    db.prepare('INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?)').run(
      REBIND_PENDING_KEY,
      JSON.stringify(pending),
      pending.at,
    );
    // The rebind recorded its own retire, unconfirmed until the server's answer.
    recordRetirement(db, pending.stream, {
      replica: pending.from,
      successor: pending.to,
      lastReplicaSeq: pending.lastReplicaSeq,
      txn: pending.retireTxn ?? `${pending.to}:0`,
      hlc: '0000000000001-0000-b',
      seq: null,
    });
  }
  return db;
}

const PENDING: PendingRebind = {
  stream: STREAM,
  scope: 'project',
  from: FROM,
  to: TO,
  lastReplicaSeq: 4,
  retireTxn: `${TO}:9`,
  at: '2026-10-09T00:00:00.000Z',
};

function linkProject(): void {
  writeFileSync(
    nexusLinkPath(root),
    JSON.stringify({
      version: 1,
      links: {
        [API]: {
          apiUrl: API,
          localProjectId: 'local',
          remoteProjectId: PROJECT,
          organizationId: 'org',
          label: null,
          streamId: STREAM,
          linkedAt: '2026-10-01T00:00:00.000Z',
          replicaId: FROM,
          nexusDeviceId: DEVICE,
          attachedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }),
  );
}

/** A connection whose raw client records each call and answers like the server. */
function fakeConn(fail?: { path: RegExp; err: NexusError }) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  return {
    calls,
    conn: {
      apiUrl: API,
      deviceId: DEVICE,
      keys: KEYS,
      raw: async <T>(
        method: string,
        path: string,
        schema: { safeParse(v: unknown): { success: boolean; data?: T } },
        body?: unknown,
      ): Promise<T> => {
        calls.push({ method, path, body });
        if (fail?.path.test(path)) throw fail.err;
        const answer = path.endsWith('/retirements')
          ? {
              retirement: {
                streamId: STREAM,
                replicaId: FROM,
                successor: TO,
                lastReplicaSeq: 4,
                signerDeviceId: DEVICE,
                txnId: `${TO}:9`,
                signature: (body as { signature: string }).signature,
                retiredAt: '2026-10-09T00:00:01.000Z',
              },
            }
          : { replicaId: (body as { replicaId: string }).replicaId };
        const parsed = schema.safeParse(answer);
        if (!parsed.success) throw new Error(`fake answer does not parse for ${path}`);
        return parsed.data as T;
      },
    },
  };
}

describe('completeServerRebind (T13278)', () => {
  it('attaches the successor, records it in the link, retires the old replica signed, then clears the pending rebind', async () => {
    linkProject();
    const db = await storeWith(PENDING);
    const { conn, calls } = fakeConn();
    const done = await completeServerRebind(
      conn,
      { streamId: STREAM, projectId: PROJECT, storeRoot: root },
      db,
    );
    expect(done).toEqual(PENDING);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', `/v1/projects/${PROJECT}/replicas`],
      ['POST', `/v1/streams/${encodeURIComponent(STREAM)}/replicas/${FROM}/retirements`],
    ]);
    expect(calls[0]?.body).toEqual({ deviceId: DEVICE, replicaId: TO });
    const retire = calls[1]?.body as {
      deviceId: string;
      successor: string;
      lastReplicaSeq: number;
      txnId: string;
      signature: string;
    };
    expect(retire).toMatchObject({
      deviceId: DEVICE,
      successor: TO,
      lastReplicaSeq: 4,
      txnId: `${TO}:9`,
    });
    const message = replicaRetireMessage({
      streamId: STREAM,
      replicaId: FROM,
      successor: TO,
      lastReplicaSeq: 4,
      signerDeviceId: DEVICE,
      txnId: `${TO}:9`,
    });
    expect(
      verifyEd25519(KEYS.signing.publicKey, message, Buffer.from(retire.signature, 'base64')),
    ).toBe(true);
    expect(readNexusProjectLink(root, API)).toMatchObject({
      replicaId: TO,
      nexusDeviceId: DEVICE,
    });
    expect(pendingRebind(db)).toBeNull();
    // The server's stored retirement confirms the store's own retire (T13366).
    expect(retiredReplicas(db, STREAM).get(FROM)?.confirmedAt).toBe('2026-10-09T00:00:01.000Z');
  });

  it('a refused retirement keeps the rebind pending and names the server reason', async () => {
    linkProject();
    const db = await storeWith(PENDING);
    const { conn } = fakeConn({
      path: /retirements$/,
      err: new NexusError('E_CONFLICT', 'segments past lastReplicaSeq', 409, 'req-1', {
        reason: 'retire-below-head',
      }),
    });
    await expect(
      completeServerRebind(conn, { streamId: STREAM, projectId: PROJECT, storeRoot: root }, db),
    ).rejects.toMatchObject({
      code: 'E_NEXUS_SYNC_REFUSED',
      message: expect.stringContaining('retire-below-head'),
    });
    expect(pendingRebind(db)).toEqual(PENDING);
    expect(retiredReplicas(db, STREAM).has(FROM)).toBe(false);
  });

  it('a refused attach retires nothing and keeps it pending', async () => {
    linkProject();
    const db = await storeWith(PENDING);
    const { conn, calls } = fakeConn({
      path: /\/replicas$/,
      err: new NexusError('E_CONFLICT', 'replica copied', 409, null, { reason: 'replica-copied' }),
    });
    await expect(
      completeServerRebind(conn, { streamId: STREAM, projectId: PROJECT, storeRoot: root }, db),
    ).rejects.toMatchObject({ code: 'E_NEXUS_SYNC_REFUSED' });
    expect(calls).toHaveLength(1);
    expect(readNexusProjectLink(root, API)?.replicaId).toBe(FROM);
    expect(pendingRebind(db)).toEqual(PENDING);
  });

  it('the global store attaches to the home replicas and writes no link', async () => {
    const home = `home:${DEVICE}`;
    const db = await storeWith({ ...PENDING, stream: home, scope: 'global', retireTxn: null });
    const { conn, calls } = fakeConn();
    await completeServerRebind(conn, { streamId: home, projectId: null, storeRoot: root }, db);
    expect(calls[0]?.path).toBe('/v1/account/home/replicas');
    expect(calls[1]?.body).toMatchObject({ txnId: null });
    expect(pendingRebind(db)).toBeNull();
  });

  it('does nothing when no rebind is pending, or one is pending on another stream', async () => {
    const db = await storeWith(null);
    const { conn, calls } = fakeConn();
    const target = { streamId: STREAM, projectId: PROJECT, storeRoot: root };
    expect(await completeServerRebind(conn, target, db)).toBeNull();
    db.prepare('INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?)').run(
      REBIND_PENDING_KEY,
      JSON.stringify({ ...PENDING, stream: 'project:other' }),
      PENDING.at,
    );
    expect(await completeServerRebind(conn, target, db)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
