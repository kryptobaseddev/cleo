/**
 * Recall excludes auto-generated BRAIN rows without deleting them (T13946).
 *
 * The clause is spliced into every recall query (find, digest, memory-bridge,
 * spawn bundle), so these tests run it as real SQL against the columns it
 * reads, through both an aliased and an unaliased outer query.
 *
 * @task T13946
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildTraceText } from '../dispatch-trace-format.js';
import { autoRowExclusionClause } from '../eligibility.js';

/** Minimal in-memory pattern and observation tables with the columns the clause reads. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:'); // db-open-allowed: in-memory test fixture
  db.exec(`
    CREATE TABLE brain_patterns (id TEXT PRIMARY KEY, pattern TEXT NOT NULL);
    CREATE TABLE brain_observations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      narrative TEXT,
      verified INTEGER,
      invalid_at TEXT
    );
  `);
  return db;
}

/** Ids returned by `sql`, sorted. */
function ids(db: DatabaseSync, sql: string): string[] {
  return db
    .prepare(sql)
    .all()
    .map((row) => String(row.id))
    .sort();
}

describe('autoRowExclusionClause (T13946)', () => {
  it('drops stored dispatch traces and keeps real patterns', () => {
    const db = makeDb();
    const trace = buildTraceText({
      taskId: '',
      predictedAgentId: 'cleo-subagent',
      confidence: 0,
      reason: 'universal-base fallback engaged after tiers: project, global',
      registryHit: false,
      fallbackUsed: true,
      resolvedAt: '2026-10-20T00:00:00.000Z',
    });
    const insert = db.prepare('INSERT INTO brain_patterns (id, pattern) VALUES (?, ?)');
    insert.run('P-trace', trace);
    insert.run('P-real', 'Run biome on the exact changed files before every push');
    expect(
      ids(
        db,
        `SELECT p.id FROM brain_patterns p WHERE 1=1${autoRowExclusionClause('patterns', 'p')}`,
      ),
    ).toEqual(['P-real']);
    db.close();
  });

  it('drops Doc attached records and task stubs, keeps task records with content', () => {
    const db = makeDb();
    const insert = db.prepare(
      'INSERT INTO brain_observations (id, title, narrative, verified) VALUES (?, ?, ?, ?)',
    );
    insert.run(
      'O-doc',
      'Doc attached: some-spec',
      JSON.stringify({ kind: 'doc-attachment', attachmentId: 'A1', ownerId: 'T1' }),
      0,
    );
    // A human note that only shares the title prefix stays in recall.
    insert.run('O-doc-human', 'doc attached: why we dropped X', 'We dropped X because Y', 0);
    insert.run('O-stub-done', 'Task complete: T1', 'Task T1 completed with status: done', 0);
    insert.run('O-stub-start', 'Task start: T2', 'Started work on T2: ', 0);
    insert.run('O-start-real', 'Task start: T3', 'Started work on T3: reproduce the WAL desync', 0);
    insert.run(
      'O-lesson',
      'Worktree incident',
      'cancel destroys the worktree named by the task',
      0,
    );
    insert.run('O-verified-stub', 'Task complete: T4', 'Task T4 completed with status: done', 1);
    const kept = ['O-doc-human', 'O-lesson', 'O-start-real', 'O-verified-stub'];
    expect(
      ids(
        db,
        `SELECT id FROM brain_observations WHERE 1=1${autoRowExclusionClause('observations')}`,
      ),
    ).toEqual(kept);
    expect(
      ids(
        db,
        `SELECT o.id FROM brain_observations o WHERE 1=1${autoRowExclusionClause('observations', 'o')}`,
      ),
    ).toEqual(kept);
    // Nothing is deleted: the rows stay for direct fetch and a later, owner-approved quarantine.
    expect(ids(db, 'SELECT id FROM brain_observations')).toHaveLength(7);
    db.close();
  });

  it('adds nothing for decisions and learnings', () => {
    expect(autoRowExclusionClause('decisions')).toBe('');
    expect(autoRowExclusionClause('learnings')).toBe('');
  });
});
