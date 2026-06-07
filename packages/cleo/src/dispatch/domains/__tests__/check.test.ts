import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/engine.js', () => ({
  validateSchemaOp: vi.fn(),
  validateTaskOp: vi.fn(),
  validateProtocol: vi.fn(),
  validateManifestOp: vi.fn(),
  validateOutput: vi.fn(),
  validateComplianceSummary: vi.fn(),
  validateComplianceViolations: vi.fn(),
  validateComplianceRecord: vi.fn(),
  validateTestStatus: vi.fn(),
  validateTestCoverage: vi.fn(),
  validateCoherenceCheck: vi.fn(),
  validateTestRun: vi.fn(),
  validateProtocolConsensus: vi.fn(),
  validateProtocolContribution: vi.fn(),
  validateProtocolDecomposition: vi.fn(),
  validateProtocolImplementation: vi.fn(),
  validateProtocolSpecification: vi.fn(),
  validateGateVerify: vi.fn(),
  // T1571: systemArchiveStats removed from barrel (moved to @cleocode/core/internal as getArchiveStats)
}));

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

import { CheckHandler } from '../check.js';

describe('CheckHandler operations', () => {
  let handler: CheckHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CheckHandler();
  });

  it('includes grade in supported query operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('grade');
    expect(ops.query).toContain('grade.list');
    // chain.validate / chain.gate removed in T11807 (Tessera/WarpChain collapse, T11764).
    expect(ops.query).not.toContain('chain.validate');
    expect(ops.query).not.toContain('chain.gate');
  });

  it('returns E_INTERNAL for chain.gate (removed from check)', async () => {
    const result = await handler.query('chain.gate', { instanceId: 'wci-1', gateId: 'g-1' });

    // chain.gate is not in CheckOps, so typedDispatch will fail to find the operation
    expect(result.success).toBe(false);
    // The error will be E_INTERNAL since the operation doesn't exist in the typed handler
    expect(result.error?.code).toBe('E_INTERNAL');
  });
});
