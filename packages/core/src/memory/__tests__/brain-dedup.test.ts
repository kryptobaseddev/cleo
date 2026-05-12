/**
 * Tests for T1896 — dedupePatterns: near-duplicate pattern dedup at consolidation time.
 *
 * Uses a real in-process SQLite DB (via mkdtemp) to validate that:
 * - 3 near-identical patterns within a 21s window collapse to 1 row
 * - occurrence_count is summed correctly
 * - last_seen_at is set to the most-recent duplicate's timestamp
 * - rows outside the time window are NOT collapsed
 * - rows with different normalized titles are NOT collapsed
 *
 * @task T1896
 * @epic T1892
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('dedupePatterns', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-dedup-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Initialize tasks.db (required by cross-db write-guard)
    const { getDb } = await import('../../store/sqlite.js');
    const { sessions } = await import('../../store/tasks-schema.js');
    const db = await getDb(tempDir);
    await db
      .insert(sessions)
      .values({ id: 'S-dedup-test', name: 'dedup-test', status: 'active' })
      .onConflictDoNothing()
      .run();
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('collapses 3 near-identical patterns within 21s window to 1 row with occurrence_count=3', async () => {
    const { dedupePatterns } = await import('../brain-consolidator.js');
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    closeBrainDb();

    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    // Insert 3 identical patterns within a 21-second window
    const base = '2026-04-24T10:00:00.000Z';
    const t1 = '2026-04-24T10:00:07.000Z';
    const t2 = '2026-04-24T10:00:14.000Z';
    const t3 = '2026-04-24T10:00:21.000Z';

    for (const [id, ts] of [
      ['P-dup-1', t1],
      ['P-dup-2', t2],
      ['P-dup-3', t3],
    ]) {
      nativeDb
        .prepare(
          `INSERT INTO brain_patterns (id, type, pattern, context, frequency, extracted_at, peer_id, peer_scope, memory_tier, memory_type, verified, valid_at, quality_score, content_hash)
         VALUES (?, 'workflow', 'Agent type X fails on task type Y', 'test context', 1, ?, 'global', 'project', 'medium', 'procedural', 0, ?, 0.5, ?)`,
        )
        .run(id, ts, ts, `hash-${id}`);
    }
    void base;

    const removed = await dedupePatterns(tempDir, 3600);

    // Should have removed 2 rows (kept 1)
    expect(removed).toBe(2);

    // Only the oldest (P-dup-1) should remain
    const remaining = nativeDb
      .prepare('SELECT id, occurrence_count, last_seen_at FROM brain_patterns WHERE id LIKE ?')
      .all('P-dup-%') as Array<{ id: string; occurrence_count: number; last_seen_at: string }>;

    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('P-dup-1');
    // occurrence_count should be 1 (self) + 2 (collapsed) = 3
    expect(remaining[0].occurrence_count).toBe(3);
    // last_seen_at should be the most recent duplicate timestamp
    expect(remaining[0].last_seen_at).toBe(t3);
  });

  it('does NOT collapse patterns outside the time window', async () => {
    const { dedupePatterns } = await import('../brain-consolidator.js');
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    closeBrainDb();

    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    // Two identical patterns but 2 hours apart — should NOT be deduped with 1hr window
    nativeDb
      .prepare(
        `INSERT INTO brain_patterns (id, type, pattern, context, frequency, extracted_at, peer_id, peer_scope, memory_tier, memory_type, verified, valid_at, quality_score, content_hash)
       VALUES ('P-far-1', 'workflow', 'Use pnpm for all installs', 'build context', 1, '2026-04-24T08:00:00.000Z', 'global', 'project', 'medium', 'procedural', 0, '2026-04-24T08:00:00.000Z', 0.5, 'hash-far-1')`,
      )
      .run();
    nativeDb
      .prepare(
        `INSERT INTO brain_patterns (id, type, pattern, context, frequency, extracted_at, peer_id, peer_scope, memory_tier, memory_type, verified, valid_at, quality_score, content_hash)
       VALUES ('P-far-2', 'workflow', 'Use pnpm for all installs', 'build context', 1, '2026-04-24T10:30:00.000Z', 'global', 'project', 'medium', 'procedural', 0, '2026-04-24T10:30:00.000Z', 0.5, 'hash-far-2')`,
      )
      .run();

    const removed = await dedupePatterns(tempDir, 3600);
    expect(removed).toBe(0);

    const remaining = nativeDb
      .prepare('SELECT id FROM brain_patterns WHERE id LIKE ?')
      .all('P-far-%') as Array<{ id: string }>;
    expect(remaining).toHaveLength(2);
  });

  it('does NOT collapse patterns with different normalized titles', async () => {
    const { dedupePatterns } = await import('../brain-consolidator.js');
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    closeBrainDb();

    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    const ts = '2026-04-24T10:00:00.000Z';
    nativeDb
      .prepare(
        `INSERT INTO brain_patterns (id, type, pattern, context, frequency, extracted_at, peer_id, peer_scope, memory_tier, memory_type, verified, valid_at, quality_score, content_hash)
       VALUES ('P-diff-1', 'workflow', 'Always run biome before committing', 'qa context', 1, ?, 'global', 'project', 'medium', 'procedural', 0, ?, 0.5, 'hash-diff-1')`,
      )
      .run(ts, ts);
    nativeDb
      .prepare(
        `INSERT INTO brain_patterns (id, type, pattern, context, frequency, extracted_at, peer_id, peer_scope, memory_tier, memory_type, verified, valid_at, quality_score, content_hash)
       VALUES ('P-diff-2', 'workflow', 'Never skip linting steps', 'qa context', 1, ?, 'global', 'project', 'medium', 'procedural', 0, ?, 0.5, 'hash-diff-2')`,
      )
      .run(ts, ts);

    const removed = await dedupePatterns(tempDir, 3600);
    expect(removed).toBe(0);

    const remaining = nativeDb
      .prepare('SELECT id FROM brain_patterns WHERE id LIKE ?')
      .all('P-diff-%') as Array<{ id: string }>;
    expect(remaining).toHaveLength(2);
  });
});
