/**
 * Tests for temporal-supersession.ts — audit-trail supersession for CLEO BRAIN.
 *
 * Covers:
 *   - supersedeMemory: marks old as invalid, creates supersedes edge
 *   - detectSupersession: finds high-overlap candidates on fresh entries
 *   - getSupersessionChain: traverses supersedes edges newest→oldest
 *   - isLatest: checks invalid_at IS NULL
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('temporal-supersession', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-supersession-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // supersedeMemory
  // ---------------------------------------------------------------------------

  describe('supersedeMemory', () => {
    it('marks the old entry as invalid (sets invalid_at)', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { supersedeMemory, isLatest } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      const old = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use SQLite for storage',
        rationale: 'Simple and reliable',
        confidence: 'high',
      });
      closeBrainDb();

      const replacement = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use PostgreSQL for storage',
        rationale: 'Better concurrency',
        confidence: 'high',
      });
      closeBrainDb();

      // Both should be latest before supersession
      expect(await isLatest(tempDir, old.id)).toBe(true);
      expect(await isLatest(tempDir, replacement.id)).toBe(true);
      closeBrainDb();

      const result = await supersedeMemory(
        tempDir,
        old.id,
        replacement.id,
        'PostgreSQL chosen for production scalability',
      );
      closeBrainDb();

      expect(result.success).toBe(true);
      expect(result.oldId).toBe(old.id);
      expect(result.newId).toBe(replacement.id);
      expect(result.edgeType).toBe('supersedes');

      // Old entry is now invalid; replacement remains valid
      expect(await isLatest(tempDir, old.id)).toBe(false);
      closeBrainDb();
      expect(await isLatest(tempDir, replacement.id)).toBe(true);
    });

    it('creates a supersedes graph edge from new to old', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { supersedeMemory } = await import('../temporal-supersession.js');
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();

      const old = await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Monorepo layout',
        rationale: 'Shared tooling',
        confidence: 'medium',
      });
      closeBrainDb();

      const replacement = await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Polyrepo layout',
        rationale: 'Independent deployments',
        confidence: 'high',
      });
      closeBrainDb();

      await supersedeMemory(tempDir, old.id, replacement.id, 'scale requirements changed');
      closeBrainDb();

      // Verify edge in brain_page_edges
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      expect(nativeDb).not.toBeNull();

      const edge = nativeDb!
        .prepare(
          `SELECT from_id, to_id, edge_type, provenance
           FROM brain_page_edges
           WHERE edge_type = 'supersedes'
             AND to_id = ?`,
        )
        .get(`decision:${old.id}`) as
        | {
            from_id: string;
            to_id: string;
            edge_type: string;
            provenance: string;
          }
        | undefined;

      expect(edge).toBeDefined();
      expect(edge!.from_id).toBe(`decision:${replacement.id}`);
      expect(edge!.to_id).toBe(`decision:${old.id}`);
      expect(edge!.edge_type).toBe('supersedes');
      expect(edge!.provenance).toBe('scale requirements changed');
    });

    it('stores the reason as edge provenance (up to 500 chars)', async () => {
      const { storeLearning } = await import('../learnings.js');
      const { supersedeMemory } = await import('../temporal-supersession.js');
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();

      const old = await storeLearning(tempDir, {
        insight: 'Always use transactions for multi-step writes',
        source: 'manual',
        confidence: 0.9,
      });
      closeBrainDb();

      const replacement = await storeLearning(tempDir, {
        insight: 'Prefer batch inserts over individual transactions for bulk writes',
        source: 'manual',
        confidence: 0.95,
      });
      closeBrainDb();

      const reason = 'Performance testing revealed batch insert is 10x faster';
      await supersedeMemory(tempDir, old.id, replacement.id, reason);
      closeBrainDb();

      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      const edge = nativeDb!
        .prepare(
          `SELECT provenance FROM brain_page_edges
           WHERE edge_type = 'supersedes' AND to_id = ?`,
        )
        .get(`learning:${old.id}`) as { provenance: string } | undefined;

      expect(edge?.provenance).toBe(reason);
    });

    it('does NOT delete the old entry (audit trail preserved)', async () => {
      const { storeLearning } = await import('../learnings.js');
      const { supersedeMemory } = await import('../temporal-supersession.js');
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();

      const old = await storeLearning(tempDir, {
        insight: 'Use camelCase for TypeScript variables',
        source: 'manual',
        confidence: 0.8,
      });
      closeBrainDb();

      const replacement = await storeLearning(tempDir, {
        insight: 'Follow the project ESLint config for all naming conventions',
        source: 'manual',
        confidence: 0.95,
      });
      closeBrainDb();

      await supersedeMemory(tempDir, old.id, replacement.id, 'style guide updated');
      closeBrainDb();

      // Old entry must still exist in the table
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      const row = nativeDb!
        .prepare(`SELECT id, insight, invalid_at FROM brain_learnings WHERE id = ?`)
        .get(old.id) as { id: string; insight: string; invalid_at: string | null } | undefined;

      expect(row).toBeDefined();
      expect(row!.id).toBe(old.id);
      expect(row!.insight).toBe('Use camelCase for TypeScript variables');
      expect(row!.invalid_at).not.toBeNull(); // marked invalid but not deleted
    });

    it('throws when oldId equals newId', async () => {
      const { supersedeMemory } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      await expect(supersedeMemory(tempDir, 'D001', 'D001', 'self')).rejects.toThrow(
        'must be different',
      );
    });

    it('throws when reason is empty', async () => {
      const { supersedeMemory } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      await expect(supersedeMemory(tempDir, 'D001', 'D002', '')).rejects.toThrow(
        'reason is required',
      );
    });

    it('throws when oldId is not found', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { supersedeMemory } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      const real = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use Redis for caching',
        rationale: 'Low latency',
        confidence: 'high',
      });
      closeBrainDb();

      await expect(supersedeMemory(tempDir, 'NONEXISTENT', real.id, 'reason')).rejects.toThrow(
        'Entry not found',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // detectSupersession
  // ---------------------------------------------------------------------------

  describe('detectSupersession', () => {
    it('returns empty array when no similar entries exist', async () => {
      const { detectSupersession } = await import('../temporal-supersession.js');
      const { storeDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      const d = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use Redis for caching',
        rationale: 'Low latency reads',
        confidence: 'high',
      });
      closeBrainDb();

      // Provide a completely different text so no overlap threshold is met
      const candidates = await detectSupersession(tempDir, {
        id: d.id,
        text: 'Completely unrelated topic about database migrations',
        createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
      closeBrainDb();

      expect(candidates).toEqual([]);
    });

    it('detects high-overlap entries as candidates', async () => {
      const { storeLearning } = await import('../learnings.js');
      const { detectSupersession } = await import('../temporal-supersession.js');
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();

      // Store an older learning first with a back-dated timestamp
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      const pastDate = '2025-01-01 00:00:00';
      nativeDb!
        .prepare(
          `INSERT INTO brain_learnings (id, insight, source, confidence, applicable_types_json, memory_tier, memory_type, source_confidence, verified, valid_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'L-OLDIE001',
          'pnpm workspace filters using --filter flag for targeted builds',
          'manual',
          0.8,
          '[]',
          'medium',
          'semantic',
          'owner',
          1,
          pastDate,
          pastDate,
        );
      closeBrainDb();

      // Store a new learning with highly overlapping text
      const newEntry = await storeLearning(tempDir, {
        insight:
          'pnpm workspace filters using --filter flag for targeted builds with recursive mode',
        source: 'manual',
        confidence: 0.9,
      });
      closeBrainDb();

      const nowish = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const candidates = await detectSupersession(tempDir, {
        id: newEntry.id,
        text: 'pnpm workspace filters using --filter flag for targeted builds with recursive mode',
        createdAt: nowish,
      });
      closeBrainDb();

      // L-OLDIE001 should appear as a candidate (high keyword overlap)
      const found = candidates.find((c) => c.existingId === 'L-OLDIE001');
      expect(found).toBeDefined();
      expect(found!.similarity).toBeGreaterThanOrEqual(0.8);
    });

    it('returns empty array on DB unavailability (best-effort)', async () => {
      const { detectSupersession } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      // Use a non-existent project root so brain.db cannot be opened
      const result = await detectSupersession('/tmp/nonexistent-project-xyz-cleo', {
        id: 'D001',
        text: 'some text',
        createdAt: '2026-01-01 00:00:00',
      });

      // Best-effort: should return empty, not throw
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getSupersessionChain
  // ---------------------------------------------------------------------------

  describe('getSupersessionChain', () => {
    it('returns a single-entry chain for the latest version (no predecessors)', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { getSupersessionChain } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      const d = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use Vitest for testing',
        rationale: 'Fast and compatible with ESM',
        confidence: 'high',
      });
      closeBrainDb();

      const chain = await getSupersessionChain(tempDir, d.id);
      closeBrainDb();

      // The entry has no supersedes edges yet — chain contains just itself
      expect(chain.entryId).toBe(d.id);
      expect(chain.chain).toHaveLength(1);
      expect(chain.chain[0]!.entryId).toBe(d.id);
      expect(chain.chain[0]!.isLatest).toBe(true);
      expect(chain.chain[0]!.supersededReason).toBeNull();
    });

    it('returns ordered chain [newest → oldest] across two versions', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { supersedeMemory, getSupersessionChain } = await import('../temporal-supersession.js');
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();

      // v1
      const v1 = await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Deploy to Heroku',
        rationale: 'Simple PaaS',
        confidence: 'medium',
      });
      closeBrainDb();

      // v2
      const v2 = await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Deploy to AWS ECS',
        rationale: 'Better control and cost at scale',
        confidence: 'high',
      });
      closeBrainDb();

      // Insert graph nodes directly via raw SQL so the chain traversal can find them.
      // This avoids the need to mock the read-only isAutoCaptureEnabled export.
      await getBrainDb(tempDir);
      const nativeDb2 = getBrainNativeDb()!;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      nativeDb2
        .prepare(
          `INSERT OR IGNORE INTO brain_page_nodes (id, node_type, label, quality_score, created_at, last_activity_at)
           VALUES (?, 'decision', ?, ?, ?, ?)`,
        )
        .run(`decision:${v1.id}`, v1.decision, 0.7, now, now);
      nativeDb2
        .prepare(
          `INSERT OR IGNORE INTO brain_page_nodes (id, node_type, label, quality_score, created_at, last_activity_at)
           VALUES (?, 'decision', ?, ?, ?, ?)`,
        )
        .run(`decision:${v2.id}`, v2.decision, 0.9, now, now);
      closeBrainDb();

      await supersedeMemory(tempDir, v1.id, v2.id, 'moved to AWS for production');
      closeBrainDb();

      // Trace chain starting from v2 (the newest)
      const chain = await getSupersessionChain(tempDir, v2.id);
      closeBrainDb();

      expect(chain.entryId).toBe(v2.id);
      // v2 is newest (chain[0]) → v1 is the superseded older version (chain[1])
      expect(chain.chain).toHaveLength(2);
      expect(chain.chain[0]!.entryId).toBe(v2.id);
      expect(chain.chain[0]!.isLatest).toBe(true);
      expect(chain.chain[1]!.entryId).toBe(v1.id);
      expect(chain.chain[1]!.isLatest).toBe(false);
      expect(chain.chain[1]!.supersededReason).toBe('moved to AWS for production');
    });

    it('returns empty chain for unknown entryId', async () => {
      const { getSupersessionChain } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      // Initialise the DB (needed to call getBrainDb internally)
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);
      closeBrainDb();

      const chain = await getSupersessionChain(tempDir, 'NONEXISTENT-ID');
      closeBrainDb();

      expect(chain.entryId).toBe('NONEXISTENT-ID');
      expect(chain.chain).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // isLatest
  // ---------------------------------------------------------------------------

  describe('isLatest', () => {
    it('returns true for a freshly-stored entry (invalid_at IS NULL)', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { isLatest } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      const d = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use TypeScript strict mode',
        rationale: 'Catches bugs early',
        confidence: 'high',
      });
      closeBrainDb();

      expect(await isLatest(tempDir, d.id)).toBe(true);
    });

    it('returns false after the entry is superseded', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { supersedeMemory, isLatest } = await import('../temporal-supersession.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      const old = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use Jest for testing',
        rationale: 'Wide ecosystem',
        confidence: 'medium',
      });
      closeBrainDb();

      const replacement = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use Vitest for testing',
        rationale: 'Faster and ESM-native',
        confidence: 'high',
      });
      closeBrainDb();

      expect(await isLatest(tempDir, old.id)).toBe(true);
      closeBrainDb();

      await supersedeMemory(tempDir, old.id, replacement.id, 'Vitest is faster');
      closeBrainDb();

      expect(await isLatest(tempDir, old.id)).toBe(false);
      closeBrainDb();
      expect(await isLatest(tempDir, replacement.id)).toBe(true);
    });

    it('returns false for an unknown entryId', async () => {
      const { isLatest } = await import('../temporal-supersession.js');
      const { getBrainDb, closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      await getBrainDb(tempDir);
      closeBrainDb();

      expect(await isLatest(tempDir, 'NONEXISTENT-ID')).toBe(false);
    });
  });
});
