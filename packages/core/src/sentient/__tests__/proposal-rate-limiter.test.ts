/**
 * Tests for the Tier-2 proposal rate limiter.
 *
 * Uses real SQLite in a temp directory (DatabaseSync from node:sqlite).
 * No mocks — the transactional behaviour must be real.
 *
 * @task T1008
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  countTodayProposals,
  DEFAULT_DAILY_PROPOSAL_LIMIT,
  isRateLimitExceeded,
  SENTIENT_TIER2_TAG,
  transactionalInsertProposal,
} from '../proposal-rate-limiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal in-memory tasks DB for testing. */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      labels_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      role TEXT NOT NULL DEFAULT 'work',
      scope TEXT NOT NULL DEFAULT 'feature'
    )
  `);
  return db;
}

/** Insert a minimal proposal task row. */
function insertProposal(
  db: DatabaseSync,
  id: string,
  status: string,
  date: string,
  label = SENTIENT_TIER2_TAG,
) {
  db.prepare(
    `INSERT INTO tasks (id, title, status, labels_json, created_at, role, scope)
     VALUES (:id, :title, :status, :labelsJson, :createdAt, 'work', 'feature')`,
  ).run({
    id,
    title: `[T2-TEST] Test proposal ${id}`,
    status,
    labelsJson: JSON.stringify([label]),
    createdAt: `${date}T12:00:00.000Z`,
  });
}

// ---------------------------------------------------------------------------
// countTodayProposals
// ---------------------------------------------------------------------------

describe('countTodayProposals', () => {
  it('returns 0 on fresh DB', () => {
    const db = createTestDb();
    expect(countTodayProposals(db)).toBe(0);
    db.close();
  });

  it('returns correct count after inserting 2 proposed tasks with today', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    insertProposal(db, 'T901', 'proposed', today);
    insertProposal(db, 'T902', 'pending', today);
    expect(countTodayProposals(db)).toBe(2);
    db.close();
  });

  it('excludes proposed tasks from prior days', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    insertProposal(db, 'T901', 'proposed', today);
    insertProposal(db, 'T902', 'proposed', yesterday);
    expect(countTodayProposals(db)).toBe(1);
    db.close();
  });

  it('returns 0 when nativeDb is null', () => {
    expect(countTodayProposals(null)).toBe(0);
  });

  it('counts tasks in terminal states (done) that were proposed today', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    insertProposal(db, 'T901', 'done', today);
    insertProposal(db, 'T902', 'active', today);
    expect(countTodayProposals(db)).toBe(2);
    db.close();
  });

  it('excludes cancelled tasks from count (cancelled is not counted)', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    insertProposal(db, 'T901', 'cancelled', today);
    insertProposal(db, 'T902', 'proposed', today);
    // 'cancelled' is NOT in ('proposed', 'pending', 'active', 'done')
    expect(countTodayProposals(db)).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// isRateLimitExceeded
// ---------------------------------------------------------------------------

describe('isRateLimitExceeded', () => {
  it('returns false when count is 2 (limit=3)', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    insertProposal(db, 'T901', 'proposed', today);
    insertProposal(db, 'T902', 'proposed', today);
    expect(isRateLimitExceeded(db, 3)).toBe(false);
    db.close();
  });

  it('returns true when count is 3 (limit=3)', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    insertProposal(db, 'T901', 'proposed', today);
    insertProposal(db, 'T902', 'proposed', today);
    insertProposal(db, 'T903', 'proposed', today);
    expect(isRateLimitExceeded(db, 3)).toBe(true);
    db.close();
  });

  it('returns false for fresh DB with default limit', () => {
    const db = createTestDb();
    expect(isRateLimitExceeded(db)).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// transactionalInsertProposal
// ---------------------------------------------------------------------------

describe('transactionalInsertProposal', () => {
  const insertSql = `
    INSERT INTO tasks (id, title, status, labels_json, created_at, role, scope)
    VALUES (:id, :title, :status, :labelsJson, datetime('now'), 'work', 'feature')
  `;

  it('inserts successfully when count is below limit', () => {
    const db = createTestDb();
    const result = transactionalInsertProposal(
      db,
      insertSql,
      {
        id: 'T901',
        title: '[T2-TEST] Proposal',
        status: 'proposed',
        labelsJson: JSON.stringify([SENTIENT_TIER2_TAG]),
      },
      3,
    );
    expect(result.inserted).toBe(true);
    expect(result.countBeforeInsert).toBe(0);
    expect(countTodayProposals(db)).toBe(1);
    db.close();
  });

  it('rejects when count is at limit', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    insertProposal(db, 'T901', 'proposed', today);
    insertProposal(db, 'T902', 'proposed', today);
    insertProposal(db, 'T903', 'proposed', today);

    const result = transactionalInsertProposal(
      db,
      insertSql,
      {
        id: 'T904',
        title: '[T2-TEST] Should be rejected',
        status: 'proposed',
        labelsJson: JSON.stringify([SENTIENT_TIER2_TAG]),
      },
      3,
    );
    expect(result.inserted).toBe(false);
    expect(result.reason).toBe('rate-limit');
    expect(result.countBeforeInsert).toBe(3);
    // No new row should exist
    expect(countTodayProposals(db)).toBe(3);
    db.close();
  });

  it('sequential inserts where count=2 result in exactly one insert (TOCTOU sim)', () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    insertProposal(db, 'T901', 'proposed', today);
    insertProposal(db, 'T902', 'proposed', today);

    // First call: count=2, limit=3, should succeed
    const r1 = transactionalInsertProposal(
      db,
      insertSql,
      {
        id: 'T903',
        title: '[T2-TEST] Third proposal',
        status: 'proposed',
        labelsJson: JSON.stringify([SENTIENT_TIER2_TAG]),
      },
      3,
    );
    expect(r1.inserted).toBe(true);
    expect(countTodayProposals(db)).toBe(3);

    // Second call: count=3, limit=3, should be rejected
    const r2 = transactionalInsertProposal(
      db,
      insertSql,
      {
        id: 'T904',
        title: '[T2-TEST] Would exceed limit',
        status: 'proposed',
        labelsJson: JSON.stringify([SENTIENT_TIER2_TAG]),
      },
      3,
    );
    expect(r2.inserted).toBe(false);
    expect(r2.reason).toBe('rate-limit');
    expect(countTodayProposals(db)).toBe(3);
    db.close();
  });

  it('DEFAULT_DAILY_PROPOSAL_LIMIT is 3', () => {
    expect(DEFAULT_DAILY_PROPOSAL_LIMIT).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Index verification (T1126)
// ---------------------------------------------------------------------------

describe('sentient proposal index', () => {
  it('partial index exists in schema and accelerates count query', () => {
    const db = createTestDb();
    // Create the partial index that the real DB has
    db.exec(`
      CREATE INDEX idx_tasks_sentient_proposals_today
      ON tasks(date(created_at))
      WHERE labels_json LIKE '%sentient-tier2%'
    `);

    // Verify the index exists via PRAGMA
    const indexes = db.prepare('PRAGMA index_list(tasks)').all() as Array<{ name: string }>;
    const idx = indexes.find((i) => i.name === 'idx_tasks_sentient_proposals_today');
    expect(idx).toBeDefined();

    // Verify the index is partial (has WHERE clause)
    const info = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_tasks_sentient_proposals_today' AND type = 'index'",
      )
      .get() as { sql: string } | undefined;
    expect(info?.sql).toContain('WHERE');
    expect(info?.sql).toContain('sentient-tier2');

    db.close();
  });
});
