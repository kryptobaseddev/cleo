/**
 * Split-brain import (T12329): two copies of one store that diverged at T0.
 *
 * The fixture reproduces the cleocode shape in miniature: both copies allocated
 * T3 after divergence for different work; the source also has a post-divergence
 * observation (written in the `datetime('now')` format, on the same day as T0),
 * a pre-divergence session the target has since deleted, and a row in a table
 * the importer does not handle.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAcRowId } from '../../tasks/ac-table.js';
import {
  importSplitBrain,
  parseStoreTimestamp,
  verifyPreexistingRows,
} from '../split-brain-import.js';

const SCHEMA = `
CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT,
  notes_json TEXT DEFAULT '[]', created_at TEXT NOT NULL, idempotency_key TEXT);
CREATE TABLE tasks_task_acceptance_criteria (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, kind TEXT NOT NULL, source_key TEXT NOT NULL, target_task_id TEXT,
  text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE tasks_task_dependencies (task_id TEXT NOT NULL, depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on));
CREATE TABLE tasks_audit_log (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, action TEXT,
  task_id TEXT NOT NULL, actor TEXT, details_json TEXT, source TEXT, success INTEGER);
CREATE TABLE brain_observations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE tasks_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, current_task TEXT,
  tasks_completed_json TEXT, started_at TEXT NOT NULL);
CREATE TABLE tasks_widgets (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let dir: string;
let source: string;
let target: string;
let pristine: string;

function exec(path: string, sql: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(path);
  try {
    if (params.length === 0) db.exec(sql);
    else db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function rows(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-split-brain-'));
  source = join(dir, 'home.db');
  target = join(dir, 'live.db');
  pristine = join(dir, 'live-before.db');
  // One store before divergence (T0 = T2's created_at).
  exec(source, SCHEMA);
  exec(
    source,
    `INSERT INTO tasks_tasks (id, title, created_at) VALUES
       ('T1', 'epic', '2026-09-14T10:00:00.000Z'),
       ('T2', 'shared work', '2026-09-14T17:27:42.313Z');
     INSERT INTO tasks_sessions VALUES ('ses_old', 'old', NULL, '[]', '2026-08-01T00:00:00Z');
     INSERT INTO schema_meta VALUES ('task_id_sequence', '{"counter":2}');`,
  );
  copyFileSync(source, target);

  // Target after divergence: its own T3, a gc'd session, a higher counter.
  exec(
    target,
    `INSERT INTO tasks_tasks (id, title, parent_id, created_at) VALUES ('T3', 'live meaning', 'T1', '2026-09-16T00:00:00Z');
     DELETE FROM tasks_sessions WHERE id = 'ses_old';
     UPDATE schema_meta SET value = '{"counter":7}' WHERE key = 'task_id_sequence';`,
  );
  // Source after divergence: a different T3 (collision) and its child T4.
  exec(
    source,
    `INSERT INTO tasks_tasks (id, title, parent_id, created_at, idempotency_key) VALUES
       ('T3', 'home meaning', 'T1', '2026-09-15T01:00:00.000Z', 'k-1'),
       ('T4', 'home child', 'T3', '2026-09-15T02:00:00.000Z', NULL);
     INSERT INTO tasks_task_acceptance_criteria VALUES
       ('ac-old-1', 'T3', 1, 'text', 'text:1:abc', NULL, 'it works', '2026-09-15T01:00:00Z'),
       ('ac-old-2', 'T3', 2, 'child_task', 'child:T4', 'T4', 'Complete child T4: home child', '2026-09-15T02:00:00Z'),
       ('ac-par-1', 'T1', 1, 'child_task', 'child:T3', 'T3', 'Complete child T3: home meaning', '2026-09-15T01:00:00Z');
     INSERT INTO tasks_task_dependencies VALUES ('T4', 'T2'), ('T4', 'T3');
     INSERT INTO brain_observations VALUES ('O-new-0', 'Task complete: T3', '2026-09-14 19:56:01');
     INSERT INTO tasks_widgets VALUES ('w1', '2026-09-15T00:00:00Z');`,
  );
  copyFileSync(target, pristine);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseStoreTimestamp', () => {
  it('reads datetime(now) text as UTC and orders it against ISO text correctly', () => {
    // As TEXT, '2026-09-14 19:56:01' < '2026-09-14T17:27' — the bug this avoids.
    expect(parseStoreTimestamp('2026-09-14 19:56:01')).toBeGreaterThan(
      parseStoreTimestamp('2026-09-14T17:27:42.313Z') ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe('importSplitBrain', () => {
  it('dry run plans the import and leaves the target byte-identical', () => {
    const before = sha(target);
    const report = importSplitBrain({ sourcePath: source, targetPath: target, dryRun: true });
    expect(sha(target)).toBe(before);
    expect(report.divergedAfter).toBe('2026-09-14T17:27:42.313Z');
    expect(report.sharedTasks).toBe(2);
    expect(report.mappings.filter((m) => m.table === 'tasks_tasks')).toEqual([
      { table: 'tasks_tasks', originalId: 'T3', newId: 'T008', reason: 'collision' },
      { table: 'tasks_tasks', originalId: 'T4', newId: 'T009', reason: 'source-only' },
    ]);
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ table: 'tasks_sessions', count: 1 }),
    );
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ table: 'tasks_task_acceptance_criteria', count: 1 }),
    );
    expect(report.unresolved).toEqual([
      expect.objectContaining({ table: 'tasks_widgets', count: 1 }),
    ]);
  });

  it('applies under new ids with provenance, and changes no pre-existing row', () => {
    const report = importSplitBrain({
      sourcePath: source,
      targetPath: target,
      dryRun: false,
      sourceLabel: '/home/x/checkout',
      provenanceTaskId: 'T2',
    });
    expect(report.rowsByTable).toEqual({
      tasks_tasks: 2,
      tasks_task_acceptance_criteria: 2,
      tasks_task_dependencies: 2,
      brain_observations: 1,
      tasks_audit_log: 3,
    });

    // The live T3 is untouched; the home T3/T4 are now T008/T009 with the tree intact.
    const tasks = rows(
      target,
      'SELECT id, title, parent_id, notes_json, idempotency_key FROM tasks_tasks ORDER BY id',
    );
    expect(tasks.find((t) => t['id'] === 'T3')?.['title']).toBe('live meaning');
    expect(tasks.find((t) => t['id'] === 'T008')).toMatchObject({
      title: 'home meaning',
      parent_id: 'T1',
    });
    expect(tasks.find((t) => t['id'] === 'T009')).toMatchObject({
      title: 'home child',
      parent_id: 'T008',
    });
    expect(String(tasks.find((t) => t['id'] === 'T008')?.['notes_json'])).toContain(
      'from /home/x/checkout, where this task was T3',
    );

    const acs = rows(
      target,
      'SELECT id, task_id, source_key, target_task_id, text FROM tasks_task_acceptance_criteria ORDER BY ordinal',
    );
    expect(acs).toEqual([
      {
        id: buildAcRowId('T008', 'it works'),
        task_id: 'T008',
        source_key: 'text:1:abc',
        target_task_id: null,
        text: 'it works',
      },
      {
        id: buildAcRowId('T008', 'child:T009'),
        task_id: 'T008',
        source_key: 'child:T009',
        target_task_id: 'T009',
        text: 'Complete child T009: home child',
      },
    ]);
    expect(
      rows(target, 'SELECT task_id, depends_on FROM tasks_task_dependencies ORDER BY depends_on'),
    ).toEqual([
      { task_id: 'T009', depends_on: 'T008' },
      { task_id: 'T009', depends_on: 'T2' },
    ]);

    const audit = rows(
      target,
      "SELECT task_id, details_json FROM tasks_audit_log WHERE action = 'split_brain_import'",
    );
    expect(audit.map((a) => a['task_id']).sort()).toEqual(['T008', 'T009', 'T2']);
    expect(audit.map((a) => JSON.parse(String(a['details_json'])).originalId).sort()).toEqual([
      'O-new-0',
      'T3',
      'T4',
    ]);

    const checks = verifyPreexistingRows(pristine, target);
    expect(checks.every((c) => c.missingOrChanged === 0)).toBe(true);
    const total = (key: 'before' | 'after') => checks.reduce((sum, c) => sum + c[key], 0);
    expect(total('after') - total('before')).toBe(10);
  });

  it('verification catches a changed pre-existing row', () => {
    importSplitBrain({
      sourcePath: source,
      targetPath: target,
      dryRun: false,
      provenanceTaskId: 'T2',
    });
    exec(target, "UPDATE tasks_tasks SET title = 'tampered' WHERE id = 'T3'");
    const changed = verifyPreexistingRows(pristine, target).filter((c) => c.missingOrChanged > 0);
    expect(changed).toEqual([
      expect.objectContaining({ table: 'tasks_tasks', missingOrChanged: 1 }),
    ]);
  });

  it('refuses to apply without a provenance anchor and writes nothing', () => {
    const before = sha(target);
    expect(() =>
      importSplitBrain({ sourcePath: source, targetPath: target, dryRun: false }),
    ).toThrow(/provenanceTaskId is required/);
    expect(sha(target)).toBe(before);
  });

  it('rolls the whole import back when any insert fails', () => {
    // A target-only row that collides with the first AC id the import will write.
    exec(
      target,
      'INSERT INTO tasks_task_acceptance_criteria VALUES (?, ?, 1, ?, ?, NULL, ?, ?)',
      buildAcRowId('T008', 'it works'),
      'T2',
      'text',
      'x',
      'x',
      '2026-09-16T00:00:00Z',
    );
    copyFileSync(target, pristine);
    expect(() =>
      importSplitBrain({
        sourcePath: source,
        targetPath: target,
        dryRun: false,
        provenanceTaskId: 'T2',
      }),
    ).toThrow(/UNIQUE/);
    expect(rows(target, "SELECT id FROM tasks_tasks WHERE id IN ('T008', 'T009')")).toEqual([]);
    expect(verifyPreexistingRows(pristine, target).every((c) => c.before === c.after)).toBe(true);
  });

  it('refuses two stores that were never one', () => {
    exec(target, 'DELETE FROM tasks_tasks');
    expect(() =>
      importSplitBrain({ sourcePath: source, targetPath: target, dryRun: true }),
    ).toThrow(/share no task/);
  });
});
