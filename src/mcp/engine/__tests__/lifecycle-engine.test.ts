/**
 * Lifecycle Engine Tests
 *
 * Tests native TypeScript lifecycle operations.
 *
 * @task T4475
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
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
} from '../../../dispatch/engines/lifecycle-engine.js';
import { readJsonFile } from '../store.js';

const TEST_ROOT = join(process.cwd(), '.test-lifecycle-engine');
const RCSD_DIR = join(TEST_ROOT, '.cleo', 'rcasd');

function writeRcsdManifest(epicId: string, manifest: any): void {
  const dir = join(RCSD_DIR, epicId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

describe('Lifecycle Engine', () => {
  beforeEach(() => {
    mkdirSync(RCSD_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  describe('lifecycleStatus', () => {
    it('should return uninitialized status for new epic', () => {
      const result = lifecycleStatus('T999', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).initialized).toBe(false);
      expect((result.data as any).nextStage).toBe('research');
    });

    it('should return correct status for initialized epic', () => {
      writeRcsdManifest('T100', {
        epicId: 'T100',
        title: 'Test Epic',
        stages: {
          research: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
          consensus: { status: 'skipped' },
          specification: { status: 'pending' },
        },
      });

      const result = lifecycleStatus('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).initialized).toBe(true);
      expect((result.data as any).currentStage).toBe('consensus');
    });

    it('should return error for missing epicId', () => {
      const result = lifecycleStatus('', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

  });

  describe('lifecyclePrerequisites', () => {
    it('should return prerequisites for implementation', () => {
      const result = lifecyclePrerequisites('implementation', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.prerequisites).toContain('research');
      expect(data.prerequisites).toContain('specification');
      expect(data.prerequisites).toContain('decomposition');
    });

    it('should return empty prerequisites for research', () => {
      const result = lifecyclePrerequisites('research', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).prerequisites).toHaveLength(0);
    });

    it('should return error for invalid stage', () => {
      const result = lifecyclePrerequisites('invalid', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBeDefined();
    });
  });

  describe('lifecycleCheck', () => {
    it('should pass when prerequisites are met', () => {
      writeRcsdManifest('T100', {
        epicId: 'T100',
        stages: {
          research: { status: 'completed' },
          specification: { status: 'completed' },
          decomposition: { status: 'completed' },
        },
      });

      const result = lifecycleCheck('T100', 'implementation', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(true);
      expect((result.data as any).missingPrerequisites).toHaveLength(0);
    });

    it('should fail when prerequisites are missing', () => {
      writeRcsdManifest('T100', {
        epicId: 'T100',
        stages: {
          research: { status: 'completed' },
        },
      });

      const result = lifecycleCheck('T100', 'implementation', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).valid).toBe(false);
      expect((result.data as any).missingPrerequisites).toContain('specification');
    });
  });

  describe('lifecycleProgress', () => {
    it('should record stage completion', () => {
      const result = lifecycleProgress('T200', 'research', 'completed', 'Done', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).recorded).toBe(true);

      // Verify written
      const manifest = readJsonFile<any>(join(RCSD_DIR, 'T200', '_manifest.json'));
      expect(manifest.stages.research.status).toBe('completed');
      expect(manifest.stages.research.completedAt).toBeDefined();
    });

    it('should return error for invalid status', () => {
      const result = lifecycleProgress('T200', 'research', 'invalid', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBeDefined();
    });
  });

  describe('lifecycleSkip', () => {
    it('should skip a stage with reason', () => {
      const result = lifecycleSkip('T300', 'consensus', 'Not needed for this project', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).skipped).toBe(true);

      const manifest = readJsonFile<any>(join(RCSD_DIR, 'T300', '_manifest.json'));
      expect(manifest.stages.consensus.status).toBe('skipped');
      expect(manifest.stages.consensus.skippedReason).toBe('Not needed for this project');
    });
  });

  describe('lifecycleReset', () => {
    it('should reset a stage', () => {
      writeRcsdManifest('T400', {
        epicId: 'T400',
        stages: {
          research: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
        },
      });

      const result = lifecycleReset('T400', 'research', 'Need to redo', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).reset).toBe('pending');

      const manifest = readJsonFile<any>(join(RCSD_DIR, 'T400', '_manifest.json'));
      expect(manifest.stages.research.status).toBeDefined();
    });

    it('should return error for missing manifest', () => {
      const result = lifecycleReset('T999', 'research', 'reason', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('lifecycleGatePass', () => {
    it('should mark gate as passed', () => {
      const result = lifecycleGatePass('T500', 'research-review', 'agent-1', 'Looks good', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('passed');
    });
  });

  describe('lifecycleGateFail', () => {
    it('should mark gate as failed', () => {
      const result = lifecycleGateFail('T500', 'research-review', 'Missing findings', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('failed');
    });
  });

  describe('lifecycleHistory', () => {
    it('should return history for epic', () => {
      writeRcsdManifest('T600', {
        epicId: 'T600',
        stages: {
          research: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
          consensus: { status: 'skipped', skippedAt: '2026-01-02T00:00:00Z', skippedReason: 'Not needed' },
        },
      });

      const result = lifecycleHistory('T600', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).history).toHaveLength(2);
    });

    it('should return empty history for new epic', () => {
      const result = lifecycleHistory('T999', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).history).toHaveLength(0);
    });
  });
});
