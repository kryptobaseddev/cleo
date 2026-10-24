/**
 * Auto rows never collect citations or feed promotion and proposals (T13975,
 * T13976, T13977). Reads stopped bumping `citation_count` in T13947, but the
 * extraction gate's merge, typed promotion and the sentient brain ingester
 * still ranked on counts that auto rows (doc-attachment records, task stubs)
 * had collected. Runs the real SQL against an in-memory store.
 *
 * @task T13975
 * @task T13976
 * @task T13977
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: { db: null as DatabaseSync | null } }));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: vi.fn(async () => drizzle({ client: store.db! })),
  getBrainNativeDb: () => store.db,
}));

import { runBrainIngester } from '../../sentient/ingesters/brain-ingester.js';
import { promoteObservationsToTyped } from '../brain-lifecycle.js';
import { verifyCandidate } from '../extraction-gate.js';

const docText = JSON.stringify({ kind: 'doc-attachment', attachmentId: 'A1', ownerId: 'T1' });
const realText = 'cancel destroys the worktree named after the task';
const hash = (text: string) =>
  createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 16);
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'auto-row-citations-'));
  const db = new DatabaseSync(':memory:'); // db-open-allowed: in-memory test fixture
  db.exec(`
    CREATE TABLE brain_observations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, narrative TEXT, content_hash TEXT,
      created_at TEXT, invalid_at TEXT, citation_count INTEGER DEFAULT 0, quality_score REAL,
      stability_score REAL, verified INTEGER DEFAULT 0, memory_tier TEXT
    );
    CREATE TABLE brain_promotion_log (
      id TEXT PRIMARY KEY, observation_id TEXT, from_tier TEXT, to_tier TEXT, score REAL,
      decided_at TEXT, decided_by TEXT, rationale_json TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO brain_observations
       (id, type, title, narrative, content_hash, created_at, citation_count, quality_score, verified, memory_tier)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0.9, 1, 'short')`,
  );
  insert.run('O-doc', 'decision', 'Doc attached: spec', docText, hash(docText), now, 40);
  insert.run('O-real', 'decision', 'Worktree incident', realText, hash(realText), now, 40);
  store.db = db;
});

afterEach(() => {
  store.db?.close();
  store.db = null;
  rmSync(root, { recursive: true, force: true });
});

const citations = (id: string): number =>
  Number(
    store.db!.prepare('SELECT citation_count AS c FROM brain_observations WHERE id = ?').get(id)?.c,
  );

describe('auto rows and citations (T13975, T13976, T13977)', () => {
  it('the extraction gate merges into both rows but cites only the real one (T13975)', async () => {
    for (const text of [docText, realText]) {
      const result = await verifyCandidate(root, {
        text,
        memoryType: 'episodic',
        tier: 'short',
        confidence: 0.9,
        source: 'manual',
      });
      expect(result.action).toBe('merged');
    }
    expect(citations('O-doc')).toBe(40);
    expect(citations('O-real')).toBe(41);
  });

  it('typed promotion never promotes a highly cited auto row (T13976)', async () => {
    const result = await promoteObservationsToTyped(root, 100, 0);
    expect(result.promoted.map((p) => p.observationId)).toEqual(['O-real']);
  });

  it('the sentient brain ingester proposes nothing from an auto row (T13977)', () => {
    const proposals = runBrainIngester(store.db);
    expect(proposals.map((p) => p.title)).toEqual([
      '[T2-BRAIN] Recurring issue: Worktree incident',
    ]);
  });
});
