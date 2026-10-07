/**
 * `cleo cloud status`'s per-store sync block (T12998, partial build): the
 * local journal facts, and every server-side field unknown with its reason.
 * Read-only: the store file is unchanged by a read.
 *
 * @task T12998
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudWarning } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../store/dual-scope-db.js';
import {
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../../store/sync/capture.js';
import { setSyncFlag } from '../../store/sync/flags.js';
import { sealPending } from '../../store/sync/sealer.js';
import { readCloudSyncStatus } from '../nexus-cloud-status.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';

let dir: string;
let projectRoot: string;
let home: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-cloud-sync-'));
  projectRoot = join(dir, 'project');
  home = join(dir, 'cleo');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(projectRoot, '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A project store; with `journal`, capture (and seal) on over the sync schema. */
async function store(journal: boolean): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  const db = handle.db.$client as DatabaseSync;
  if (journal) {
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
  return db;
}

function addTask(db: DatabaseSync, id: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', 'test');
  db.prepare(
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES (?, ?, 'task', 'pending', 'medium', ?, ?)`,
  ).run(id, `title ${id}`, `uid-${id}`, `fp-${id}`);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

let clock = 1_790_000_000_000;
const seal = (db: DatabaseSync) =>
  sealPending(db, {
    scope: 'project',
    replica: REPLICA,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });

async function projectBlock() {
  _resetDualScopeDbCache();
  const warnings: CloudWarning[] = [];
  const sync = await readCloudSyncStatus(projectRoot, 'project:p1', warnings, home);
  const project = sync?.streams.find((s) => s.scope === 'project');
  return { sync, project, warnings };
}

describe('cloud status sync block (T12998)', () => {
  it('flags off and no journal: every flag off, zero counts, no failure', async () => {
    await store(false);
    const { sync, project, warnings } = await projectBlock();
    expect(sync?.partial).toBe(true);
    expect(warnings).toEqual([]);
    expect(project).toMatchObject({
      stream: 'project:p1',
      journalInstalled: false,
      flags: { capture: false, seal: false, push: false, pull: false, strict: false },
      unsealedOps: 0,
      lastSealedSeq: null,
      quarantined: {},
      seenTxns: { rows: 0, bytes: 0, byStream: {} },
    });
  });

  it('behind: captured changes not yet sealed are counted with the oldest capture time', async () => {
    const db = await store(true);
    addTask(db, 'T1');
    addTask(db, 'T2');
    const { project } = await projectBlock();
    expect(project?.journalInstalled).toBe(true);
    expect(project?.flags.capture).toBe(true);
    expect(project?.unsealedOps).toBeGreaterThan(0);
    expect(project?.oldestUnsealedAtMs).not.toBeNull();
    expect(project?.lastSealedSeq).toBeNull();
  });

  it('ahead: sealed ops report the last sealed seq; unsent stays unknown until the outbox', async () => {
    const db = await store(true);
    addTask(db, 'T1');
    seal(db);
    addTask(db, 'T2');
    seal(db);
    const { project } = await projectBlock();
    expect(project?.unsealedOps).toBe(0);
    expect(project?.lastSealedSeq).toBeGreaterThanOrEqual(1);
    expect(project?.unsentOps).toEqual({
      known: false,
      needs: 'T12343',
      reason: expect.stringContaining('outbox'),
    });
    for (const field of [
      'lastPushedSeq',
      'lastPulledSeq',
      'serverHeadSeq',
      'devices',
      'openConflicts',
      'lag',
    ] as const) {
      expect(project?.[field]).toMatchObject({ known: false, needs: 'S4' });
    }
  });

  it('conflicted: captures the sealer holds aside are reported per table', async () => {
    const db = await store(true);
    db.prepare(
      `INSERT INTO _sync_quarantine (seq, tbl, op, rk, uid, img, at_ms, frame, reason, quarantined_at_ms)
       VALUES (1, 'tasks_tasks', 'u', 'rk1', 'uid-1', '{}', 1, NULL, 'unreadable', 2)`,
    ).run();
    const { project } = await projectBlock();
    expect(project?.quarantined).toEqual({ tasks_tasks: 1 });
  });

  it('reports the seen-txn ledger per stream with its estimated bytes; nothing prunes it (T13317)', async () => {
    const db = await store(true);
    const ins = db.prepare('INSERT INTO _sync_seen_txn (stream, txn, seq) VALUES (?, ?, ?)');
    ins.run('project:p1', 'r1:1', 1);
    ins.run('project:p1', 'r1:2', 2);
    ins.run('home:u1', 'r2:1', 1);
    const { project } = await projectBlock();
    // stream + txn text + an 8-byte seq per row.
    const bytes =
      2 * ('project:p1'.length + 'r1:1'.length + 8) + ('home:u1'.length + 'r2:1'.length + 8);
    expect(project?.seenTxns).toEqual({
      rows: 3,
      bytes,
      byStream: { 'home:u1': 1, 'project:p1': 2 },
    });
    // A read never prunes: the next read sees the same rows.
    expect((await projectBlock()).project?.seenTxns.rows).toBe(3);
  });

  it('is read-only: the store file is unchanged by a read', async () => {
    const db = await store(true);
    addTask(db, 'T1');
    _resetDualScopeDbCache();
    const before = { bytes: readFileSync(dbPath), mtime: statSync(dbPath).mtimeMs };
    await projectBlock();
    expect(readFileSync(dbPath).equals(before.bytes)).toBe(true);
    expect(statSync(dbPath).mtimeMs).toBe(before.mtime);
  });

  it('no store anywhere: no block', async () => {
    const warnings: CloudWarning[] = [];
    expect(await readCloudSyncStatus(null, null, warnings, home)).toBeUndefined();
  });
});
