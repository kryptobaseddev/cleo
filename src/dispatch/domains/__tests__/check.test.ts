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
}));

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

vi.mock('../../../core/lifecycle/chain-store.js', () => ({
  showInstance: vi.fn(),
  showChain: vi.fn(),
  listInstanceGateResults: vi.fn(),
}));

import { CheckHandler } from '../check.js';
import {
  showInstance,
  showChain,
  listInstanceGateResults,
} from '../../../core/lifecycle/chain-store.js';

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

describe('CheckHandler chain gate operations', () => {
  let handler: CheckHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CheckHandler();
  });

  it('includes chain.gate in supported query operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('chain.gate');
    expect(ops.query).toContain('chain.validate');
  });

  it('validates fork-join chain through check.chain.validate route', async () => {
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

  it('returns gate-specific status when gateId is provided', async () => {
    vi.mocked(showInstance).mockResolvedValue({ id: 'wci-1', chainId: 'chain-1' } as any);
    vi.mocked(showChain).mockResolvedValue({
      id: 'chain-1',
      gates: [{ id: 'g-1' }],
    } as any);
    vi.mocked(listInstanceGateResults).mockResolvedValue([
      { gateId: 'g-1', passed: true, forced: false, evaluatedAt: '2026-03-01T00:00:00.000Z' },
    ] as any);

    const result = await handler.query('chain.gate', { instanceId: 'wci-1', gateId: 'g-1' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      instanceId: 'wci-1',
      gateId: 'g-1',
      gateExists: true,
      passed: true,
    });
  });

  it('returns summary when gateId is omitted', async () => {
    vi.mocked(showInstance).mockResolvedValue({ id: 'wci-1', chainId: 'chain-1' } as any);
    vi.mocked(showChain).mockResolvedValue({ id: 'chain-1', gates: [{ id: 'g-1' }, { id: 'g-2' }] } as any);
    vi.mocked(listInstanceGateResults).mockResolvedValue([
      { gateId: 'g-1', passed: true, forced: false, evaluatedAt: '2026-03-01T00:00:00.000Z' },
      { gateId: 'g-2', passed: false, forced: false, evaluatedAt: '2026-03-01T00:01:00.000Z' },
    ] as any);

    const result = await handler.query('chain.gate', { instanceId: 'wci-1' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      instanceId: 'wci-1',
      chainId: 'chain-1',
      totalDefinedGates: 2,
      totalEvaluations: 2,
      passed: 1,
      failed: 1,
    });
  });
});
