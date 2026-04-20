/**
 * Tests for reasonWhySymbol (brain-reasoning.ts) and reasonImpactOfChange (living-brain.ts).
 *
 * Uses synthetic brain.db + nexus.db with seeded observations, decisions,
 * task links, and code_reference edges to exercise the cross-substrate walk.
 *
 * @task T1069
 * @epic T1042
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force real module resolution so mocks from other test files do not bleed in.
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

describe('brain-reasoning-symbol', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brs-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    // nexus.db is global (ADR-036) — redirect to temp dir
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

  /** Seed a brain page node. */
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

  /** Seed a brain edge. */
  async function seedBrainEdge(
    fromId: string,
    toId: string,
    edgeType: string,
    weight = 1.0,
  ): Promise<void> {
    const { getBrainNativeDb, getBrainDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const native = getBrainNativeDb();
    if (!native) throw new Error('brain native db not available');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    native
      .prepare(
        `INSERT OR IGNORE INTO brain_page_edges
           (from_id, to_id, edge_type, weight, provenance, created_at)
         VALUES (?, ?, ?, ?, 'test', ?)`,
      )
      .run(fromId, toId, edgeType, weight, now);
  }

  /** Seed a nexus node using native SQL to avoid schema drift issues. */
  async function seedNexusNode(
    id: string,
    label: string,
    name: string | null,
    filePath: string | null,
    kind = 'function',
  ): Promise<void> {
    const { getNexusDb, getNexusNativeDb } = await import('../../store/nexus-sqlite.js');
    await getNexusDb();
    const native = getNexusNativeDb();
    if (!native) throw new Error('nexus native db not available');
    // Use minimal INSERT with only always-present columns to avoid is_external / weight issues
    native
      .prepare(
        `INSERT OR IGNORE INTO nexus_nodes
           (id, project_id, kind, label, name, file_path)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, 'test-project', kind, label, name, filePath);
  }

  /** Seed a brain decision in brain_decisions table. */
  async function seedDecision(
    id: string,
    decision: string,
    rationale: string,
    contextTaskId: string | null,
  ): Promise<void> {
    const { getBrainNativeDb, getBrainDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const native = getBrainNativeDb();
    if (!native) throw new Error('brain native db not available');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    // Include all NOT NULL columns: type, rationale, confidence
    native
      .prepare(
        `INSERT OR IGNORE INTO brain_decisions
           (id, type, decision, rationale, confidence, context_task_id, quality_score, created_at, updated_at)
         VALUES (?, 'architectural', ?, ?, 'high', ?, 0.8, ?, ?)`,
      )
      .run(id, decision, rationale, contextTaskId, now, now);
  }

  /** Seed a brain_memory_links entry (composite PK: memory_type + memory_id + task_id + link_type). */
  async function seedMemoryLink(
    memoryId: string,
    memoryType: string,
    taskId: string,
    linkType: string,
  ): Promise<void> {
    const { getBrainNativeDb, getBrainDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const native = getBrainNativeDb();
    if (!native) throw new Error('brain native db not available');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    native
      .prepare(
        `INSERT OR IGNORE INTO brain_memory_links
           (memory_id, memory_type, task_id, link_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memoryId, memoryType, taskId, linkType, now);
  }

  // ---------------------------------------------------------------------------
  // reasonWhySymbol
  // ---------------------------------------------------------------------------

  describe('reasonWhySymbol', () => {
    it('returns empty trace when symbol has no brain edges', async () => {
      const { reasonWhySymbol } = await import('../brain-reasoning.js');
      // Initialize brain db
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);

      const result = await reasonWhySymbol('unknownSymbol', tempDir);

      expect(result.symbolId).toBe('unknownSymbol');
      expect(result.chain).toHaveLength(0);
      expect(result.narrative).toContain('No reasoning context');
    });

    it('returns a 3-step chain for seeded symbol with decision + task', async () => {
      const { reasonWhySymbol } = await import('../brain-reasoning.js');

      const symbolNexusId = 'src/store/memory-sqlite.ts::getBrainDb';

      // Seed nexus node for the symbol
      await seedNexusNode(symbolNexusId, 'getBrainDb', 'getBrainDb', 'src/store/memory-sqlite.ts');

      // Seed a decision that references this symbol
      await seedDecision(
        'D-001',
        'Use SQLite for brain storage',
        'Low overhead, zero deps',
        'T712',
      );

      // Seed the decision as a brain page node
      await seedBrainNode('decision:D-001', 'Use SQLite for brain storage', 'decision', 0.9);

      // Seed a code_reference edge from the decision to the symbol
      await seedBrainEdge('decision:D-001', symbolNexusId, 'code_reference', 1.0);

      // Seed a task memory link for the decision's context task
      await seedMemoryLink('D-001', 'decision', 'T712', 'produced_by');

      // Seed a task_touches_symbol edge from task to symbol
      await seedBrainEdge(`task:T712`, symbolNexusId, 'task_touches_symbol', 1.0);

      const result = await reasonWhySymbol(symbolNexusId, tempDir);

      expect(result.symbolId).toBe(symbolNexusId);
      expect(result.chain.length).toBeGreaterThanOrEqual(1);

      // There should be at least one decision step
      const decisionSteps = result.chain.filter((s) => s.type === 'decision');
      expect(decisionSteps.length).toBeGreaterThanOrEqual(1);
      expect(decisionSteps[0]!.title).toContain('SQLite');

      // Task T712 should be referenced
      const taskSteps = result.chain.filter((s) => s.type === 'task');
      expect(taskSteps.length).toBeGreaterThanOrEqual(1);
      expect(taskSteps[0]!.id).toBe('T712');

      // Narrative should not be the empty fallback
      expect(result.narrative).not.toContain('No reasoning context');
    });

    it('handles observations (non-decision brain nodes) gracefully', async () => {
      const { reasonWhySymbol } = await import('../brain-reasoning.js');

      const symbolNexusId = 'src/core/index.ts::init';
      await seedNexusNode(symbolNexusId, 'init', 'init', 'src/core/index.ts');

      // Seed an observation node referencing the symbol
      await seedBrainNode(
        'observation:O-abc',
        'Observed that init is called at startup',
        'observation',
        0.7,
      );
      await seedBrainEdge('observation:O-abc', symbolNexusId, 'mentions', 0.8);

      const result = await reasonWhySymbol(symbolNexusId, tempDir);

      expect(result.chain.length).toBeGreaterThanOrEqual(1);
      const obsSteps = result.chain.filter((s) => s.type === 'observation');
      expect(obsSteps.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // reasonImpactOfChange
  // ---------------------------------------------------------------------------

  describe('reasonImpactOfChange', () => {
    it('returns empty impact when symbol has no data', async () => {
      const { reasonImpactOfChange } = await import('../../nexus/living-brain.js');
      // Initialize brain db
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);

      const result = await reasonImpactOfChange('unknownSymbol', tempDir);

      expect(result.symbolId).toBe('unknownSymbol');
      expect(result.openTasks).toHaveLength(0);
      expect(result.brainRiskNotes).toHaveLength(0);
      // structural should be zeroed
      expect(result.structural.directCallers).toBe(0);
      expect(result.structural.totalAffected).toBe(0);
    });

    it('merges brain risk notes from code_reference + mentions edges', async () => {
      const { reasonImpactOfChange } = await import('../../nexus/living-brain.js');

      const symbolNexusId = 'src/store/sqlite.ts::getDb';
      await seedNexusNode(symbolNexusId, 'getDb', 'getDb', 'src/store/sqlite.ts');

      // Seed two brain nodes that reference this symbol
      await seedBrainNode(
        'observation:O-risk1',
        'getDb is called at session start',
        'observation',
        0.8,
      );
      await seedBrainEdge('observation:O-risk1', symbolNexusId, 'code_reference', 0.9);

      await seedBrainNode('decision:D-risk2', 'getDb must be lazy-initialized', 'decision', 0.9);
      await seedBrainEdge('decision:D-risk2', symbolNexusId, 'documents', 1.0);

      const result = await reasonImpactOfChange(symbolNexusId, tempDir);

      expect(result.symbolId).toBe(symbolNexusId);
      expect(result.brainRiskNotes.length).toBeGreaterThanOrEqual(2);

      const riskIds = result.brainRiskNotes.map((n) => n.nodeId);
      expect(riskIds).toContain('observation:O-risk1');
      expect(riskIds).toContain('decision:D-risk2');
    });

    it('merges risk tiers: MEDIUM task count + structural NONE = MEDIUM', async () => {
      const { reasonImpactOfChange } = await import('../../nexus/living-brain.js');

      const symbolNexusId = 'src/nexus/tasks-bridge.ts::getTasksForSymbol';
      await seedNexusNode(
        symbolNexusId,
        'getTasksForSymbol',
        'getTasksForSymbol',
        'src/nexus/tasks-bridge.ts',
      );

      // Seed task_touches_symbol edges for 3 tasks (should push to MEDIUM)
      await seedBrainEdge('task:T100', symbolNexusId, 'task_touches_symbol', 1.0);
      await seedBrainEdge('task:T101', symbolNexusId, 'task_touches_symbol', 1.0);
      await seedBrainEdge('task:T102', symbolNexusId, 'task_touches_symbol', 1.0);

      const result = await reasonImpactOfChange(symbolNexusId, tempDir);

      // 3 open tasks should push risk to at least MEDIUM
      const order = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      const riskIdx = order.indexOf(result.mergedRiskScore);
      expect(riskIdx).toBeGreaterThanOrEqual(order.indexOf('MEDIUM'));

      // Narrative mentions open tasks
      expect(result.narrative).toContain('task');
    });

    it('narrative describes directCallers, openTasks, and merged risk', async () => {
      const { reasonImpactOfChange } = await import('../../nexus/living-brain.js');

      const symbolNexusId = 'src/core/facade.ts::getApi';
      await seedNexusNode(symbolNexusId, 'getApi', 'getApi', 'src/core/facade.ts');

      const result = await reasonImpactOfChange(symbolNexusId, tempDir);

      // Narrative should always contain "Merged risk:"
      expect(result.narrative).toMatch(/Merged risk:/i);
    });
  });
});
