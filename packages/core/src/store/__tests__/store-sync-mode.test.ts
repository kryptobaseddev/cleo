/**
 * Sync mode of a chokepoint open (journal spec §1.5 "Opens that skip the sync
 * open pass", T13336): only a canonical, non-dedicated open runs the capture
 * open pass and the replica bind. Backups, snapshots, Gate B copies, exodus
 * handles, bundle staging and credential-transfer handles never install,
 * verify or drop capture triggers, and never rebind.
 *
 * @task T13336
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDeviceIdCacheForTests } from '../../llm/stable-device-id.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
  resolveStoreSyncMode,
} from '../dual-scope-db.js';
import { dropCaptureTriggers, setCaptureEnabled } from '../sync/capture.js';
import { activeReplica } from '../sync/replica.js';
import { classifyStoreTriggers } from '../sync/trigger-classes.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');
const REPO = resolve(import.meta.dirname, '../../../../..');

let dir: string;
let home: string;
let dbPath: string;

async function open(path: string, options?: Parameters<typeof openDualScopeDbAtPath>[3]) {
  return getDualScopeNativeDb(await openDualScopeDbAtPath('project', path, undefined, options));
}

function captureTriggerCount(db: DatabaseSync): number {
  return classifyStoreTriggers(db, 'project').classified.filter((t) => t.class === 'capture')
    .length;
}

/** A canonical store with capture on, bound to a replica by a live open. */
async function boundCaptureStore(): Promise<{ db: DatabaseSync; replicaId: string }> {
  const first = await open(dbPath);
  setCaptureEnabled(first, 'project', true, { schemaRoot: SYNC_SCHEMA });
  _resetDualScopeDbCache();
  const db = await open(dbPath);
  const replicaId = activeReplica(db, 'project')?.replicaId;
  if (!replicaId) throw new Error('a live open with capture on must bind the store');
  return { db, replicaId };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-sync-mode-'));
  home = join(dir, 'cleo');
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  // The live bind writes the device replica registry under the state dir:
  // CLEO_HOME on macOS and Windows, XDG_STATE_HOME on Linux.
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  _resetDeviceIdCacheForTests();
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  _resetDeviceIdCacheForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveStoreSyncMode', () => {
  it('is live only for a canonical, non-dedicated store path', () => {
    expect(resolveStoreSyncMode('project', '/p/.cleo/cleo.db')).toBe('live');
    expect(resolveStoreSyncMode('global', join(home, 'cleo.db'))).toBe('live');
    expect(resolveStoreSyncMode('project', '/p/.cleo/backups/sqlite/cleo-1.db')).toBe('off');
    expect(resolveStoreSyncMode('project', '/tmp/stage/cleo.db')).toBe('off');
    expect(resolveStoreSyncMode('global', join(dir, 'elsewhere', 'cleo.db'))).toBe('off');
    expect(resolveStoreSyncMode('project', '/p/.cleo/cleo.db', { dedicated: true })).toBe('off');
    expect(resolveStoreSyncMode('project', '/p/.cleo/cleo.db', { syncMode: 'off' })).toBe('off');
    expect(resolveStoreSyncMode('project', '/tmp/x.db', { syncMode: 'live' })).toBe('live');
  });
});

describe('a canonical open runs the sync open pass in live mode', () => {
  it('binds the store once a sync flag is on, and keeps the same replica on reopen', async () => {
    const { replicaId } = await boundCaptureStore();
    _resetDualScopeDbCache();
    expect(activeReplica(await open(dbPath), 'project')?.replicaId).toBe(replicaId);
  });

  it('rebinds a copy that lands at another canonical path', async () => {
    const { db, replicaId } = await boundCaptureStore();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const copy = join(dir, 'other', '.cleo', 'cleo.db');
    mkdirSync(join(dir, 'other', '.cleo'), { recursive: true });
    copyFileSync(dbPath, copy);
    const row = activeReplica(await open(copy), 'project');
    expect(row?.replicaId).toBeDefined();
    expect(row?.replicaId).not.toBe(replicaId);
  });

  it('re-installs capture triggers a canonical reopen finds missing', async () => {
    const { db } = await boundCaptureStore();
    dropCaptureTriggers(db);
    _resetDualScopeDbCache();
    expect(captureTriggerCount(await open(dbPath))).toBeGreaterThan(0);
  });
});

