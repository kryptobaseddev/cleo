/**
 * Tests for BrainDataAccessor — CRUD operations on brain.db.
 *
 * Each test uses an isolated temporary directory for the brain.db file.
 *
 * @epic T5149
 * @task T5128
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;

describe('BrainDataAccessor', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-accessor-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Decisions
  // =========================================================================

  describe('decisions', () => {
    it('addDecision and getDecision roundtrip', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      const row = await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use SQLite for brain storage',
        rationale: 'Consistency with tasks.db',
        confidence: 'high',
      });

      expect(row.id).toBe('D001');
      expect(row.type).toBe('architecture');
      expect(row.decision).toBe('Use SQLite for brain storage');
      expect(row.rationale).toBe('Consistency with tasks.db');
      expect(row.confidence).toBe('high');
      expect(row.createdAt).toBeTruthy();

      const fetched = await accessor.getDecision('D001');
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe('D001');
    });

    it('getDecision returns null for non-existent ID', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      const result = await accessor.getDecision('NONEXISTENT');
      expect(result).toBeNull();
    });

    it('findDecisions filters by type', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      await accessor.addDecision({
        id: 'D010',
        type: 'architecture',
        decision: 'Architecture decision',
        rationale: 'Reason',
        confidence: 'high',
      });
      await accessor.addDecision({
        id: 'D011',
        type: 'technical',
        decision: 'Technical decision',
        rationale: 'Reason',
        confidence: 'medium',
      });

      const archDecisions = await accessor.findDecisions({ type: 'architecture' });
      expect(archDecisions).toHaveLength(1);
      expect(archDecisions[0]!.id).toBe('D010');
    });

    it('findDecisions filters by confidence and limits results', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      for (let i = 0; i < 5; i++) {
        await accessor.addDecision({
          id: `D02${i}`,
          type: 'technical',
          decision: `Decision ${i}`,
          rationale: `Rationale ${i}`,
          confidence: 'high',
        });
      }

      const results = await accessor.findDecisions({ confidence: 'high', limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('updateDecision sets updatedAt and modifies fields', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      await accessor.addDecision({
        id: 'D030',
        type: 'process',
        decision: 'Original decision',
        rationale: 'Original rationale',
        confidence: 'low',
      });

      await accessor.updateDecision('D030', {
        outcome: 'success',
        confidence: 'high',
      });

      const updated = await accessor.getDecision('D030');
      expect(updated!.outcome).toBe('success');
      expect(updated!.confidence).toBe('high');
      expect(updated!.updatedAt).toBeTruthy();
    });
  });

  // =========================================================================
  // Patterns
  // =========================================================================

  describe('patterns', () => {
    it('addPattern and getPattern roundtrip', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      const row = await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Always run tests before committing',
        context: 'CI/CD pipeline',
      });

      expect(row.id).toBe('P001');
      expect(row.type).toBe('workflow');
      expect(row.frequency).toBe(1);

      const fetched = await accessor.getPattern('P001');
      expect(fetched).not.toBeNull();
      expect(fetched!.pattern).toBe('Always run tests before committing');
    });

    it('getPattern returns null for non-existent ID', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      const result = await accessor.getPattern('NONEXISTENT');
      expect(result).toBeNull();
    });

    it('findPatterns filters by type and impact', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      await accessor.addPattern({
        id: 'P010',
        type: 'blocker',
        pattern: 'Database lock contention',
        context: 'Multi-process access',
        impact: 'high',
      });
      await accessor.addPattern({
        id: 'P011',
        type: 'success',
        pattern: 'Atomic writes prevent corruption',
        context: 'File operations',
        impact: 'high',
      });
      await accessor.addPattern({
        id: 'P012',
        type: 'blocker',
        pattern: 'Minor issue',
        context: 'Test environment',
        impact: 'low',
      });

      const highBlockers = await accessor.findPatterns({ type: 'blocker', impact: 'high' });
      expect(highBlockers).toHaveLength(1);
      expect(highBlockers[0]!.id).toBe('P010');
    });

    it('findPatterns filters by minFrequency', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      await accessor.addPattern({
        id: 'P020',
        type: 'workflow',
        pattern: 'Common pattern',
        context: 'General',
        frequency: 10,
      });
      await accessor.addPattern({
        id: 'P021',
        type: 'workflow',
        pattern: 'Rare pattern',
        context: 'General',
        frequency: 1,
      });

      const frequent = await accessor.findPatterns({ minFrequency: 5 });
      expect(frequent).toHaveLength(1);
      expect(frequent[0]!.id).toBe('P020');
    });

    it('updatePattern modifies fields and sets updatedAt', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      await accessor.addPattern({
        id: 'P030',
        type: 'optimization',
        pattern: 'Original',
        context: 'Original context',
      });

      await accessor.updatePattern('P030', {
        frequency: 5,
        impact: 'medium',
      });

      const updated = await accessor.getPattern('P030');
      expect(updated!.frequency).toBe(5);
      expect(updated!.impact).toBe('medium');
      expect(updated!.updatedAt).toBeTruthy();
    });
  });

  // =========================================================================
  // Learnings
  // =========================================================================

  describe('learnings', () => {
    it('addLearning and getLearning roundtrip', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      const row = await accessor.addLearning({
        id: 'L001',
        insight: 'WAL mode prevents data loss in concurrent access',
        source: 'T5173 investigation',
        confidence: 0.95,
        actionable: true,
        application: 'Always verify WAL mode is set after PRAGMA',
      });

      expect(row.id).toBe('L001');
      expect(row.insight).toBe('WAL mode prevents data loss in concurrent access');
      expect(row.confidence).toBe(0.95);
      expect(row.actionable).toBe(true);

      const fetched = await accessor.getLearning('L001');
      expect(fetched).not.toBeNull();
      expect(fetched!.source).toBe('T5173 investigation');
    });

    it('getLearning returns null for non-existent ID', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      const result = await accessor.getLearning('NONEXISTENT');
      expect(result).toBeNull();
    });

    it('findLearnings filters by minConfidence and actionable', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      await accessor.addLearning({
        id: 'L010',
        insight: 'High confidence actionable',
        source: 'Test',
        confidence: 0.9,
        actionable: true,
      });
      await accessor.addLearning({
        id: 'L011',
        insight: 'Low confidence actionable',
        source: 'Test',
        confidence: 0.3,
        actionable: true,
      });
      await accessor.addLearning({
        id: 'L012',
        insight: 'High confidence not actionable',
        source: 'Test',
        confidence: 0.85,
        actionable: false,
      });

      const results = await accessor.findLearnings({
        minConfidence: 0.8,
        actionable: true,
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('L010');
    });

    it('updateLearning modifies fields and sets updatedAt', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();
      await accessor.addLearning({
        id: 'L020',
        insight: 'Initial insight',
        source: 'Initial source',
        confidence: 0.5,
      });

      await accessor.updateLearning('L020', {
        confidence: 0.9,
        actionable: true,
        application: 'Apply this in all cases',
      });

      const updated = await accessor.getLearning('L020');
      expect(updated!.confidence).toBe(0.9);
      expect(updated!.actionable).toBe(true);
      expect(updated!.application).toBe('Apply this in all cases');
      expect(updated!.updatedAt).toBeTruthy();
    });
  });

  // =========================================================================
  // Memory Links
  // =========================================================================

  describe('memory links', () => {
    it('addLink and getLinksForMemory roundtrip', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();

      // Create a decision first
      await accessor.addDecision({
        id: 'D100',
        type: 'architecture',
        decision: 'Linked decision',
        rationale: 'Test',
        confidence: 'high',
      });

      // Link it to a task
      await accessor.addLink({
        memoryType: 'decision',
        memoryId: 'D100',
        taskId: 'T1234',
        linkType: 'produced_by',
      });

      const links = await accessor.getLinksForMemory('decision', 'D100');
      expect(links).toHaveLength(1);
      expect(links[0]!.taskId).toBe('T1234');
      expect(links[0]!.linkType).toBe('produced_by');
    });

    it('getLinksForTask returns all links for a task', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();

      await accessor.addLink({
        memoryType: 'decision',
        memoryId: 'D200',
        taskId: 'T5000',
        linkType: 'produced_by',
      });
      await accessor.addLink({
        memoryType: 'pattern',
        memoryId: 'P200',
        taskId: 'T5000',
        linkType: 'applies_to',
      });
      await accessor.addLink({
        memoryType: 'learning',
        memoryId: 'L200',
        taskId: 'T9999',
        linkType: 'informed_by',
      });

      const links = await accessor.getLinksForTask('T5000');
      expect(links).toHaveLength(2);
      const memoryIds = links.map(l => l.memoryId).sort();
      expect(memoryIds).toEqual(['D200', 'P200']);
    });

    it('removeLink deletes a specific link', async () => {
      const { getBrainAccessor } = await import('../brain-accessor.js');
      const { closeBrainDb } = await import('../brain-sqlite.js');
      closeBrainDb();

      const accessor = await getBrainAccessor();

      await accessor.addLink({
        memoryType: 'decision',
        memoryId: 'D300',
        taskId: 'T3000',
        linkType: 'produced_by',
      });
      await accessor.addLink({
        memoryType: 'decision',
        memoryId: 'D300',
        taskId: 'T3001',
        linkType: 'applies_to',
      });

      // Remove one link
      await accessor.removeLink('decision', 'D300', 'T3000', 'produced_by');

      const remaining = await accessor.getLinksForMemory('decision', 'D300');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.taskId).toBe('T3001');
    });
  });
});
