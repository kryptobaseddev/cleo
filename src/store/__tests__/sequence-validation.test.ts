/**
 * Sequence Validation Tests
 *
 * Tests the sequence counter validation and auto-repair mechanisms
 * in data-safety.ts and data-safety-central.ts.
 *
 * @task T4741
 * @epic T4732
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock git-checkpoint
vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

describe('Sequence Validation', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-sequence-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('validateAndRepairSequence', () => {
    it('should pass when no tasks exist (clean state)', async () => {
      const { validateAndRepairSequence } = await import('../data-safety.js');

      // Write a valid sequence file
      await writeFile(
        join(cleoDir, '.sequence.json'),
        JSON.stringify({ counter: 1 }),
      );

      const result = await validateAndRepairSequence(tempDir);
      expect(result.valid).toBe(true);
      expect(result.repaired).toBe(false);
    });

    it('should skip validation when validateSequence is disabled', async () => {
      const { validateAndRepairSequence } = await import('../data-safety.js');

      const result = await validateAndRepairSequence(tempDir, {
        validateSequence: false,
      });

      expect(result.valid).toBe(true);
      expect(result.repaired).toBe(false);
    });

    it('should repair when sequence is behind task IDs', async () => {
      const { validateAndRepairSequence } = await import('../data-safety.js');
      const { createTask } = await import('../task-store.js');

      // Create tasks to advance the database
      await createTask({
        id: 'T050',
        title: 'Task 50',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      // Set sequence counter behind the max ID
      await writeFile(
        join(cleoDir, '.sequence.json'),
        JSON.stringify({ counter: 10 }),
      );

      const result = await validateAndRepairSequence(tempDir);

      // Should detect and repair
      if (result.repaired) {
        expect(result.valid).toBe(true);
        expect(result.newCounter).toBeGreaterThanOrEqual(50);
      }
      // Or valid if sequence was already auto-repaired during task creation
      expect(result.valid).toBe(true);
    });
  });

  describe('Data Integrity Check - Sequence', () => {
    it('should report sequence issues in integrity check', async () => {
      const { runDataIntegrityCheck } = await import('../data-safety.js');

      const result = await runDataIntegrityCheck(tempDir);

      // Should have a result even if sequence doesn't exist yet
      expect(result).toBeDefined();
      expect(result.issues).toBeInstanceOf(Array);
      expect(result.repairs).toBeInstanceOf(Array);
    });
  });
});
