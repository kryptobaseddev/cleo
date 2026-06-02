/**
 * In-SQL JSON access tests (T11357 · E4).
 *
 * Covers the four conversions from the audit:
 *   - dedup-hit: exact nested json_extract on notes_json (no substring match);
 *   - sequence increment: in-SQL json_set/json_extract on schema_meta.value;
 *   - entry_ids: native json_each (handles JSON-array + legacy comma-separated);
 *   - append-then-read: json_insert($[#]) end-of-array append on a session list.
 *
 * @task T11357
 * @epic T11286
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDedupCollision, computeDedupHash } from '../../sentient/proposal-dedup.js';
import { SENTIENT_TIER2_TAG } from '../../sentient/proposal-rate-limiter.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cleo-t11357-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dedupHash exact json_extract (T11357 AC1)', () => {
  /** Minimal tasks + task_labels schema mirroring the live dedup query shape. */
  function createTasksDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, status TEXT,
        labels_json TEXT DEFAULT '[]', notes_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_labels (task_id TEXT, label TEXT, PRIMARY KEY (task_id, label));
    `);
    return db;
  }

  function insertProposal(db: DatabaseSync, id: string, dedupHash: string): void {
    const meta = JSON.stringify({ kind: 'proposal-meta', dedupHash });
    db.prepare(
      'INSERT INTO tasks (id, parent_id, title, status, notes_json, created_at) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(id, `[T2-BRAIN] ${id}`, 'proposed', JSON.stringify([meta]), new Date().toISOString());
    db.prepare('INSERT INTO task_labels (task_id, label) VALUES (?, ?)').run(
      id,
      SENTIENT_TIER2_TAG,
    );
  }

  it('detects an exact dedupHash collision', () => {
    const db = createTasksDb();
    const hash = computeDedupHash({ parentId: null, title: 'Auth', acceptance: 'fix it' });
    insertProposal(db, 'T001', hash);

    const result = checkDedupCollision({
      tasksDb: db,
      candidate: { parentId: null, title: 'Auth', acceptance: 'fix it' },
      windowHours: 0,
    });
    expect(result.isDuplicate).toBe(true);
    expect(result.existingTaskId).toBe('T001');
    db.close();
  });

  it('does NOT collide when only a substring of the hash matches (former LIKE false positive)', () => {
    const db = createTasksDb();
    const realHash = computeDedupHash({ parentId: null, title: 'Auth', acceptance: 'fix it' });
    // Store a DIFFERENT hash that shares a long prefix with the candidate's hash.
    const storedHash = `${realHash.slice(0, 40)}deadbeefdeadbeefdeadbeefdeadbeef`;
    insertProposal(db, 'T001', storedHash);

    const result = checkDedupCollision({
      tasksDb: db,
      candidate: { parentId: null, title: 'Auth', acceptance: 'fix it' },
      windowHours: 0,
    });
    // Exact json_extract equality: a prefix overlap must NOT register as a dup.
    expect(result.isDuplicate).toBe(false);
    db.close();
  });
});

describe('schema_meta.value sequence increment in-SQL (T11357 AC2)', () => {
  it('increments the counter via json_set/json_extract entirely in SQL', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('task_id_sequence', json('{"counter":5}'));
    `);

    // Mirror sequence/index.ts: increment counter + derive lastId, all in SQL.
    db.prepare(`
      UPDATE schema_meta
      SET value = json_set(value,
        '$.counter', json_extract(value, '$.counter') + 1,
        '$.lastId', 'T' || printf('%03d', json_extract(value, '$.counter') + 1)
      )
      WHERE key = 'task_id_sequence'
    `).run();

    const row = db
      .prepare(
        "SELECT json_extract(value, '$.counter') AS counter, json_extract(value, '$.lastId') AS lastId FROM schema_meta WHERE key = 'task_id_sequence'",
      )
      .get() as { counter: number; lastId: string };
    expect(row.counter).toBe(6);
    expect(row.lastId).toBe('T006');
    db.close();
  });
});

describe('brain_retrieval_log.entry_ids native json_each (T11357 AC3)', () => {
  function countDistinct(db: DatabaseSync): number {
    return (
      db
        .prepare(
          `SELECT COUNT(DISTINCT je.value) AS cnt
           FROM brain_retrieval_log AS l,
                json_each(
                  CASE
                    WHEN json_valid(l.entry_ids) THEN l.entry_ids
                    ELSE '["' || replace(l.entry_ids, ',', '","') || '"]'
                  END
                ) AS je`,
        )
        .get() as { cnt: number }
    ).cnt;
  }

  it('counts distinct ids across JSON-array and legacy comma-separated rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE brain_retrieval_log (entry_ids TEXT)');
    // Canonical JSON-array form (written by log-retrieval.ts today).
    db.prepare('INSERT INTO brain_retrieval_log (entry_ids) VALUES (?)').run(
      JSON.stringify(['M-a', 'M-b']),
    );
    // Legacy comma-separated form (BUG-2 rows).
    db.prepare('INSERT INTO brain_retrieval_log (entry_ids) VALUES (?)').run('M-b,M-c');

    // Distinct union: M-a, M-b, M-c → 3.
    expect(countDistinct(db)).toBe(3);
    db.close();
  });
});

describe('session list append via json_insert($[#]) (T11357 AC4)', () => {
  it('appends in SQL without read-modify-write and reads back via json(col)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { appendSessionListItem } = await import('../db-helpers.js');
    const schema = await import('../tasks-schema.js');

    const nativeDb = openNativeDatabase(join(tempDir, 'tasks.db'));
    // T11578 · AC1: appendSessionListItem now targets the PREFIXED consolidated
    // sessions table, so the unit-test fixture creates `tasks_sessions`.
    nativeDb.exec(`
      CREATE TABLE tasks_sessions (
        id TEXT PRIMARY KEY,
        notes_json TEXT DEFAULT '[]',
        tasks_completed_json TEXT DEFAULT '[]',
        tasks_created_json TEXT DEFAULT '[]'
      );
      INSERT INTO tasks_sessions (id) VALUES ('ses_1');
    `);
    const db = drizzle({ client: nativeDb, schema });

    await appendSessionListItem(db, 'ses_1', 'tasksCompletedJson', 'T100');
    await appendSessionListItem(db, 'ses_1', 'tasksCompletedJson', 'T200');
    await appendSessionListItem(db, 'ses_1', 'notesJson', 'first note');

    // Read whole-value via json(col).
    const row = nativeDb
      .prepare(
        "SELECT json(tasks_completed_json) AS completed, json(notes_json) AS notes FROM tasks_sessions WHERE id = 'ses_1'",
      )
      .get() as { completed: string; notes: string };
    expect(JSON.parse(row.completed)).toEqual(['T100', 'T200']);
    expect(JSON.parse(row.notes)).toEqual(['first note']);

    nativeDb.close();
  });
});
