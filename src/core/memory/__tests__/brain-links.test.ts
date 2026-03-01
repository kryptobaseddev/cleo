/**
 * Tests for brain_memory_links management.
 *
 * @task T5156
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;

describe('Brain Memory Links', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-links-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('linkMemoryToTask', () => {
    it('should create a link between a decision and a task', async () => {
      const { linkMemoryToTask } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      // Create a decision first
      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Test decision',
        rationale: 'Test rationale',
        confidence: 'high',
      });

      const link = await linkMemoryToTask(tempDir, 'decision', 'D001', 'T1000', 'produced_by');
      expect(link.memoryType).toBe('decision');
      expect(link.memoryId).toBe('D001');
      expect(link.taskId).toBe('T1000');
      expect(link.linkType).toBe('produced_by');
    });

    it('should return existing link instead of duplicating', async () => {
      const { linkMemoryToTask } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const first = await linkMemoryToTask(tempDir, 'decision', 'D001', 'T1000', 'produced_by');
      const second = await linkMemoryToTask(tempDir, 'decision', 'D001', 'T1000', 'produced_by');

      expect(first.memoryId).toBe(second.memoryId);
      expect(first.taskId).toBe(second.taskId);
    });

    it('should throw on empty memoryId or taskId', async () => {
      const { linkMemoryToTask } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await expect(
        linkMemoryToTask(tempDir, 'decision', '', 'T1000', 'produced_by'),
      ).rejects.toThrow('memoryId and taskId are required');

      await expect(
        linkMemoryToTask(tempDir, 'decision', 'D001', '', 'produced_by'),
      ).rejects.toThrow('memoryId and taskId are required');
    });
  });

  describe('unlinkMemoryFromTask', () => {
    it('should remove an existing link', async () => {
      const { linkMemoryToTask, unlinkMemoryFromTask, getMemoryLinks } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await linkMemoryToTask(tempDir, 'pattern', 'P001', 'T2000', 'applies_to');
      const beforeUnlink = await getMemoryLinks(tempDir, 'pattern', 'P001');
      expect(beforeUnlink).toHaveLength(1);

      await unlinkMemoryFromTask(tempDir, 'pattern', 'P001', 'T2000', 'applies_to');
      const afterUnlink = await getMemoryLinks(tempDir, 'pattern', 'P001');
      expect(afterUnlink).toHaveLength(0);
    });
  });

  describe('getTaskLinks', () => {
    it('should return all memory entries linked to a task', async () => {
      const { linkMemoryToTask, getTaskLinks } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await linkMemoryToTask(tempDir, 'decision', 'D001', 'T1000', 'produced_by');
      await linkMemoryToTask(tempDir, 'pattern', 'P001', 'T1000', 'applies_to');
      await linkMemoryToTask(tempDir, 'learning', 'L001', 'T1000', 'informed_by');

      const links = await getTaskLinks(tempDir, 'T1000');
      expect(links).toHaveLength(3);
    });

    it('should return empty array for task with no links', async () => {
      const { getTaskLinks } = await import('../brain-links.js');
      const { closeBrainDb, getBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const links = await getTaskLinks(tempDir, 'T9999');
      expect(links).toHaveLength(0);
    });
  });

  describe('getMemoryLinks', () => {
    it('should return all tasks linked to a memory entry', async () => {
      const { linkMemoryToTask, getMemoryLinks } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await linkMemoryToTask(tempDir, 'decision', 'D001', 'T1000', 'produced_by');
      await linkMemoryToTask(tempDir, 'decision', 'D001', 'T2000', 'applies_to');

      const links = await getMemoryLinks(tempDir, 'decision', 'D001');
      expect(links).toHaveLength(2);
    });
  });

  describe('bulkLink', () => {
    it('should create multiple links at once', async () => {
      const { bulkLink, getTaskLinks } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const result = await bulkLink(tempDir, [
        { memoryType: 'decision', memoryId: 'D001', taskId: 'T1000', linkType: 'produced_by' },
        { memoryType: 'pattern', memoryId: 'P001', taskId: 'T1000', linkType: 'applies_to' },
        { memoryType: 'learning', memoryId: 'L001', taskId: 'T1000', linkType: 'informed_by' },
      ]);

      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);

      const links = await getTaskLinks(tempDir, 'T1000');
      expect(links).toHaveLength(3);
    });

    it('should skip duplicate links in bulk', async () => {
      const { linkMemoryToTask, bulkLink } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await linkMemoryToTask(tempDir, 'decision', 'D001', 'T1000', 'produced_by');

      const result = await bulkLink(tempDir, [
        { memoryType: 'decision', memoryId: 'D001', taskId: 'T1000', linkType: 'produced_by' },
        { memoryType: 'pattern', memoryId: 'P001', taskId: 'T1000', linkType: 'applies_to' },
      ]);

      expect(result.created).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('convenience methods', () => {
    it('getLinkedDecisions should return full decision rows', async () => {
      const { linkMemoryToTask, getLinkedDecisions } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use SQLite',
        rationale: 'Embedded DB',
        confidence: 'high',
      });
      await linkMemoryToTask(tempDir, 'decision', 'D001', 'T1000', 'produced_by');

      const decisions = await getLinkedDecisions(tempDir, 'T1000');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBe('D001');
      expect(decisions[0].decision).toBe('Use SQLite');
    });

    it('getLinkedPatterns should return full pattern rows', async () => {
      const { linkMemoryToTask, getLinkedPatterns } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Validate input first',
        context: 'API handlers',
        frequency: 3,
      });
      await linkMemoryToTask(tempDir, 'pattern', 'P001', 'T1000', 'applies_to');

      const patterns = await getLinkedPatterns(tempDir, 'T1000');
      expect(patterns).toHaveLength(1);
      expect(patterns[0].id).toBe('P001');
      expect(patterns[0].pattern).toBe('Validate input first');
    });

    it('getLinkedLearnings should return full learning rows', async () => {
      const { linkMemoryToTask, getLinkedLearnings } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addLearning({
        id: 'L001',
        insight: 'Atomic writes are essential',
        source: 'T4500',
        confidence: 0.9,
        actionable: true,
      });
      await linkMemoryToTask(tempDir, 'learning', 'L001', 'T1000', 'informed_by');

      const learnings = await getLinkedLearnings(tempDir, 'T1000');
      expect(learnings).toHaveLength(1);
      expect(learnings[0].id).toBe('L001');
      expect(learnings[0].insight).toBe('Atomic writes are essential');
    });

    it('should return empty array when no linked entries exist', async () => {
      const { getLinkedDecisions, getLinkedPatterns, getLinkedLearnings } = await import('../brain-links.js');
      const { closeBrainDb, getBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const decisions = await getLinkedDecisions(tempDir, 'T9999');
      const patterns = await getLinkedPatterns(tempDir, 'T9999');
      const learnings = await getLinkedLearnings(tempDir, 'T9999');

      expect(decisions).toHaveLength(0);
      expect(patterns).toHaveLength(0);
      expect(learnings).toHaveLength(0);
    });
  });
});
