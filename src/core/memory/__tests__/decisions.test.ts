/**
 * Tests for Decision Memory module — brain.db backed decision storage.
 *
 * @task T5155
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;

describe('Decision Memory', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-decisions-'));
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

  describe('storeDecision', () => {
    it('should create a new decision with sequential ID', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const decision = await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Use SQLite for brain storage',
        rationale: 'Consistency with tasks.db',
        confidence: 'high',
      });

      expect(decision.id).toBe('D001');
      expect(decision.type).toBe('architecture');
      expect(decision.decision).toBe('Use SQLite for brain storage');
      expect(decision.rationale).toBe('Consistency with tasks.db');
      expect(decision.confidence).toBe('high');
    });

    it('should generate sequential IDs (D001, D002, ...)', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const d1 = await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Decision one',
        rationale: 'Rationale one',
        confidence: 'high',
      });
      const d2 = await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Decision two',
        rationale: 'Rationale two',
        confidence: 'medium',
      });

      expect(d1.id).toBe('D001');
      expect(d2.id).toBe('D002');
    });

    it('should update duplicate decision instead of creating new one', async () => {
      const { storeDecision, listDecisions } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Use SQLite',
        rationale: 'Initial rationale',
        confidence: 'medium',
      });

      const updated = await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Use SQLite',
        rationale: 'Updated rationale',
        confidence: 'high',
      });

      expect(updated.id).toBe('D001');
      expect(updated.rationale).toBe('Updated rationale');
      expect(updated.confidence).toBe('high');

      const { total } = await listDecisions(tempDir);
      expect(total).toBe(1);
    });

    it('should throw on empty decision text', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await expect(
        storeDecision(tempDir, {
          type: 'architecture',
          decision: '',
          rationale: 'Some rationale',
          confidence: 'high',
        }),
      ).rejects.toThrow('Decision text is required');
    });

    it('should throw on empty rationale', async () => {
      const { storeDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await expect(
        storeDecision(tempDir, {
          type: 'architecture',
          decision: 'Some decision',
          rationale: '',
          confidence: 'high',
        }),
      ).rejects.toThrow('Rationale is required');
    });
  });

  describe('recallDecision', () => {
    it('should retrieve a stored decision by ID', async () => {
      const { storeDecision, recallDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use ESM modules',
        rationale: 'Modern JS standard',
        confidence: 'high',
      });

      const result = await recallDecision(tempDir, 'D001');
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('Use ESM modules');
    });

    it('should return null for non-existent ID', async () => {
      const { recallDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      // Ensure DB is initialized
      const { getBrainDb } = await import('../../../store/brain-sqlite.js');
      await getBrainDb(tempDir);

      const result = await recallDecision(tempDir, 'D999');
      expect(result).toBeNull();
    });
  });

  describe('searchDecisions', () => {
    it('should search by type', async () => {
      const { storeDecision, searchDecisions } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Use SQLite',
        rationale: 'DB choice',
        confidence: 'high',
      });
      await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use TypeScript',
        rationale: 'Type safety',
        confidence: 'high',
      });

      const results = await searchDecisions(tempDir, { type: 'architecture' });
      expect(results).toHaveLength(1);
      expect(results[0].decision).toBe('Use SQLite');
    });

    it('should search by free-text query across decision and rationale', async () => {
      const { storeDecision, searchDecisions } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Use SQLite for storage',
        rationale: 'Consistent with existing patterns',
        confidence: 'high',
      });
      await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Use Drizzle ORM',
        rationale: 'Type-safe database access',
        confidence: 'medium',
      });

      const results = await searchDecisions(tempDir, { query: 'database' });
      expect(results).toHaveLength(1);
      expect(results[0].decision).toBe('Use Drizzle ORM');
    });

    it('should respect limit parameter', async () => {
      const { storeDecision, searchDecisions } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      for (let i = 0; i < 5; i++) {
        await storeDecision(tempDir, {
          type: 'technical',
          decision: `Decision ${i}`,
          rationale: `Rationale ${i}`,
          confidence: 'medium',
        });
      }

      const results = await searchDecisions(tempDir, { limit: 3 });
      expect(results).toHaveLength(3);
    });
  });

  describe('updateDecisionOutcome', () => {
    it('should update the outcome of a decision', async () => {
      const { storeDecision, updateDecisionOutcome, recallDecision } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Use WAL mode',
        rationale: 'Better concurrency',
        confidence: 'high',
      });

      const updated = await updateDecisionOutcome(tempDir, 'D001', 'success');
      expect(updated.outcome).toBe('success');

      const recalled = await recallDecision(tempDir, 'D001');
      expect(recalled!.outcome).toBe('success');
    });

    it('should throw for non-existent decision', async () => {
      const { updateDecisionOutcome } = await import('../decisions.js');
      const { closeBrainDb, getBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      await expect(
        updateDecisionOutcome(tempDir, 'D999', 'failure'),
      ).rejects.toThrow('Decision not found: D999');
    });
  });

  describe('listDecisions', () => {
    it('should return decisions with total count', async () => {
      const { storeDecision, listDecisions } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await storeDecision(tempDir, {
        type: 'architecture',
        decision: 'Decision A',
        rationale: 'Reason A',
        confidence: 'high',
      });
      await storeDecision(tempDir, {
        type: 'technical',
        decision: 'Decision B',
        rationale: 'Reason B',
        confidence: 'medium',
      });

      const { decisions, total } = await listDecisions(tempDir);
      expect(total).toBe(2);
      expect(decisions).toHaveLength(2);
    });

    it('should support pagination with offset and limit', async () => {
      const { storeDecision, listDecisions } = await import('../decisions.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      for (let i = 0; i < 5; i++) {
        await storeDecision(tempDir, {
          type: 'technical',
          decision: `Decision ${i}`,
          rationale: `Rationale ${i}`,
          confidence: 'medium',
        });
      }

      const { decisions, total } = await listDecisions(tempDir, { offset: 2, limit: 2 });
      expect(total).toBe(5);
      expect(decisions).toHaveLength(2);
    });
  });
});
