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
  systemArchiveStats: vi.fn(),
}));

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

vi.mock('../../../core/validation/chain-validation.js', () => ({
  validateChain: vi.fn(),
}));

import { CheckHandler } from '../check.js';
import { validateChain } from '../../../core/validation/chain-validation.js';

function makeForkJoinChain() {
  return {
    id: 'fork-join-chain',
    name: 'Fork Join Chain',
    version: '1.0.0',
    description: 'Fork-join chain fixture',
    shape: {
      stages: [
        { id: 'start', name: 'start', category: 'custom', skippable: false },
        { id: 'fork-left', name: 'fork-left', category: 'custom', skippable: false },
        { id: 'fork-right', name: 'fork-right', category: 'custom', skippable: false },
        { id: 'join', name: 'join', category: 'custom', skippable: false },
        { id: 'finish', name: 'finish', category: 'custom', skippable: false },
      ],
      links: [
        { from: 'start', to: 'fork-left', type: 'fork' },
        { from: 'start', to: 'fork-right', type: 'fork' },
        { from: 'fork-left', to: 'join', type: 'linear' },
        { from: 'fork-right', to: 'join', type: 'linear' },
        { from: 'join', to: 'finish', type: 'linear' },
      ],
      entryPoint: 'start',
      exitPoints: ['finish'],
    },
    gates: [],
  };
}

describe('CheckHandler operations', () => {
  let handler: CheckHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CheckHandler();
  });

  it('includes grade and chain.validate in supported query operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('chain.validate');
    expect(ops.query).toContain('grade');
    expect(ops.query).toContain('grade.list');
    // chain.gate was removed
    expect(ops.query).not.toContain('chain.gate');
  });

  it('validates fork-join chain through check.chain.validate route', async () => {
    vi.mocked(validateChain).mockReturnValue({
      wellFormed: true,
      gateSatisfiable: true,
      errors: [],
      warnings: [],
    } as any);

    const result = await handler.query('chain.validate', {
      chain: makeForkJoinChain(),
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      wellFormed: true,
      gateSatisfiable: true,
      errors: [],
    });
  });

  it('returns E_INVALID_OPERATION for chain.gate (removed from check)', async () => {
    const result = await handler.query('chain.gate', { instanceId: 'wci-1', gateId: 'g-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_OPERATION');
  });
});