describe('a sync-off open never touches capture triggers or the replica', () => {
  it('a copy at a non-canonical path (backup, snapshot, scratch) is never rebound', async () => {
    const { db, replicaId } = await boundCaptureStore();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const scratch = join(dir, 'scratch', 'cleo.db');
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    copyFileSync(dbPath, scratch);
    expect(activeReplica(await open(scratch), 'project')?.replicaId).toBe(replicaId);
  });

  it('a dedicated open (exodus, reconcile scratch) neither installs nor drops triggers', async () => {
    const { db } = await boundCaptureStore();
    dropCaptureTriggers(db);
    const dedicated = await openDualScopeDbAtPath('project', dbPath, undefined, {
      dedicated: true,
    });
    try {
      expect(captureTriggerCount(getDualScopeNativeDb(dedicated))).toBe(0);
    } finally {
      dedicated.close();
    }
  });

  it('an explicit off open of a canonical path never rebinds nor re-installs', async () => {
    const { db, replicaId } = await boundCaptureStore();
    dropCaptureTriggers(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const copy = join(dir, 'gate-b', '.cleo', 'cleo.db');
    mkdirSync(join(dir, 'gate-b', '.cleo'), { recursive: true });
    copyFileSync(dbPath, copy);
    const off = await open(copy, { syncMode: 'off' });
    expect(activeReplica(off, 'project')?.replicaId).toBe(replicaId);
    expect(captureTriggerCount(off)).toBe(0);
  });
});

/**
 * Every non-canonical open path named by §1.5 is pinned to sync mode off:
 * chokepoint opens pass `syncMode: 'off'`, and the raw-handle paths never
 * open through the chokepoint (so no open pass can run on them).
 */
describe('non-canonical open paths are pinned to sync mode off', () => {
  const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
  const CHOKEPOINT_OPEN = /openDualScopeDb(?:AtPath)?\(/g;
  /** Whether the match at `at` sits on a comment line (TSDoc or `//`). */
  const isComment = (src: string, at: number): boolean => {
    const line = src.slice(src.lastIndexOf('\n', at) + 1, at).trimStart();
    return line.startsWith('*') || line.startsWith('//') || line.startsWith('/*');
  };

  it.each([
    'packages/core/src/store/exodus/migrate.ts',
    'packages/core/src/store/exodus/on-open.ts',
    'packages/core/src/store/exodus/reconcile.ts',
    'scripts/row-identity-real-store-gate-b.mjs',
  ])('%s passes syncMode off on every chokepoint open', (rel) => {
    const src = read(rel);
    const opens = [...src.matchAll(CHOKEPOINT_OPEN)]
      .map((m) => m.index ?? 0)
      .filter((at) => !isComment(src, at));
    expect(opens.length).toBeGreaterThan(0);
    for (const at of opens) {
      const call = src.slice(at, src.indexOf(');', at));
      expect(call, `${rel}@${at}`).toContain("syncMode: 'off'");
    }
  });

  it.each([
    'packages/core/src/store/backup-pack.ts',
    'packages/core/src/store/credential-transfer.ts',
    'packages/core/src/store/vault-manifest.ts',
    'packages/core/src/snapshot/index.ts',
    'scripts/fingerprint-store.mjs',
  ])('%s never opens a store through the chokepoint', (rel) => {
    const src = read(rel);
    const opens = [...src.matchAll(CHOKEPOINT_OPEN)].filter((m) => !isComment(src, m.index ?? 0));
    expect(opens).toEqual([]);
  });
});
