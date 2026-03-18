import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckHandler } from '../check.js';

// Mock dependencies
vi.mock('../../lib/engine.js', () => ({
  validateComplianceSummary: vi.fn(),
  validateComplianceViolations: vi.fn(),
  validateTestStatus: vi.fn(),
  validateTestCoverage: vi.fn(),
  validateCoherenceCheck: vi.fn(),
  validateProtocol: vi.fn(),
  validateProtocolConsensus: vi.fn(),
  validateProtocolContribution: vi.fn(),
  validateProtocolDecomposition: vi.fn(),
  validateProtocolImplementation: vi.fn(),
  validateProtocolSpecification: vi.fn(),
  validateGateVerify: vi.fn(),
  systemArchiveStats: vi.fn(),
  validateSchemaOp: vi.fn(),
  validateTaskOp: vi.fn(),
  validateManifestOp: vi.fn(),
  validateOutput: vi.fn(),
  validateComplianceRecord: vi.fn(),
  validateTestRun: vi.fn(),
}));

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

vi.mock('../../../core/logger.js', () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
  })),
}));

import {
  systemArchiveStats,
  validateCoherenceCheck,
  validateComplianceSummary,
  validateComplianceViolations,
  validateGateVerify,
  validateProtocol,
  validateProtocolConsensus,
  validateTestCoverage,
  validateTestStatus,
} from '../../lib/engine.js';

describe('CheckHandler Operations', () => {
  let handler: CheckHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CheckHandler();

    // Default mock implementations to return success
    vi.mocked(validateComplianceSummary).mockReturnValue({ success: true, data: {} } as any);
    vi.mocked(validateComplianceViolations).mockReturnValue({ success: true, data: {} } as any);
    vi.mocked(validateTestStatus).mockReturnValue({ success: true, data: {} } as any);
    vi.mocked(validateTestCoverage).mockReturnValue({ success: true, data: {} } as any);
    vi.mocked(validateCoherenceCheck).mockResolvedValue({ success: true, data: {} } as any);
    vi.mocked(validateProtocol).mockResolvedValue({ success: true, data: {} } as any);
    vi.mocked(validateProtocolConsensus).mockResolvedValue({ success: true, data: {} } as any);
    vi.mocked(validateGateVerify).mockResolvedValue({ success: true, data: {} } as any);
    vi.mocked(systemArchiveStats).mockResolvedValue({ success: true, data: {} } as any);
  });

  describe('compliance.summary', () => {
    it('calls validateComplianceSummary by default', async () => {
      await handler.query('compliance.summary');
      expect(validateComplianceSummary).toHaveBeenCalled();
      expect(validateComplianceViolations).not.toHaveBeenCalled();
    });

    it('calls validateComplianceViolations when detail is true', async () => {
      await handler.query('compliance.summary', { detail: true, limit: 10 });
      expect(validateComplianceViolations).toHaveBeenCalledWith(10, '/mock/project');
      expect(validateComplianceSummary).not.toHaveBeenCalled();
    });
  });

  describe('test', () => {
    it('calls validateTestStatus by default', async () => {
      await handler.query('test');
      expect(validateTestStatus).toHaveBeenCalled();
      expect(validateTestCoverage).not.toHaveBeenCalled();
    });

    it('calls validateTestCoverage when format is coverage', async () => {
      await handler.query('test', { format: 'coverage' });
      expect(validateTestCoverage).toHaveBeenCalled();
      expect(validateTestStatus).not.toHaveBeenCalled();
    });
  });

  describe('coherence', () => {
    it('calls validateCoherenceCheck', async () => {
      await handler.query('coherence');
      expect(validateCoherenceCheck).toHaveBeenCalled();
    });
  });

  describe('protocol', () => {
    it('calls validateProtocol (generic) when no type provided', async () => {
      await handler.query('protocol', { taskId: 'T1' });
      expect(validateProtocol).toHaveBeenCalledWith('T1', undefined, '/mock/project');
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
    it('calls systemArchiveStats', async () => {
      await handler.query('archive.stats');
      expect(systemArchiveStats).toHaveBeenCalled();
    });
  });
});
