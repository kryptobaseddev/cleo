/**
 * Lifecycle Engine Tests
 *
 * Tests native TypeScript lifecycle operations.
 *
 * @task T4475
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  lifecycleStatus,
  lifecycleHistory,
  lifecycleGates,
  lifecyclePrerequisites,
  lifecycleCheck,
  lifecycleProgress,
  lifecycleSkip,
  lifecycleReset,
  lifecycleGatePass,
  lifecycleGateFail,
} from '../lifecycle-engine.js';
import { closeDb, resetDbState } from '../../../store/sqlite.js';
import { initLogger, closeLogger } from '../../../core/logger.js';

let TEST_ROOT = '';
let RCSD_DIR = '';

describe('Lifecycle Engine', () => {
  beforeEach(() => {
    resetDbState();
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-lifecycle-engine-'));
    RCSD_DIR = join(TEST_ROOT, '.cleo', 'rcasd');
    mkdirSync(RCSD_DIR, { recursive: true });
    initLogger(join(TEST_ROOT, '.cleo'), {
      level: 'fatal',
      filePath: 'logs/test.log',
      maxFileSize: 1024 * 1024,
      maxFiles: 1,
    });
  });

  afterEach(() => {
    closeLogger();
    closeDb();
    resetDbState();
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  describe('lifecycleStatus', () => {
    it('should return uninitialized status for new epic', async () => {
      const result = await lifecycleStatus('T999', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).initialized).toBe(false);
      expect((result.data as any).nextStage).toBe('research');
    });

    it('should return correct status for initialized epic', async () => {
      await lifecycleProgress('T100', 'research', 'completed', 'done', TEST_ROOT);
      await lifecycleSkip('T100', 'consensus', 'skip', TEST_ROOT);
      const result = await lifecycleStatus('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).initialized).toBe(true);
      expect((result.data as any).currentStage).toBe('consensus');
    });

    it('should return error for missing epicId', async () => {
      const result = await lifecycleStatus('', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

  });

  describe('lifecyclePrerequisites', () => {
    it('should return prerequisites for implementation', async () => {
      const result = await lifecyclePrerequisites('implementation', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.prerequisites).toContain('research');
      expect(data.prerequisites).toContain('specification');
      expect(data.prerequisites).toContain('decomposition');
    });

    it('should return empty prerequisites for research', async () => {
      const result = await lifecyclePrerequisites('research', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).prerequisites).toHaveLength(0);
    });

    it('should return error for invalid stage', async () => {
      const result = await lifecyclePrerequisites('invalid', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBeDefined();
    });
  });

  describe('lifecycleCheck', () => {
    it('should pass when prerequisites are met', async () => {
      await lifecycleProgress('T100', 'research', 'completed', 'done', TEST_ROOT);
      await lifecycleProgress('T100', 'specification', 'completed', 'done', TEST_ROOT);
      await lifecycleProgress('T100', 'decomposition', 'completed', 'done', TEST_ROOT);

      const result = await lifecycleCheck('T100', 'implementation', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(true);
      expect((result.data as any).missingPrerequisites).toHaveLength(0);
    });

    it('should fail when prerequisites are missing', async () => {
      await lifecycleProgress('T100', 'research', 'completed', 'done', TEST_ROOT);

      const result = await lifecycleCheck('T100', 'implementation', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(false);
      expect((result.data as any).missingPrerequisites).toContain('specification');
    });
  });

  describe('lifecycleProgress', () => {
    it('should record stage completion', async () => {
      const result = await lifecycleProgress('T200', 'research', 'completed', 'Done', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).recorded).toBe(true);

      const status = await lifecycleStatus('T200', TEST_ROOT);
      expect((status.data as any).currentStage).toBe('research');
    });

    it('should return error for invalid status', async () => {
      const result = await lifecycleProgress('T200', 'research', 'invalid', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBeDefined();
    });
  });

  describe('lifecycleSkip', () => {
    it('should skip a stage with reason', async () => {
      const result = await lifecycleSkip('T300', 'consensus', 'Not needed for this project', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).skipped).toBe(true);

      const status = await lifecycleStatus('T300', TEST_ROOT);
      const consensus = (status.data as any).stages.find((s: any) => s.stage === 'consensus');
      expect(consensus.status).toBe('skipped');
    });
  });

  describe('lifecycleReset', () => {
    it('should reset a stage', async () => {
      await lifecycleProgress('T400', 'research', 'completed', 'done', TEST_ROOT);

      const result = await lifecycleReset('T400', 'research', 'Need to redo', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).reset).toBe('pending');

      const status = await lifecycleStatus('T400', TEST_ROOT);
      const research = (status.data as any).stages.find((s: any) => s.stage === 'research');
      expect(research.status).toBe('not_started');
    });

    it('should initialize context on reset for unknown epic', async () => {
      const result = await lifecycleReset('T999', 'research', 'reason', TEST_ROOT);
      expect(result.success).toBe(true);
    });
  });

  describe('lifecycleGatePass', () => {
    it('should mark gate as passed', async () => {
      const result = await lifecycleGatePass('T500', 'research-review', 'agent-1', 'Looks good', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('passed');
    });
  });

  describe('lifecycleGateFail', () => {
    it('should mark gate as failed', async () => {
      const result = await lifecycleGateFail('T500', 'research-review', 'Missing findings', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('failed');
    });
  });

  describe('lifecycleHistory', () => {
    it('should return history for epic', async () => {
      await lifecycleProgress('T600', 'research', 'completed', 'done', TEST_ROOT);
      await lifecycleSkip('T600', 'consensus', 'Not needed', TEST_ROOT);

      const result = await lifecycleHistory('T600', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).history).toHaveLength(2);
    });

    it('should return empty history for new epic', async () => {
      const result = await lifecycleHistory('T999', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).history).toHaveLength(0);
    });
  });
});
