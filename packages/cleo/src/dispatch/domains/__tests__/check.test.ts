import type { AcceptanceGateResult } from '@cleocode/contracts';
import { previewTaskGates } from '@cleocode/core/tasks/gate-preview';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reportRawError } from '../../adapters/cli.js';

vi.mock('@cleocode/core/tasks/gate-preview', () => ({ previewTaskGates: vi.fn() }));

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

  it.each([
    {
      name: 'a collection failure',
      exitCode: 1,
      stdout: 'Test Files 1 failed\nTests 0 tests',
      stderr: 'Cannot find package @cleocode/nexus/reference-spool',
    },
    {
      name: 'an unprovable test count after exit zero',
      exitCode: 0,
      stdout: 'Tests 2 passed',
      stderr: '',
    },
  ])('gate.run refuses $name and preserves its evidence', async ({ exitCode, stdout, stderr }) => {
    const result: AcceptanceGateResult = {
      index: 0,
      req: 'MERGED-CHECKOUT',
      kind: 'test',
      result: 'error',
      durationMs: 10,
      checkedAt: new Date().toISOString(),
      checkedBy: 'test',
      errorMessage: 'minCount 2 cannot be proved: pnpm emitted no machine-readable test report',
      details: { kind: 'test', exitCode, stdout, stderr, duration: 10 },
      evidence: stdout,
    };
    const preview = {
      taskId: 'T14524',
      gateCount: 1,
      passed: false,
      persisted: false as const,
      results: [result],
      cache: {
        head: 'abc123',
        entries: [{ index: 0, req: result.req, cached: false, reason: 'only a pass is cached' }],
      },
    };
    vi.mocked(previewTaskGates).mockResolvedValue(preview);

    const response = await handler.query('gate.run', { taskId: 'T14524', req: result.req });

    expect(response.success).toBe(false);
    expect(response.error).toMatchObject({
      code: 'E_GATE_RUN_FAILED',
      message: expect.stringContaining(result.errorMessage!),
      fix: 'cleo verify T14524 --run',
      details: preview,
    });
    expect(previewTaskGates).toHaveBeenCalledWith(expect.any(String), {
      taskId: 'T14524',
      req: result.req,
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previousExitCode = process.exitCode;
    try {
      expect(reportRawError(response, { operation: 'check.gate.run' })).toBe(1);
      expect(process.exitCode).toBe(1);
      const written = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(JSON.parse(written)).toMatchObject({
        success: false,
        error: { code: 1, codeName: 'E_GATE_RUN_FAILED', details: preview },
      });
    } finally {
      stdoutSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it.each<AcceptanceGateResult['result']>([
    'pass',
    'fail',
    'warn',
    'skipped',
  ])('gate.run reports %s accurately even when the preview passed flag is true', async (result) => {
    const preview = {
      taskId: 'T14524',
      gateCount: 1,
      passed: true,
      persisted: false as const,
      results: [
        {
          index: 0,
          kind: 'test' as const,
          result,
          durationMs: 1,
          checkedAt: new Date().toISOString(),
          checkedBy: 'test',
        },
      ],
    };
    vi.mocked(previewTaskGates).mockResolvedValue(preview);

    const response = await handler.query('gate.run', { taskId: 'T14524' });

    expect(response.success).toBe(result === 'pass');
    if (result === 'pass') expect(response.data).toEqual(preview);
    else {
      expect(response.error?.code).toBe('E_GATE_RUN_FAILED');
      expect(response.error?.details).toEqual(preview);
    }
  });

  it('gate.run keeps the no-typed-gates response successful', async () => {
    const preview = {
      taskId: 'T14524',
      gateCount: 0,
      passed: true,
      persisted: false as const,
      results: [],
      note: 'T14524 has no typed acceptance gates',
    };
    vi.mocked(previewTaskGates).mockResolvedValue(preview);

    const response = await handler.query('gate.run', { taskId: 'T14524' });

    expect(response.success).toBe(true);
    expect(response.data).toEqual(preview);
  });
});
