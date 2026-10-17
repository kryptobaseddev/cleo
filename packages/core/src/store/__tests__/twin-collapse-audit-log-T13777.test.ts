/**
 * T13777 part 2 — the twin collapse drains the bare `audit_log` (the dispatch
 * audit an older build writes) into `tasks_audit_log`, which syncs: rows keep
 * their id (so their uid), the bare idempotency key lands outside the twin's
 * UNIQUE idempotency tuple, a failed attempt and its retry under one key both
 * land, and pending bare rows never count as a legacy strand.
 *
 * Every open goes through the real tasks-domain bind (`bindTasksDomain`).
 *
 * @task T13777
 * @epic T12323
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindTasksDomain, closeDb } from '../sqlite.js';
import { legacyStrands } from '../sync/flags.js';
import { TWIN_COLLAPSE_MARKER_PREFIX } from '../twin-collapse.js';
import { optOutOfForeignKeys } from './test-db-helper.js';

optOutOfForeignKeys();

const MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}audit_log`;

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-audit-drain-T13777-')));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  for (const k of ['CLEO_DIR', 'CLEO_HOME']) saved[k] = process.env[k];
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'cleo-home');
});

afterEach(() => {
  closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const open = async (): Promise<DatabaseSync> => (await bindTasksDomain(root)).native;
const reopen = async (): Promise<DatabaseSync> => {
  closeDb();
  return open();
};

/** A dispatch audit row as an older build wrote it, in the bare table. */
function bare(db: DatabaseSync, id: string, fields: Record<string, string | number> = {}): void {
  const r = {
    id,
    timestamp: '2026-10-16T09:00:00.000Z',
    action: 'add',
    task_id: 'T1',
    domain: 'tasks',
    operation: 'add',
    project_hash: 'hash-p',
    ...fields,
  };
  const cols = Object.keys(r);
  db.prepare(
    `INSERT INTO main.audit_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...Object.values(r));
}

const twin = (db: DatabaseSync) =>
  db
    .prepare(
      'SELECT id, success, idempotency_key, dispatch_idempotency_key, uid FROM tasks_audit_log ORDER BY id',
    )
    .all() as Array<Record<string, string | number | null>>;

describe('audit_log drain into tasks_audit_log (T13777)', () => {
  it('drains every bare row, keeps its id, and carries its idempotency key outside the UNIQUE tuple', async () => {
    let db = await open();
    // A failed attempt and its successful retry under one key, and an unkeyed row.
    bare(db, '0198f100-0000-4000-8000-000000000001', { success: 0, idempotency_key: 'k-1' });
    bare(db, '0198f100-0000-4000-8000-000000000002', { success: 1, idempotency_key: 'k-1' });
    bare(db, '0198f100-0000-4000-8000-000000000003', { success: 1 });
    db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(MARKER);
    // Pending bare rows are an inbox the next open drains, never a strand.
    expect(legacyStrands(db).filter((s) => s.bareTable === 'audit_log')).toEqual([]);

    db = await reopen();
    expect(db.prepare('SELECT count(*) AS n FROM main.audit_log').get()).toEqual({ n: 0 });
    const rows = twin(db);
    expect(rows.map((r) => r['id'])).toEqual([
      '0198f100-0000-4000-8000-000000000001',
      '0198f100-0000-4000-8000-000000000002',
      '0198f100-0000-4000-8000-000000000003',
    ]);
    // Both attempts under k-1 landed: the key is outside uq_tasks_audit_log_idempotency_lookup.
    expect(rows.map((r) => [r['dispatch_idempotency_key'], r['idempotency_key']])).toEqual([
      ['k-1', null],
      ['k-1', null],
      [null, null],
    ]);
    // Each drained row has its uid (natural over the id).
    expect(rows.every((r) => typeof r['uid'] === 'string' && r['uid'] !== '')).toBe(true);
    // The idempotent replay reads the newest successful row for the key.
    expect(
      db
        .prepare(
          `SELECT id FROM tasks_audit_log WHERE domain = 'tasks' AND operation = 'add'
             AND dispatch_idempotency_key = 'k-1' AND success = 1 AND project_hash = 'hash-p'`,
        )
        .all(),
    ).toEqual([{ id: '0198f100-0000-4000-8000-000000000002' }]);
    // A second open has nothing left to drain.
    db = await reopen();
    expect(twin(db)).toHaveLength(3);
  });

  it('the uid of a drained row is the uid any device computes for the same id', async () => {
    let db = await open();
    bare(db, '0198f100-0000-4000-8000-0000000000aa');
    db = await reopen();
    const drained = twin(db)[0]?.['uid'];
    // The same id written straight into the twin on another store gets the same uid.
    closeDb();
    rmSync(join(root, '.cleo'), { recursive: true, force: true });
    mkdirSync(join(root, '.cleo'), { recursive: true });
    db = await open();
    db.prepare(
      "INSERT INTO tasks_audit_log (id, timestamp, action, task_id) VALUES ('0198f100-0000-4000-8000-0000000000aa', '2026-10-16T09:00:00.000Z', 'add', 'T1')",
    ).run();
    expect(twin(db)[0]?.['uid']).toBe(drained);
  });
});
