/**
 * Minimal tombstones (journal spec §1.7, NEW-2, R5-5; T12986, S3c).
 *
 * Coverage:
 *   - compaction shrinks only covered, old, unreferenced full tombstones;
 *     it never deletes one and never touches a live row's meta
 *   - a second pass compacts nothing
 *   - a minimal tombstone costs about 190 B on disk (measured)
 *
 * @task T12986
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeHlc } from '../hlc.js';
import { ensureSyncSchema } from '../schema.js';
import { compactTombstones, TOMBSTONE_GRACE_MS, tombstoneCounts } from '../tombstones.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_790_000_000_000;

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-tomb-'));
  db = new DatabaseSync(join(dir, 'cleo.db'));
  ensureSyncSchema(db, { root: SYNC_SCHEMA });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const hlc = (phys: number, ctr = 0) => encodeHlc({ phys, ctr, replica: REPLICA });

function tomb(uid: string, at: number, deleted = 1, tbl = 'tasks_tasks'): void {
  db.prepare(
    `INSERT INTO _sync_row_meta (tbl, uid, hlc, fhlc, origin, actor, version, deleted, key_json, chash, bfp)
     VALUES (?, ?, ?, '{"title":"x"}', ?, 'agent', 3, ?, '{"id":"T1"}', ?, 'fp-x')`,
  ).run(tbl, uid, hlc(at), REPLICA, deleted, 'c'.repeat(64));
}

const row = (uid: string) =>
  db.prepare('SELECT * FROM _sync_row_meta WHERE uid = ?').get(uid) as Record<string, unknown>;

describe('compactTombstones', () => {
  it('shrinks covered, old, unreferenced tombstones; keeps the rest; never deletes', () => {
    tomb('old', NOW - 40 * DAY);
    tomb('referenced', NOW - 40 * DAY);
    tomb('young', NOW - 2 * DAY);
    tomb('uncovered', NOW - 31 * DAY + 1);
    tomb('live', NOW - 40 * DAY, 0);
    const r = compactTombstones(db, {
      coveredHlc: hlc(NOW - 31 * DAY),
      now: NOW,
      referenced: (_t, uid) => uid === 'referenced',
    });
    expect(r).toEqual({ compacted: 1, referenced: 1, young: 0 });
    expect(row('old')).toMatchObject({
      tbl: 'tasks_tasks',
      uid: 'old',
      hlc: hlc(NOW - 40 * DAY),
      deleted: 1,
      fhlc: null,
      origin: '',
      actor: null,
      version: 0,
      key_json: null,
      chash: null,
      shash: null,
      bfp: null,
    });
    for (const uid of ['referenced', 'uncovered']) {
      expect(row(uid)).toMatchObject({
        deleted: 1,
        key_json: '{"id":"T1"}',
        version: 3,
        bfp: 'fp-x',
      });
    }
    expect(row('live')).toMatchObject({ deleted: 0, chash: 'c'.repeat(64) });
    expect(tombstoneCounts(db)).toEqual({ full: 3, minimal: 1 });
    expect((db.prepare('SELECT count(*) AS n FROM _sync_row_meta').get() as { n: number }).n).toBe(
      5,
    );
  });

  it('keeps a covered tombstone inside the grace period, and a second pass compacts nothing', () => {
    tomb('young', NOW - 2 * DAY);
    tomb('old', NOW - 40 * DAY);
    const policy = { coveredHlc: hlc(NOW), now: NOW, referenced: () => false };
    expect(compactTombstones(db, policy)).toEqual({ compacted: 1, referenced: 0, young: 1 });
    expect(compactTombstones(db, policy)).toEqual({ compacted: 0, referenced: 0, young: 1 });
    expect(compactTombstones(db, { ...policy, now: NOW + TOMBSTONE_GRACE_MS })).toEqual({
      compacted: 1,
      referenced: 0,
      young: 0,
    });
  });

  it('a minimal tombstone costs about 190 B on disk (measured: key included, no index entry)', () => {
    const N = 4000;
    const size = () => {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const p = db.prepare('PRAGMA page_count').get() as { page_count: number };
      const s = db.prepare('PRAGMA page_size').get() as { page_size: number };
      return p.page_count * s.page_size;
    };
    db.exec('VACUUM');
    const before = size();
    // Deletes arrive in HLC order; uids are random.
    db.exec('BEGIN');
    for (let i = 0; i < N; i++) {
      tomb(randomUUID(), NOW - 400 * DAY + i * 1000, 1, 'tasks_task_dependencies');
    }
    db.exec('COMMIT');
    const full = (size() - before) / N;
    expect(
      compactTombstones(db, {
        coveredHlc: hlc(NOW),
        now: NOW,
        referenced: () => false,
        budget: N,
      }).compacted,
    ).toBe(N);
    db.exec('VACUUM');
    const minimal = (size() - before) / N;
    // §1.7: "about 190 B". Measured ~137 B packed for a 23-char table name.
    expect(minimal).toBeLessThan(200);
    expect(minimal).toBeLessThan(full / 2);
    expect(
      db
        .prepare(
          'SELECT count(*) AS n FROM _sync_row_meta INDEXED BY _sync_row_meta_tomb WHERE deleted = 1 AND version > 0',
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});
