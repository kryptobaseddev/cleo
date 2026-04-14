/**
 * Tests for graph-memory-bridge.ts
 *
 * Validates the four public functions:
 *   - linkMemoryToCode  (manual edge creation)
 *   - autoLinkMemories  (entity extraction + auto-linking)
 *   - queryMemoriesForCode  (traverse code→memory edges)
 *   - queryCodeForMemory   (traverse memory→code edges)
 *   - listCodeLinks        (list all code_reference edges)
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Ensure no leaked path mocks from other tests in the same vitest shard
// pollute this integration test (which uses real SQLite + real paths).
vi.unmock('../../paths.js');
vi.unmock('../../store/brain-sqlite.js');
vi.unmock('../../store/nexus-sqlite.js');

let tempDir: string;

describe('graph-memory-bridge', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-gmb-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    // nexus.db is global (ADR-036) — point CLEO_HOME to temp dir so
    // getNexusDb() creates it here instead of ~/.cleo/ on CI.
    process.env['CLEO_HOME'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/brain-sqlite.js');
    const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
    closeBrainDb();
    resetNexusDbState();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_HOME'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Seed a brain page node directly. */
  async function seedBrainNode(
    id: string,
    label: string,
    nodeType = 'observation',
    qualityScore = 0.7,
  ): Promise<void> {
    const { getBrainDb } = await import('../../store/brain-sqlite.js');
    const { brainPageNodes } = await import('../../store/brain-schema.js');
    const db = await getBrainDb(tempDir);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db
      .insert(brainPageNodes)
      .values({
        id,
        nodeType: nodeType as import('../../store/brain-schema.js').BrainNodeType,
        label,
        qualityScore,
        contentHash: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  /** Seed a nexus node directly. */
  async function seedNexusNode(
    id: string,
    label: string,
    name: string | null,
    filePath: string | null,
    kind = 'function',
  ): Promise<void> {
    const { getNexusDb } = await import('../../store/nexus-sqlite.js');
    const { nexusNodes } = await import('../../store/nexus-schema.js');

    const db = await getNexusDb();
    await db
      .insert(nexusNodes)
      .values({
        id,
        projectId: 'test-project',
        kind: kind as import('../../store/nexus-schema.js').NexusNodeKind,
        label,
        name,
        filePath,
      })
      .onConflictDoNothing();
  }

  // ---------------------------------------------------------------------------
  // linkMemoryToCode
  // ---------------------------------------------------------------------------

  describe('linkMemoryToCode', () => {
    it('returns false when nexus node does not exist', async () => {
      const { linkMemoryToCode } = await import('../graph-memory-bridge.js');
      const result = await linkMemoryToCode(tempDir, 'observation:O-test', 'nonexistent::symbol');
      expect(result).toBe(false);
    });

    it('creates a code_reference edge when both nodes exist', async () => {
      const { linkMemoryToCode } = await import('../graph-memory-bridge.js');
      const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');

      await seedBrainNode('observation:O-abc', 'Test observation');
      await seedNexusNode(
        'src/store/brain-sqlite.ts::getBrainDb',
        'getBrainDb',
        'getBrainDb',
        'src/store/brain-sqlite.ts',
      );

      const result = await linkMemoryToCode(
        tempDir,
        'observation:O-abc',
        'src/store/brain-sqlite.ts::getBrainDb',
      );

      expect(result).toBe(true);

      // Verify the edge was written to brain.db
      const brainNative = getBrainNativeDb();
      const edge = brainNative
        ?.prepare(
          `SELECT from_id, to_id, edge_type, weight FROM brain_page_edges
           WHERE from_id = ? AND to_id = ? AND edge_type = 'code_reference'`,
        )
        .get('observation:O-abc', 'src/store/brain-sqlite.ts::getBrainDb') as
        | { from_id: string; to_id: string; edge_type: string; weight: number }
        | undefined;

      expect(edge).toBeDefined();
      expect(edge?.edge_type).toBe('code_reference');
      expect(edge?.weight).toBe(1.0);
    });

    it('is idempotent — calling twice does not duplicate the edge', async () => {
      const { linkMemoryToCode } = await import('../graph-memory-bridge.js');
      const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');

      await seedBrainNode('observation:O-dup', 'Dup test');
      await seedNexusNode('src/file.ts::myFunc', 'myFunc', 'myFunc', 'src/file.ts');

      await linkMemoryToCode(tempDir, 'observation:O-dup', 'src/file.ts::myFunc');
      await linkMemoryToCode(tempDir, 'observation:O-dup', 'src/file.ts::myFunc');

      const brainNative = getBrainNativeDb();
      const rows = brainNative
        ?.prepare(
          `SELECT COUNT(*) as cnt FROM brain_page_edges
           WHERE from_id = 'observation:O-dup'
             AND to_id = 'src/file.ts::myFunc'
             AND edge_type = 'code_reference'`,
        )
        .get() as { cnt: number } | undefined;

      expect(rows?.cnt).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // autoLinkMemories
  // ---------------------------------------------------------------------------

  describe('autoLinkMemories', () => {
    it('returns zero counts when brain and nexus are empty', async () => {
      const { autoLinkMemories } = await import('../graph-memory-bridge.js');
      const result = await autoLinkMemories(tempDir);
      expect(result.scanned).toBe(0);
      expect(result.linked).toBe(0);
      expect(result.links).toHaveLength(0);
    });

    it('matches brain nodes to nexus by exact symbol name', async () => {
      const { autoLinkMemories } = await import('../graph-memory-bridge.js');

      // Brain node label contains the symbol name
      await seedBrainNode(
        'observation:O-sym1',
        'Used getBrainDb to initialize the database connection',
        'observation',
        0.8,
      );

      await seedNexusNode(
        'src/store/brain-sqlite.ts::getBrainDb',
        'getBrainDb',
        'getBrainDb',
        'src/store/brain-sqlite.ts',
        'function',
      );

      const result = await autoLinkMemories(tempDir);

      expect(result.scanned).toBeGreaterThan(0);
      expect(result.linked).toBeGreaterThanOrEqual(1);

      const link = result.links.find(
        (l) => l.brainNodeId === 'observation:O-sym1' && l.nexusNodeId.includes('getBrainDb'),
      );
      expect(link).toBeDefined();
      expect(['exact-symbol', 'fuzzy-symbol']).toContain(link?.matchStrategy);
    });

    it('matches brain nodes to nexus by file path in label', async () => {
      const { autoLinkMemories } = await import('../graph-memory-bridge.js');

      await seedBrainNode(
        'decision:D-fp1',
        'Modified src/store/brain-sqlite.ts to add WAL mode support',
        'decision',
        0.9,
      );

      await seedNexusNode(
        'src/store/brain-sqlite.ts',
        'brain-sqlite.ts',
        null,
        'src/store/brain-sqlite.ts',
        'file',
      );

      const result = await autoLinkMemories(tempDir);

      expect(result.linked).toBeGreaterThanOrEqual(1);
      const link = result.links.find(
        (l) => l.brainNodeId === 'decision:D-fp1' && l.nexusNodeId === 'src/store/brain-sqlite.ts',
      );
      expect(link).toBeDefined();
      expect(link?.matchStrategy).toBe('exact-file');
    });

    it('marks already-linked edges as alreadyLinked', async () => {
      const { autoLinkMemories, linkMemoryToCode } = await import('../graph-memory-bridge.js');

      await seedBrainNode('observation:O-pre', 'calls getBrainDb directly', 'observation', 0.8);
      await seedNexusNode(
        'src/store/brain-sqlite.ts::getBrainDb',
        'getBrainDb',
        'getBrainDb',
        'src/store/brain-sqlite.ts',
      );

      // Pre-link manually
      await linkMemoryToCode(tempDir, 'observation:O-pre', 'src/store/brain-sqlite.ts::getBrainDb');

      // Auto-link should count it as already linked
      const result = await autoLinkMemories(tempDir);
      expect(result.alreadyLinked).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // queryMemoriesForCode
  // ---------------------------------------------------------------------------

  describe('queryMemoriesForCode', () => {
    it('returns empty memories for unknown symbol', async () => {
      const { queryMemoriesForCode } = await import('../graph-memory-bridge.js');
      const result = await queryMemoriesForCode(tempDir, 'unknown::symbol');
      expect(result.nexusNodeId).toBe('unknown::symbol');
      expect(result.memories).toHaveLength(0);
    });

    it('returns memories linked to a given nexus node', async () => {
      const { linkMemoryToCode, queryMemoriesForCode } = await import('../graph-memory-bridge.js');

      await seedBrainNode('observation:O-q1', 'Query test observation');
      await seedNexusNode('src/file.ts::myFunc', 'myFunc', 'myFunc', 'src/file.ts');

      await linkMemoryToCode(tempDir, 'observation:O-q1', 'src/file.ts::myFunc');

      const result = await queryMemoriesForCode(tempDir, 'src/file.ts::myFunc');
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0]?.nodeId).toBe('observation:O-q1');
      expect(result.memories[0]?.edgeWeight).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // queryCodeForMemory
  // ---------------------------------------------------------------------------

  describe('queryCodeForMemory', () => {
    it('returns empty codeNodes for unknown memory ID', async () => {
      const { queryCodeForMemory } = await import('../graph-memory-bridge.js');
      const result = await queryCodeForMemory(tempDir, 'observation:O-unknown');
      expect(result.brainNodeId).toBe('observation:O-unknown');
      expect(result.codeNodes).toHaveLength(0);
    });

    it('returns code nodes linked from a given memory node', async () => {
      const { linkMemoryToCode, queryCodeForMemory } = await import('../graph-memory-bridge.js');

      await seedBrainNode('decision:D-c1', 'Code for memory test');
      await seedNexusNode(
        'src/store/schema.ts::brainDecisions',
        'brainDecisions',
        'brainDecisions',
        'src/store/schema.ts',
      );

      await linkMemoryToCode(tempDir, 'decision:D-c1', 'src/store/schema.ts::brainDecisions');

      const result = await queryCodeForMemory(tempDir, 'decision:D-c1');
      expect(result.codeNodes).toHaveLength(1);
      expect(result.codeNodes[0]?.nexusNodeId).toBe('src/store/schema.ts::brainDecisions');
      expect(result.codeNodes[0]?.kind).toBe('function');
      expect(result.codeNodes[0]?.edgeWeight).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // listCodeLinks
  // ---------------------------------------------------------------------------

  describe('listCodeLinks', () => {
    it('returns empty array when no code_reference edges exist', async () => {
      const { listCodeLinks } = await import('../graph-memory-bridge.js');
      const result = await listCodeLinks(tempDir);
      expect(result).toHaveLength(0);
    });

    it('returns all code_reference edges with enriched metadata', async () => {
      const { linkMemoryToCode, listCodeLinks } = await import('../graph-memory-bridge.js');

      await seedBrainNode('observation:O-list1', 'List test obs 1');
      await seedBrainNode('observation:O-list2', 'List test obs 2');
      await seedNexusNode('src/a.ts::funcA', 'funcA', 'funcA', 'src/a.ts');
      await seedNexusNode('src/b.ts::funcB', 'funcB', 'funcB', 'src/b.ts');

      await linkMemoryToCode(tempDir, 'observation:O-list1', 'src/a.ts::funcA');
      await linkMemoryToCode(tempDir, 'observation:O-list2', 'src/b.ts::funcB');

      const result = await listCodeLinks(tempDir);
      expect(result).toHaveLength(2);

      const link1 = result.find((l) => l.brainNodeId === 'observation:O-list1');
      expect(link1?.nexusNodeLabel).toBe('funcA');
      expect(link1?.filePath).toBe('src/a.ts');
      expect(link1?.weight).toBe(1.0);
    });

    it('respects the limit parameter', async () => {
      const { linkMemoryToCode, listCodeLinks } = await import('../graph-memory-bridge.js');

      for (let i = 0; i < 5; i++) {
        await seedBrainNode(`observation:O-lim${i}`, `Limit test ${i}`);
        await seedNexusNode(`src/x${i}.ts::fn${i}`, `fn${i}`, `fn${i}`, `src/x${i}.ts`);
        await linkMemoryToCode(tempDir, `observation:O-lim${i}`, `src/x${i}.ts::fn${i}`);
      }

      const result = await listCodeLinks(tempDir, 3);
      expect(result).toHaveLength(3);
    });
  });
});
