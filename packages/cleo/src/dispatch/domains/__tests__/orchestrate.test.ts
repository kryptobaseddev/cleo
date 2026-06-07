import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/engine.js', () => ({
  orchestrateStatus: vi.fn(),
  orchestrateAnalyze: vi.fn(),
  orchestrateReady: vi.fn(),
  orchestrateNext: vi.fn(),
  orchestrateWaves: vi.fn(),
  orchestrateContext: vi.fn(),
  orchestrateBootstrap: vi.fn(),
  orchestrateUnblockOpportunities: vi.fn(),
  orchestrateCriticalPath: vi.fn(),
  orchestrateStartup: vi.fn(),
  orchestrateSpawn: vi.fn(),
  orchestrateHandoff: vi.fn(),
  orchestrateSpawnExecute: vi.fn(),
  orchestrateValidate: vi.fn(),
  orchestrateParallelStart: vi.fn(),
  orchestrateParallelEnd: vi.fn(),
  orchestrateCheck: vi.fn(),
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

import { OrchestrateHandler } from '../orchestrate.js';

describe('OrchestrateHandler operations', () => {
  let handler: OrchestrateHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new OrchestrateHandler();
  });

  it('does not include chain.plan or tessera ops in supported operations (removed)', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).not.toContain('chain.plan');
    // Verify expected ops are present
    expect(ops.query).toContain('status');
    expect(ops.query).toContain('analyze');
    expect(ops.mutate).toContain('parallel');
    // tessera.* removed in T11807 (Tessera/WarpChain collapse, T11764).
    expect(ops.query).not.toContain('tessera.list');
    expect(ops.mutate).not.toContain('tessera.instantiate');
  });

  it('returns E_INVALID_OPERATION for chain.plan (removed from orchestrate)', async () => {
    const result = await handler.query('chain.plan', { chainId: 'chain-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_OPERATION');
  });
});

// ---------------------------------------------------------------------------
// worktree.complete dispatch — ADR-062 / T1601
// ---------------------------------------------------------------------------

describe('OrchestrateHandler.mutate("worktree.complete") — ADR-062 merge wiring', () => {
  let handler: OrchestrateHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new OrchestrateHandler();
  });

  it('invokes completeAgentWorktreeViaMerge (ADR-062 merge path)', async () => {
    // T1624: legacy completeAgentWorktree (cherry-pick) has been deleted.
    // This test verifies the merge-based path is the only integration route.
    const internal = await import('@cleocode/core/internal');
    const mergeSpy = vi.spyOn(internal, 'completeAgentWorktreeViaMerge').mockReturnValue({
      taskId: 'T1601',
      targetBranch: 'main',
      merged: true,
      mergeCommit: 'a'.repeat(40),
      commitCount: 2,
      rebased: true,
      worktreeRemoved: true,
      branchDeleted: true,
    });

    const result = await handler.mutate('worktree.complete', { taskId: 'T1601' });

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledWith('T1601', '/mock/project');
    expect(result.success).toBe(true);
    const data = result.data as { merged: boolean; targetBranch: string; mergeCommit: string };
    expect(data.merged).toBe(true);
    expect(data.targetBranch).toBe('main');
    expect(data.mergeCommit).toHaveLength(40);
  });

  it('surfaces merge failure as dispatch error (E_WORKTREE_COMPLETE_FAILED)', async () => {
    const internal = await import('@cleocode/core/internal');
    vi.spyOn(internal, 'completeAgentWorktreeViaMerge').mockReturnValue({
      taskId: 'T1601',
      targetBranch: 'main',
      merged: false,
      mergeCommit: '',
      commitCount: 1,
      rebased: false,
      worktreeRemoved: false,
      branchDeleted: false,
      error: 'Rebase onto origin/main failed: conflict in feature.ts',
    });

    const result = await handler.mutate('worktree.complete', { taskId: 'T1601' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_WORKTREE_COMPLETE_FAILED');
    expect(result.error?.message).toMatch(/Rebase onto origin\/main failed/);
  });

  it('rejects worktree.complete without taskId (E_INVALID_INPUT)', async () => {
    const result = await handler.mutate('worktree.complete', {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// spawn dispatch — T10430 --orchestrator-defer atomicity waiver wiring
// ---------------------------------------------------------------------------

describe('OrchestrateHandler.mutate("spawn") — T10430 atomicityScope wiring', () => {
  let handler: OrchestrateHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new OrchestrateHandler();
  });

  it('forwards atomicityScope="orchestrator-defer" to orchestrateSpawn (T10430)', async () => {
    // The dispatch layer imports orchestrateSpawn from '../lib/engine.js' (see
    // the top-level vi.mock at line 3 — every engine helper is a vi.fn).
    const engine = await import('../../lib/engine.js');
    const spawnSpy = vi.mocked(engine.orchestrateSpawn);
    spawnSpy.mockResolvedValue({
      success: true,
      data: {
        taskId: 'T10430',
        prompt: 'spawn prompt',
        atomicity: {
          allowed: true,
          atomicity_waiver: 'orchestrator-scope-tier1-call',
        },
      },
    });

    const result = await handler.mutate('spawn', {
      taskId: 'T10430',
      atomicityScope: 'orchestrator-defer',
    });

    expect(result.success).toBe(true);
    // The dispatch must forward the waiver as the seventh positional arg of
    // orchestrateSpawn (after taskId, protocolType, projectRoot, tier,
    // noWorktree, spawnScope).
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0];
    expect(callArgs?.[0]).toBe('T10430');
    expect(callArgs?.[6]).toBe('orchestrator-defer');
  });

  it('rejects unknown atomicityScope values (defense-in-depth contract narrowing)', async () => {
    const engine = await import('../../lib/engine.js');
    const spawnSpy = vi.mocked(engine.orchestrateSpawn);
    spawnSpy.mockResolvedValue({
      success: true,
      data: { taskId: 'T10430', prompt: 'spawn prompt', atomicity: { allowed: true } },
    });

    await handler.mutate('spawn', {
      taskId: 'T10430',
      // Anything other than the literal 'orchestrator-defer' MUST be dropped
      // so a hostile caller cannot widen the waiver contract.
      atomicityScope: 'arbitrary-string',
    });

    const callArgs = spawnSpy.mock.calls[0];
    expect(callArgs?.[6]).toBeUndefined();
  });

  it('omits atomicityScope when the CLI did not pass --orchestrator-defer', async () => {
    const engine = await import('../../lib/engine.js');
    const spawnSpy = vi.mocked(engine.orchestrateSpawn);
    spawnSpy.mockResolvedValue({
      success: true,
      data: { taskId: 'T10430', prompt: 'spawn prompt', atomicity: { allowed: true } },
    });

    await handler.mutate('spawn', { taskId: 'T10430' });

    const callArgs = spawnSpy.mock.calls[0];
    expect(callArgs?.[6]).toBeUndefined();
  });
});
