/**
 * Uniform timestamps (journal spec §1.8; T12986, S3c).
 *
 * Coverage:
 *   - canonicalStoreTimestamp: accepted forms, offsets, truncation, refusals
 *     (zoneless, date-only, impossible dates), idempotence
 *   - SYNC_TIMESTAMP_COLUMNS pinned against every captured `*_at` column
 *   - the one-time rewrite: legacy values canonical, tasks_tasks.updated_at
 *     untouched, ambiguous values left and counted, marker, run once,
 *     refused after row_identity_synced, nothing captured, two copies agree
 *
 * @task T12986
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { ROW_IDENTITY_SYNCED_KEY } from '../../row-identity.js';
import {
  captureTableDef,
  setCaptureEnabled,
  syncCaptureOpenPass,
  syncSetTables,
} from '../capture.js';
import {
  ambiguousTimestamps,
  CANON_EXCLUDED_COLUMNS,
  canonicalizeStoreTimestamps,
  canonicalStoreTimestamp,
  SYNC_TIMESTAMP_COLUMNS,
  TIMESTAMP_CANON_MARKER,
} from '../timestamps.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

describe('canonicalStoreTimestamp', () => {
  it('accepts ISO with Z or an offset at any precision, and the SQLite UTC form', () => {
    expect(canonicalStoreTimestamp('2026-09-14T19:56:01Z')).toBe('2026-09-14T19:56:01.000Z');
    expect(canonicalStoreTimestamp('2026-09-14T19:56:01.5Z')).toBe('2026-09-14T19:56:01.500Z');
    expect(canonicalStoreTimestamp('2026-09-14T19:56:01.123456789Z')).toBe(
      '2026-09-14T19:56:01.123Z',
    );
    expect(canonicalStoreTimestamp('2026-09-14T21:56:01+02:00')).toBe('2026-09-14T19:56:01.000Z');
    expect(canonicalStoreTimestamp('2026-09-14T14:26:01.25-05:30')).toBe(
      '2026-09-14T19:56:01.250Z',
    );
    expect(canonicalStoreTimestamp('2026-09-14 19:56:01')).toBe('2026-09-14T19:56:01.000Z');
    expect(canonicalStoreTimestamp('2026-09-14 19:56:01.7')).toBe('2026-09-14T19:56:01.700Z');
  });

  it('truncates past milliseconds, never rounding into the next second', () => {
    expect(canonicalStoreTimestamp('2026-12-31T23:59:59.9999Z')).toBe('2026-12-31T23:59:59.999Z');
  });

  it('crosses day and year boundaries through the offset', () => {
    expect(canonicalStoreTimestamp('2027-01-01T01:30:00+02:00')).toBe('2026-12-31T23:30:00.000Z');
    expect(canonicalStoreTimestamp('2024-02-29T00:00:00Z')).toBe('2024-02-29T00:00:00.000Z');
  });

  it('refuses zoneless T forms, date-only values and impossible dates', () => {
    for (const v of [
      '2026-09-14T19:56:01',
      '2026-09-14',
      '2026-09-14T19:56Z',
      '2026-02-30T00:00:00Z',
      '2025-02-29T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-09-14T24:00:00Z',
      '2026-09-14T19:56:60Z',
      '2026-09-14T19:56:01+24:00',
      '2026-09-14t19:56:01z',
      '1790000000000',
      '',
      'yesterday',
    ]) {
      expect(canonicalStoreTimestamp(v), v).toBeNull();
    }
  });

  it('is idempotent and independent of the process time zone', () => {
    const tz = process.env.TZ;
    try {
      const outs = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].map((zone) => {
        process.env.TZ = zone;
        return canonicalStoreTimestamp('2026-03-08 10:30:00');
      });
      expect(new Set(outs).size).toBe(1);
      const c = outs[0] as string;
      expect(canonicalStoreTimestamp(c)).toBe(c);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

// ---------------------------------------------------------------------------

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-timestamps-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  return handle.db.$client as DatabaseSync;
}

const addTask = (db: DatabaseSync, id: string, created: string, updated: string | null) =>
  db
    .prepare(
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, created_at, updated_at)
       VALUES (?, ?, 'task', 'pending', 'medium', ?, ?, ?, ?)`,
    )
    .run(id, `title ${id}`, `uid-${id}`, `fp-${id}`, created, updated);

const task = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT created_at, updated_at FROM tasks_tasks WHERE id = ?').get(id) as {
    created_at: string;
    updated_at: string | null;
  };

const marker = (db: DatabaseSync) =>
  db
    .prepare('SELECT value FROM tasks_row_identity_meta WHERE key = ?')
    .get(TIMESTAMP_CANON_MARKER) as { value: string } | undefined;

describe('SYNC_TIMESTAMP_COLUMNS', () => {
  it('lists exactly the captured *_at columns of the project sync set', async () => {
    const db = await store();
    const found: Record<string, string[]> = {};
    for (const t of syncSetTables('project')) {
      const def = captureTableDef(db, 'project', t);
      const cols = (def?.columns ?? []).filter((c) => c.endsWith('_at'));
      if (cols.length > 0) found[t] = [...cols].sort();
    }
    const pinned = Object.fromEntries(
      Object.entries(SYNC_TIMESTAMP_COLUMNS.project).map(([t, c]) => [t, [...c].sort()]),
    );
    expect(pinned).toEqual(found);
    expect(CANON_EXCLUDED_COLUMNS.project).toEqual({ tasks_tasks: ['updated_at'] });
  });
});

describe('canonicalizeStoreTimestamps (timestamp_canon_v1)', () => {
  it('rewrites legacy values, leaves updated_at and ambiguous values, and runs once', async () => {
    const db = await store();
    addTask(db, 'T1', '2026-09-14 19:56:01', '2026-09-14 19:56:01');
    addTask(db, 'T2', '2026-09-14T21:56:01+02:00', null);
    addTask(db, 'T3', '2026-09-14T19:56:01', null); // zoneless: refused
    addTask(db, 'T4', '2026-09-14T19:56:01.000Z', null); // already canonical

    const r = canonicalizeStoreTimestamps(db, 'project');
    expect(r).toEqual({
      status: 'done',
      rewritten: { 'tasks_tasks.created_at': 2 },
      ambiguous: { 'tasks_tasks.created_at': 1 },
    });
    expect(task(db, 'T1')).toEqual({
      created_at: '2026-09-14T19:56:01.000Z',
      updated_at: '2026-09-14 19:56:01', // the CAS token is never rewritten
    });
    expect(task(db, 'T2').created_at).toBe('2026-09-14T19:56:01.000Z');
    expect(task(db, 'T3').created_at).toBe('2026-09-14T19:56:01');
    expect(marker(db)?.value).toBe('done');
    expect(ambiguousTimestamps(db, 'project')).toEqual({ 'tasks_tasks.created_at': 1 });

    addTask(db, 'T5', '2026-09-15 00:00:00', null);
    expect(canonicalizeStoreTimestamps(db, 'project')).toEqual({ status: 'already' });
    expect(task(db, 'T5').created_at).toBe('2026-09-15 00:00:00');
  });

  it('is refused once row_identity_synced exists', async () => {
    const db = await store();
    addTask(db, 'T1', '2026-09-14 19:56:01', null);
    db.prepare('INSERT INTO tasks_row_identity_meta (key, value) VALUES (?, ?)').run(
      ROW_IDENTITY_SYNCED_KEY,
      '1',
    );
    expect(canonicalizeStoreTimestamps(db, 'project')).toMatchObject({ status: 'refused' });
    expect(task(db, 'T1').created_at).toBe('2026-09-14 19:56:01');
    expect(marker(db)).toBeUndefined();
  });

  it('runs before the capture triggers go in: turning capture on captures nothing for it', async () => {
    const db = await store();
    addTask(db, 'T1', '2026-09-14 19:56:01', '2026-09-14 19:56:01');
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    expect(task(db, 'T1').created_at).toBe('2026-09-14T19:56:01.000Z');
    expect(marker(db)?.value).toBe('done');
    const n = (db.prepare('SELECT count(*) AS n FROM _sync_capture').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('with capture already on, the open pass rewrites with capture suspended', async () => {
    const db = await store();
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    // A store whose capture went on before S3c: no marker, legacy text.
    db.prepare('DELETE FROM tasks_row_identity_meta WHERE key = ?').run(TIMESTAMP_CANON_MARKER);
    addTask(db, 'T1', '2026-09-14 19:56:01', null);
    db.exec('DELETE FROM _sync_capture');
    const r = syncCaptureOpenPass(db, 'project', { schemaRoot: SYNC_SCHEMA });
    expect(r.capture).toBe('on');
    expect(task(db, 'T1').created_at).toBe('2026-09-14T19:56:01.000Z');
    const n = (db.prepare('SELECT count(*) AS n FROM _sync_capture').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('two copies of a store rewrite to identical values', async () => {
    const db = await store();
    addTask(db, 'T1', '2026-09-14 19:56:01.25', null);
    addTask(db, 'T2', '2026-03-08T02:30:00-08:00', null);
    addTask(db, 'T3', '2026-09-14', null);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const copy = join(dir, 'copy.db');
    copyFileSync(dbPath, copy);
    const other = new DatabaseSync(copy);
    try {
      canonicalizeStoreTimestamps(db, 'project');
      canonicalizeStoreTimestamps(other, 'project');
      const dump = (d: DatabaseSync) =>
        d.prepare('SELECT id, created_at, updated_at FROM tasks_tasks ORDER BY id').all();
      expect(dump(other)).toEqual(dump(db));
      expect(dump(db)).toEqual([
        { id: 'T1', created_at: '2026-09-14T19:56:01.250Z', updated_at: null },
        { id: 'T2', created_at: '2026-03-08T10:30:00.000Z', updated_at: null },
        { id: 'T3', created_at: '2026-09-14', updated_at: null },
      ]);
    } finally {
      other.close();
    }
  });
});

describe('timestamp-canon.ts stays import-free (T12987)', () => {
  it('has no runtime import, so scripts/fingerprint-store.mjs can load it directly', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../timestamp-canon.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\s/);
  });
});
