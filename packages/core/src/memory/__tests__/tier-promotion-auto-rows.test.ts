/**
 * Tier promotion never promotes auto rows (T13947).
 *
 * Until T13947 every memory read bumped citation_count, so dispatch traces and
 * doc-attachment records collected citations they never earned. Promotion now
 * skips them whatever their count; real rows still promote on citations.
 * Runs the real SQL against an in-memory store.
 *
 * @task T13947
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTraceText } from '../dispatch-trace-format.js';

const { nativeDb } = vi.hoisted(() => ({ nativeDb: { current: null as DatabaseSync | null } }));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: vi.fn().mockResolvedValue({}),
  getBrainNativeDb: () => nativeDb.current,
}));

import { runTierPromotion } from '../brain-lifecycle.js';

const LIFECYCLE = `memory_tier TEXT, invalid_at TEXT, citation_count INTEGER DEFAULT 0,
  quality_score REAL, verified INTEGER DEFAULT 0, updated_at TEXT,
  tier_promoted_at TEXT, tier_promotion_reason TEXT`;

/** In-memory store with the columns promotion and the auto-row clause read. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:'); // db-open-allowed: in-memory test fixture
  db.exec(`
    CREATE TABLE brain_patterns (id TEXT PRIMARY KEY, pattern TEXT, extracted_at TEXT, ${LIFECYCLE});
    CREATE TABLE brain_observations (id TEXT PRIMARY KEY, title TEXT, narrative TEXT, created_at TEXT, ${LIFECYCLE});
    CREATE TABLE brain_learnings (id TEXT PRIMARY KEY, insight TEXT, created_at TEXT, ${LIFECYCLE});
    CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, decision TEXT, created_at TEXT, ${LIFECYCLE});
  `);
  return db;
}

const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
  .toISOString()
  .replace('T', ' ')
  .slice(0, 19);

afterEach(() => {
  nativeDb.current?.close();
  nativeDb.current = null;
});

describe('runTierPromotion skips auto rows (T13947)', () => {
  it('promotes a cited real row and leaves an equally cited auto row in place', async () => {
    const db = makeDb();
    nativeDb.current = db;
    const trace = buildTraceText({
      taskId: '',
      predictedAgentId: 'cleo-subagent',
      confidence: 0,
      reason: 'universal-base fallback',
      registryHit: false,
      fallbackUsed: true,
      resolvedAt: '2026-10-01T00:00:00.000Z',
    });
    const pattern = db.prepare(
      `INSERT INTO brain_patterns (id, pattern, extracted_at, memory_tier, citation_count)
       VALUES (?, ?, ?, 'medium', 12)`,
    );
    pattern.run('P-trace', trace, tenDaysAgo);
    pattern.run('P-real', 'Run biome on the exact changed files before push', tenDaysAgo);
    const observation = db.prepare(
      `INSERT INTO brain_observations (id, title, narrative, created_at, memory_tier, citation_count)
       VALUES (?, ?, ?, ?, 'short', 9)`,
    );
    observation.run(
      'O-doc',
      'Doc attached: spec',
      JSON.stringify({ kind: 'doc-attachment', attachmentId: 'A1', ownerId: 'T1' }),
      tenDaysAgo,
    );
    db.prepare(
      `INSERT INTO brain_observations (id, title, narrative, created_at, memory_tier, citation_count)
       VALUES ('O-real', 'Worktree incident', 'cancel destroys the named worktree', ?, 'short', 4)`,
    ).run(tenDaysAgo);

    const result = await runTierPromotion('/fake/project');

    expect(result.promoted.map((p) => p.id).sort()).toEqual(['O-real', 'P-real']);
    const tier = (table: string, id: string) =>
      db.prepare(`SELECT memory_tier FROM ${table} WHERE id = ?`).get(id)?.memory_tier;
    expect(tier('brain_patterns', 'P-trace')).toBe('medium');
    expect(tier('brain_patterns', 'P-real')).toBe('long');
    expect(tier('brain_observations', 'O-real')).toBe('medium');
  });
});
