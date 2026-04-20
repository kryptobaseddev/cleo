/**
 * Tests for the BRAIN ingester.
 *
 * Uses a real in-memory DatabaseSync with a minimal brain_observations table.
 * No external services or file I/O.
 *
 * @task T1008
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  BRAIN_INGESTER_LIMIT,
  BRAIN_LOOKBACK_DAYS,
  computeBrainWeight,
  runBrainIngester,
} from '../ingesters/brain-ingester.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBrainDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE brain_observations (
      id TEXT PRIMARY KEY,
      title TEXT,
      text TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'decision',
      citation_count INTEGER NOT NULL DEFAULT 0,
      quality_score REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

function insertObservation(
  db: DatabaseSync,
  id: string,
  opts: {
    type?: string;
    citationCount?: number;
    qualityScore?: number;
    daysAgo?: number;
    title?: string;
  } = {},
) {
  const {
    type = 'decision',
    citationCount = 3,
    qualityScore = 0.8,
    daysAgo = 0,
    title = `Observation ${id}`,
  } = opts;

  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO brain_observations (id, title, type, citation_count, quality_score, created_at)
     VALUES (:id, :title, :type, :citationCount, :qualityScore, :createdAt)`,
  ).run({ id, title, type, citationCount, qualityScore, createdAt: date });
}

// ---------------------------------------------------------------------------
// runBrainIngester
// ---------------------------------------------------------------------------

describe('runBrainIngester', () => {
  it('returns empty array when nativeDb is null', () => {
    expect(runBrainIngester(null)).toEqual([]);
  });

  it('returns empty array when no observations match criteria (citation_count < 3)', () => {
    const db = createBrainDb();
    insertObservation(db, 'O1', { citationCount: 1 });
    insertObservation(db, 'O2', { citationCount: 2 });
    expect(runBrainIngester(db)).toHaveLength(0);
    db.close();
  });

  it('returns entries where citation_count >= 3 AND within 7 days AND quality_score >= 0.5', () => {
    const db = createBrainDb();
    insertObservation(db, 'O1', { citationCount: 3, qualityScore: 0.8, daysAgo: 1 });
    insertObservation(db, 'O2', { citationCount: 5, qualityScore: 0.9, daysAgo: 3 });
    const results = runBrainIngester(db);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.source === 'brain')).toBe(true);
    db.close();
  });

  it('excludes entries older than 7 days even if citation_count >= 3', () => {
    const db = createBrainDb();
    insertObservation(db, 'O1', { citationCount: 5, daysAgo: BRAIN_LOOKBACK_DAYS + 1 });
    insertObservation(db, 'O2', { citationCount: 3, daysAgo: 1 });
    const results = runBrainIngester(db);
    expect(results).toHaveLength(1);
    expect(results[0]?.sourceId).toBe('O2');
    db.close();
  });

  it('computes weight correctly using (citation_count / 10) * quality_score capped at 1.0', () => {
    const db = createBrainDb();
    insertObservation(db, 'O1', { citationCount: 5, qualityScore: 0.8, daysAgo: 0 });
    const results = runBrainIngester(db);
    expect(results).toHaveLength(1);
    const expected = computeBrainWeight(5, 0.8);
    expect(results[0]?.weight).toBeCloseTo(expected, 5);
    db.close();
  });

  it('caps weight at 1.0 for very high citation_count', () => {
    const db = createBrainDb();
    insertObservation(db, 'O1', { citationCount: 100, qualityScore: 1.0, daysAgo: 0 });
    const results = runBrainIngester(db);
    expect(results[0]?.weight).toBe(1.0);
    db.close();
  });

  it('returns at most BRAIN_INGESTER_LIMIT candidates', () => {
    const db = createBrainDb();
    for (let i = 0; i < BRAIN_INGESTER_LIMIT + 5; i++) {
      insertObservation(db, `O${i}`, { citationCount: 3 + i, daysAgo: 0 });
    }
    const results = runBrainIngester(db);
    expect(results.length).toBeLessThanOrEqual(BRAIN_INGESTER_LIMIT);
    db.close();
  });

  it('handles getBrainNativeDb-like failure gracefully (returns empty array)', () => {
    // Simulate a DB with missing table
    const db = new DatabaseSync(':memory:');
    // No brain_observations table — should return empty not throw
    const results = runBrainIngester(db);
    expect(results).toEqual([]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// computeBrainWeight
// ---------------------------------------------------------------------------

describe('computeBrainWeight', () => {
  it('calculates (citation_count / 10) * quality_score', () => {
    expect(computeBrainWeight(5, 0.8)).toBeCloseTo(0.4, 5);
    expect(computeBrainWeight(3, 0.5)).toBeCloseTo(0.15, 5);
  });

  it('caps weight at 1.0', () => {
    expect(computeBrainWeight(20, 1.0)).toBe(1.0);
    expect(computeBrainWeight(100, 1.0)).toBe(1.0);
  });
});
