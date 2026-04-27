/**
 * Check Domain Handler — operation routing tests.
 *
 * Verifies that the typed dispatch layer routes each operation to the
 * correct Core normalized op (ADR-057 D1 shape, T1452).
 *
 * @task T1452 — updated mocks to Core ops shape
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckHandler } from '../check.js';

// ---------------------------------------------------------------------------
// Mock Core internal — check ops (ADR-057 D1 normalized shape, T1452)
// ---------------------------------------------------------------------------
vi.mock('@cleocode/core/internal', () => ({
  checkArchiveStats: vi.fn(),
  checkCoherence: vi.fn(),
  checkComplianceRecord: vi.fn(),
  checkComplianceSummary: vi.fn(),
  checkComplianceSync: vi.fn(),
  checkGradeSession: vi.fn(),
  checkReadGrades: vi.fn(),
  checkRevalidateEvidence: vi.fn(),
  checkTestCoverage: vi.fn(),
  checkTestRun: vi.fn(),
  checkTestStatus: vi.fn(),
  checkValidateChain: vi.fn(),
  checkValidateManifest: vi.fn(),
  checkValidateOutput: vi.fn(),
  checkValidateProtocol: vi.fn(),
  checkValidateSchema: vi.fn(),
  checkValidateTask: vi.fn(),
  checkWorkflowCompliance: vi.fn(),
  getLogger: vi.fn(() => ({ error: vi.fn() })),
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

// ---------------------------------------------------------------------------
// Mock engine.js — only sub-protocol ops remain in the engine layer
// ---------------------------------------------------------------------------
vi.mock('../../lib/engine.js', () => ({
  validateGateVerify: vi.fn(),
  validateProtocolArchitectureDecision: vi.fn(),
  validateProtocolArtifactPublish: vi.fn(),
  validateProtocolConsensus: vi.fn(),
  validateProtocolContribution: vi.fn(),
  validateProtocolDecomposition: vi.fn(),
  validateProtocolImplementation: vi.fn(),
  validateProtocolProvenance: vi.fn(),
  validateProtocolRelease: vi.fn(),
  validateProtocolResearch: vi.fn(),
  validateProtocolSpecification: vi.fn(),
  validateProtocolTesting: vi.fn(),
  validateProtocolValidation: vi.fn(),
}));

import {
  checkArchiveStats,
  checkCoherence,
  checkComplianceSummary,
  checkTestCoverage,
  checkTestStatus,
  checkValidateProtocol,
} from '@cleocode/core/internal';
import { validateGateVerify, validateProtocolConsensus } from '../../lib/engine.js';

describe('CheckHandler Operations', () => {
  let handler: CheckHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CheckHandler();

    // Default mock implementations
    vi.mocked(checkComplianceSummary).mockReturnValue({
      total: 0,
      passed: 0,
      failed: 0,
      score: 0,
      byProtocol: {},
      bySeverity: { error: 0, warning: 0, info: 0 },
    });
    vi.mocked(checkTestStatus).mockReturnValue({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      passRate: 0,
    });
    vi.mocked(checkTestCoverage).mockReturnValue({
      lineCoverage: 100,
      branchCoverage: 100,
      functionCoverage: 100,
      statementCoverage: 100,
      threshold: 80,
      meetsThreshold: true,
    });
    vi.mocked(checkCoherence).mockResolvedValue({
      passed: true,
      issues: [],
      warnings: [],
    });
    vi.mocked(checkValidateProtocol).mockResolvedValue({
      taskId: '',
      protocol: '',
      passed: false,
      score: 0,
      violations: [],
      requirements: { total: 0, met: 0, failed: 0 },
    });
    vi.mocked(validateProtocolConsensus).mockResolvedValue({
      success: true,
      data: { taskId: '', protocol: '', passed: false, score: 0, violations: [], requirements: {} },
    } as never);
    vi.mocked(validateGateVerify).mockResolvedValue({
      success: true,
      data: { taskId: '', gates: {}, passed: false, round: 0 },
    } as never);
    vi.mocked(checkArchiveStats).mockResolvedValue({});
  });

  describe('compliance.summary', () => {
    it('calls checkComplianceSummary by default', async () => {
      await handler.query('compliance.summary');
      expect(checkComplianceSummary).toHaveBeenCalled();
    });

    it('calls checkComplianceSummary with detail flag (handled internally)', async () => {
      await handler.query('compliance.summary', { detail: true, limit: 10 });
      expect(checkComplianceSummary).toHaveBeenCalledWith(
        '/mock/project',
        expect.objectContaining({ detail: true, limit: 10 }),
      );
    });
  });

  describe('test', () => {
    it('calls checkTestStatus by default', async () => {
      await handler.query('test');
      expect(checkTestStatus).toHaveBeenCalled();
      expect(checkTestCoverage).not.toHaveBeenCalled();
    });

    it('calls checkTestCoverage when format is coverage', async () => {
      await handler.query('test', { format: 'coverage' });
      expect(checkTestCoverage).toHaveBeenCalled();
      expect(checkTestStatus).not.toHaveBeenCalled();
    });
  });

  describe('coherence', () => {
    it('calls checkCoherence', async () => {
      await handler.query('coherence');
      expect(checkCoherence).toHaveBeenCalled();
    });
  });

  describe('protocol', () => {
    it('calls checkValidateProtocol (generic) when no type provided', async () => {
      await handler.query('protocol', { taskId: 'T1' });
      expect(checkValidateProtocol).toHaveBeenCalledWith(
        '/mock/project',
        expect.objectContaining({ taskId: 'T1' }),
      );
    });

    it('calls validateProtocolConsensus when type is consensus', async () => {
      await handler.query('protocol', { protocolType: 'consensus', taskId: 'T1', strict: true });
      expect(validateProtocolConsensus).toHaveBeenCalledWith(
        {
          mode: 'task',
          taskId: 'T1',
          manifestFile: undefined,
          strict: true,
          votingMatrixFile: undefined,
        },
        '/mock/project',
      );
    });
  });

  describe('gate operations', () => {
    it('gate.status calls validateGateVerify with read-only context', async () => {
      await handler.query('gate.status', { taskId: 'T1' });
      expect(validateGateVerify).toHaveBeenCalledWith({ taskId: 'T1' }, '/mock/project');
    });

    it('gate.set calls validateGateVerify with write params', async () => {
      await handler.mutate('gate.set', { taskId: 'T1', gate: 'testsPassed', value: true });
      expect(validateGateVerify).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'T1',
          gate: 'testsPassed',
          value: true,
        }),
        '/mock/project',
      );
    });
  });

  describe('archive.stats', () => {
    it('calls checkArchiveStats', async () => {
      await handler.query('archive.stats');
      expect(checkArchiveStats).toHaveBeenCalled();
    });
  });
});
