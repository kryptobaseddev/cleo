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

// Force-pass-through the real modules so that any leaked mocks from other
// test files in the same vitest shard cannot pollute this integration test.
// vitest resolves mocks at file-load time; vi.unmock is not sufficient when
// another file's vi.mock('../../paths.js') already poisoned the module registry.
vi.mock('../../paths.js', async () => await vi.importActual('../../paths.js'));
vi.mock(
  '../../store/memory-sqlite.js',
  async () => await vi.importActual('../../store/memory-sqlite.js'),
);
vi.mock(
  '../../store/nexus-sqlite.js',
  async () => await vi.importActual('../../store/nexus-sqlite.js'),
);
vi.mock('../../config.js', async () => await vi.importActual('../../config.js'));

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
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
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
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainPageNodes } = await import('../../store/memory-schema.js');
    const db = await getBrainDb(tempDir);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db
      .insert(brainPageNodes)
      .values({
        id,
        nodeType: nodeType as import('../../store/memory-schema.js').BrainNodeType,
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
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      await seedBrainNode('observation:O-abc', 'Test observation');
      await seedNexusNode(
        'src/store/memory-sqlite.ts::getBrainDb',
        'getBrainDb',
        'getBrainDb',
        'src/store/memory-sqlite.ts',
      );

      const result = await linkMemoryToCode(
        tempDir,
        'observation:O-abc',
        'src/store/memory-sqlite.ts::getBrainDb',
      );

      expect(result).toBe(true);

      // Verify the edge was written to brain.db
      const brainNative = getBrainNativeDb();
      const edge = brainNative
        ?.prepare(
          `SELECT from_id, to_id, edge_type, weight FROM brain_page_edges
           WHERE from_id = ? AND to_id = ? AND edge_type = 'code_reference'`,
        )
        .get('observation:O-abc', 'src/store/memory-sqlite.ts::getBrainDb') as
        | { from_id: string; to_id: string; edge_type: string; weight: number }
        | undefined;

      expect(edge).toBeDefined();
      expect(edge?.edge_type).toBe('code_reference');
      expect(edge?.weight).toBe(1.0);
    });

    it('is idempotent — calling twice does not duplicate the edge', async () => {
      const { linkMemoryToCode } = await import('../graph-memory-bridge.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');

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
        'src/store/memory-sqlite.ts::getBrainDb',
        'getBrainDb',
        'getBrainDb',
        'src/store/memory-sqlite.ts',
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
        'Modified src/store/memory-sqlite.ts to add WAL mode support',
        'decision',
        0.9,
      );

      await seedNexusNode(
        'src/store/memory-sqlite.ts',
        'memory-sqlite.ts',
        null,
        'src/store/memory-sqlite.ts',
        'file',
      );

      const result = await autoLinkMemories(tempDir);

      expect(result.linked).toBeGreaterThanOrEqual(1);
      const link = result.links.find(
        (l) => l.brainNodeId === 'decision:D-fp1' && l.nexusNodeId === 'src/store/memory-sqlite.ts',
      );
      expect(link).toBeDefined();
      expect(link?.matchStrategy).toBe('exact-file');
    });

    it('marks already-linked edges as alreadyLinked', async () => {
      const { autoLinkMemories, linkMemoryToCode } = await import('../graph-memory-bridge.js');

      await seedBrainNode('observation:O-pre', 'calls getBrainDb directly', 'observation', 0.8);
      await seedNexusNode(
        'src/store/memory-sqlite.ts::getBrainDb',
        'getBrainDb',
        'getBrainDb',
        'src/store/memory-sqlite.ts',
      );

      // Pre-link manually
      await linkMemoryToCode(
        tempDir,
        'observation:O-pre',
        'src/store/memory-sqlite.ts::getBrainDb',
      );

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

  // ---------------------------------------------------------------------------
  // linkConduitMessagesToSymbols
  // ---------------------------------------------------------------------------

  describe('linkConduitMessagesToSymbols', () => {
    it('returns zero counts when conduit.db does not exist (graceful no-op)', async () => {
      const { linkConduitMessagesToSymbols } = await import('../graph-memory-bridge.js');
      const result = await linkConduitMessagesToSymbols(tempDir);
      expect(result.linked).toBe(0);
      expect(result.scanned).toBe(0);
    });

    it('returns zero counts when no messages match (no conduit data)', async () => {
      const { linkConduitMessagesToSymbols } = await import('../graph-memory-bridge.js');
      const { ensureConduitDb, getConduitNativeDb, closeConduitDb } = await import(
        '../../store/conduit-sqlite.js'
      );

      // Initialize conduit.db
      ensureConduitDb(tempDir);

      // Seed a nexus symbol
      await seedNexusNode('src/main.ts::initApp', 'initApp', 'initApp', 'src/main.ts', 'function');

      // Run the ingestion (no messages, so nothing to link)
      const result = await linkConduitMessagesToSymbols(tempDir);

      closeConduitDb();

      expect(result.scanned).toBe(0);
      expect(result.linked).toBe(0);
    });

    it('creates conduit_mentions_symbol edges when messages mention symbols', async () => {
      const { linkConduitMessagesToSymbols } = await import('../graph-memory-bridge.js');
      const { ensureConduitDb, getConduitNativeDb, closeConduitDb } = await import(
        '../../store/conduit-sqlite.js'
      );
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      // Initialize conduit.db and insert a test message
      ensureConduitDb(tempDir);
      const conduitDb = getConduitNativeDb();

      const convId = 'conv-001';
      conduitDb
        ?.prepare(
          `INSERT INTO conversations (id, participants, visibility, message_count, created_at, updated_at)
           VALUES (?, ?, 'private', 0, ?, ?)`,
        )
        .run(convId, JSON.stringify(['agent-a', 'agent-b']), Date.now(), Date.now());

      const msgId = 'msg-001';
      conduitDb
        ?.prepare(
          `INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, attachments, created_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?)`,
        )
        .run(
          msgId,
          convId,
          'agent-a',
          'agent-b',
          'We should refactor the initApp function to improve startup performance',
          Date.now(),
        );

      // Seed a nexus symbol with the same name
      await seedNexusNode('src/main.ts::initApp', 'initApp', 'initApp', 'src/main.ts', 'function');

      // Run the ingestion
      const result = await linkConduitMessagesToSymbols(tempDir);

      closeConduitDb();

      expect(result.scanned).toBeGreaterThan(0);
      expect(result.linked).toBeGreaterThan(0);

      // Verify the edge was written
      const brainNative = getBrainNativeDb();
      const edge = brainNative
        ?.prepare(
          `SELECT from_id, to_id, edge_type FROM brain_page_edges
           WHERE edge_type = 'conduit_mentions_symbol'
             AND to_id = 'src/main.ts::initApp'`,
        )
        .get() as { from_id: string; to_id: string; edge_type: string } | undefined;

      expect(edge).toBeDefined();
      expect(edge?.edge_type).toBe('conduit_mentions_symbol');
      expect(edge?.from_id).toMatch(/^conduit:/);
    });

    it('is idempotent — re-running does not duplicate edges', async () => {
      const { linkConduitMessagesToSymbols } = await import('../graph-memory-bridge.js');
      const { ensureConduitDb, getConduitNativeDb, closeConduitDb } = await import(
        '../../store/conduit-sqlite.js'
      );
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      ensureConduitDb(tempDir);
      const conduitDb = getConduitNativeDb();

      const convId = 'conv-002';
      conduitDb
        ?.prepare(
          `INSERT INTO conversations (id, participants, visibility, message_count, created_at, updated_at)
           VALUES (?, ?, 'private', 0, ?, ?)`,
        )
        .run(convId, JSON.stringify(['agent-c', 'agent-d']), Date.now(), Date.now());

      const msgId = 'msg-002';
      conduitDb
        ?.prepare(
          `INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, attachments, created_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?)`,
        )
        .run(
          msgId,
          convId,
          'agent-c',
          'agent-d',
          'The validateConfig function needs to handle edge cases',
          Date.now(),
        );

      await seedNexusNode(
        'src/config.ts::validateConfig',
        'validateConfig',
        'validateConfig',
        'src/config.ts',
        'function',
      );

      // Run twice
      const result1 = await linkConduitMessagesToSymbols(tempDir);
      const result2 = await linkConduitMessagesToSymbols(tempDir);

      closeConduitDb();

      // Verify edge count is the same (no duplicates)
      const brainNative = getBrainNativeDb();
      const rows = brainNative
        ?.prepare(
          `SELECT COUNT(*) as cnt FROM brain_page_edges
           WHERE edge_type = 'conduit_mentions_symbol'
             AND to_id = 'src/config.ts::validateConfig'`,
        )
        .get() as { cnt: number } | undefined;

      expect(rows?.cnt).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // linkObservationToModifiedFiles
  // ---------------------------------------------------------------------------

  describe('linkObservationToModifiedFiles', () => {
    it('writes modified_by edges for each file in files_modified_json', async () => {
      const { linkObservationToModifiedFiles } = await import('../graph-memory-bridge.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      await seedNexusNode(
        'src/store/memory-sqlite.ts',
        'memory-sqlite.ts',
        null,
        'src/store/memory-sqlite.ts',
        'file',
      );
      await seedNexusNode(
        'src/memory/brain-lifecycle.ts',
        'brain-lifecycle.ts',
        null,
        'src/memory/brain-lifecycle.ts',
        'file',
      );

      const filesModified = JSON.stringify([
        'src/store/memory-sqlite.ts',
        'src/memory/brain-lifecycle.ts',
      ]);
      const edgesWritten = await linkObservationToModifiedFiles(
        'observation:O-mod1',
        filesModified,
        tempDir,
      );

      expect(edgesWritten).toBe(2);

      // Verify edges were written
      const brainNative = getBrainNativeDb();
      const rows = brainNative
        ?.prepare(
          `SELECT COUNT(*) as cnt FROM brain_page_edges
           WHERE edge_type = 'modified_by' AND from_id LIKE 'src/store%'`,
        )
        .get() as { cnt: number } | undefined;

      expect(rows?.cnt).toBeGreaterThanOrEqual(1);
    });

    it('handles null files_modified_json gracefully', async () => {
      const { linkObservationToModifiedFiles } = await import('../graph-memory-bridge.js');

      const edgesWritten = await linkObservationToModifiedFiles(
        'observation:O-null',
        null,
        tempDir,
      );

      expect(edgesWritten).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // linkObservationToMentionedSymbols
  // ---------------------------------------------------------------------------

  describe('linkObservationToMentionedSymbols', () => {
    it('writes mentions edges for symbol names found in text', async () => {
      const { linkObservationToMentionedSymbols } = await import('../graph-memory-bridge.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      await seedNexusNode(
        'src/store/memory-sqlite.ts::getBrainDb',
        'getBrainDb',
        'getBrainDb',
        'src/store/memory-sqlite.ts',
      );
      await seedNexusNode(
        'src/store/memory-sqlite.ts::closeBrainDb',
        'closeBrainDb',
        'closeBrainDb',
        'src/store/memory-sqlite.ts',
      );

      const text = 'We use getBrainDb to open the database and closeBrainDb to cleanup.';
      const edgesWritten = await linkObservationToMentionedSymbols(
        'observation:O-mention1',
        text,
        tempDir,
      );

      expect(edgesWritten).toBeGreaterThanOrEqual(2);

      // Verify edges were written
      const brainNative = getBrainNativeDb();
      const rows = brainNative
        ?.prepare(
          `SELECT COUNT(*) as cnt FROM brain_page_edges
           WHERE edge_type = 'mentions' AND from_id = 'observation:O-mention1'`,
        )
        .get() as { cnt: number } | undefined;

      expect(rows?.cnt).toBeGreaterThanOrEqual(2);
    });

    it('caps mentions at 20 per observation', async () => {
      const { linkObservationToMentionedSymbols } = await import('../graph-memory-bridge.js');

      // Seed 30 nexus nodes
      for (let i = 0; i < 30; i++) {
        await seedNexusNode(`src/file.ts::symbol${i}`, `symbol${i}`, `symbol${i}`, 'src/file.ts');
      }

      // Create text that mentions all 30 symbols
      const text = Array.from({ length: 30 }, (_, i) => `symbol${i}`).join(' ');

      const edgesWritten = await linkObservationToMentionedSymbols(
        'observation:O-cap1',
        text,
        tempDir,
      );

      // Should cap at 20
      expect(edgesWritten).toBeLessThanOrEqual(20);
    });

    it('handles empty text gracefully', async () => {
      const { linkObservationToMentionedSymbols } = await import('../graph-memory-bridge.js');

      const edgesWritten = await linkObservationToMentionedSymbols(
        'observation:O-empty',
        '',
        tempDir,
      );

      expect(edgesWritten).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // linkDecisionToSymbols
  // ---------------------------------------------------------------------------

  describe('linkDecisionToSymbols', () => {
    it('writes documents edges for symbol names found in decision context', async () => {
      const { linkDecisionToSymbols } = await import('../graph-memory-bridge.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      await seedNexusNode(
        'src/memory/brain-lifecycle.ts::runConsolidation',
        'runConsolidation',
        'runConsolidation',
        'src/memory/brain-lifecycle.ts',
      );
      await seedNexusNode(
        'packages/core/src/memory/graph-memory-bridge.ts::autoLinkMemories',
        'autoLinkMemories',
        'autoLinkMemories',
        'packages/core/src/memory/graph-memory-bridge.ts',
      );

      const contextText =
        'The runConsolidation pass must call autoLinkMemories to link memories to code.';
      const edgesWritten = await linkDecisionToSymbols('decision:D-doc1', contextText, tempDir);

      expect(edgesWritten).toBeGreaterThanOrEqual(2);

      // Verify edges were written
      const brainNative = getBrainNativeDb();
      const rows = brainNative
        ?.prepare(
          `SELECT COUNT(*) as cnt FROM brain_page_edges
           WHERE edge_type = 'documents' AND from_id = 'decision:D-doc1'`,
        )
        .get() as { cnt: number } | undefined;

      expect(rows?.cnt).toBeGreaterThanOrEqual(2);
    });

    it('handles empty context text gracefully', async () => {
      const { linkDecisionToSymbols } = await import('../graph-memory-bridge.js');

      const edgesWritten = await linkDecisionToSymbols('decision:D-empty', '', tempDir);

      expect(edgesWritten).toBe(0);
    });
  });
});
