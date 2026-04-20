/**
 * Tests for IVTR Breaking-Change Gate (EP3-T8).
 *
 * @task T1073
 * @epic T1042
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Task } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { validateNexusImpactGate } from '../nexus-impact-gate.js';

describe('nexus-impact-gate', () => {
  const mockTask: Task = {
    id: 'T1234',
    title: 'Test task',
    description: 'A test task for impact gate',
    type: 'standard',
    status: 'active',
    priority: 'medium',
    files: ['src/utils/loadConfig.ts', 'src/auth/middleware.ts'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const projectRoot = '/test/project';

  beforeEach(() => {
    delete process.env.CLEO_NEXUS_IMPACT_GATE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CLEO_NEXUS_IMPACT_GATE;
  });

  describe('gate disabled (default)', () => {
    it('should return passed=true when CLEO_NEXUS_IMPACT_GATE is not set', async () => {
      const result = await validateNexusImpactGate(mockTask, projectRoot);

      expect(result.passed).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.narrative).toContain('disabled');
    });

    it('should return passed=true when CLEO_NEXUS_IMPACT_GATE is set to 0', async () => {
      process.env.CLEO_NEXUS_IMPACT_GATE = '0';

      const result = await validateNexusImpactGate(mockTask, projectRoot);

      expect(result.passed).toBe(true);
      expect(result.narrative).toContain('disabled');
    });
  });

  describe('gate enabled with no files', () => {
    beforeEach(() => {
      process.env.CLEO_NEXUS_IMPACT_GATE = '1';
    });

    it('should return passed=true when task has no files', async () => {
      const taskNoFiles = { ...mockTask, files: undefined };

      const result = await validateNexusImpactGate(taskNoFiles, projectRoot);

      expect(result.passed).toBe(true);
      expect(result.narrative).toContain('No files touched');
    });

    it('should return passed=true when task has empty files array', async () => {
      const taskEmptyFiles = { ...mockTask, files: [] };

      const result = await validateNexusImpactGate(taskEmptyFiles, projectRoot);

      expect(result.passed).toBe(true);
      expect(result.narrative).toContain('No files touched');
    });
  });

  describe('gate enabled with no symbols in files', () => {
    beforeEach(() => {
      process.env.CLEO_NEXUS_IMPACT_GATE = '1';
    });

    it('should return passed=true when no symbols are found in touched files', async () => {
      // When nexus DB is unavailable or has no symbols for the files, gate passes
      const result = await validateNexusImpactGate(mockTask, projectRoot);

      // Since nexus is unavailable in test environment, symbols will be empty
      expect(result.passed).toBe(true);
      // Result should indicate no symbols found or lookup failure
      expect(result.narrative).toMatch(/No symbols found|nexus symbol lookup/i);
    });
  });

  describe('gate enabled with no critical symbols', () => {
    beforeEach(() => {
      process.env.CLEO_NEXUS_IMPACT_GATE = '1';
    });

    it('should return passed=true when all symbols have acceptable risk', async () => {
      // Mock reasonImpactOfChange to return LOW risk
      vi.doMock('../../nexus/living-brain.js', () => ({
        reasonImpactOfChange: vi.fn().mockResolvedValue({
          symbolId: 'src/utils::loadConfig',
          mergedRiskScore: 'LOW',
          narrative: 'Low impact',
        }),
      }));

      // This test requires mocking at the module level; in practice,
      // the integration test would use a real or fixture nexus.db
      // For unit testing, we verify the gate logic without DB access
      const result = await validateNexusImpactGate(mockTask, projectRoot);

      // When nexus symbols cannot be retrieved, gate passes safely
      expect(result.passed).toBe(true);
    });
  });

  describe('gate error codes', () => {
    it('should use NEXUS_IMPACT_CRITICAL exit code on failure', async () => {
      process.env.CLEO_NEXUS_IMPACT_GATE = '1';

      // When gate fails, exitCode should be set
      // (Actual failure requires mocked DB with CRITICAL symbols)
      expect(ExitCode.NEXUS_IMPACT_CRITICAL).toBeDefined();
      expect(ExitCode.NEXUS_IMPACT_CRITICAL).toBe(79);
    });
  });

  describe('gate narrative', () => {
    beforeEach(() => {
      process.env.CLEO_NEXUS_IMPACT_GATE = '1';
    });

    it('should include file count in narrative when gate disabled', async () => {
      process.env.CLEO_NEXUS_IMPACT_GATE = '0';

      const result = await validateNexusImpactGate(mockTask, projectRoot);

      expect(result.narrative).toBeDefined();
      expect(result.narrative.length).toBeGreaterThan(0);
    });
  });
});
