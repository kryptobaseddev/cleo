/**
 * Unit tests for `emitDispatchTrace`.
 *
 * Verifies that:
 * - `verifyAndStore` is called with the correct `memoryType`, `sourceConfidence`,
 *   and `tier` when `emitDispatchTrace` is invoked.
 * - The universal-fallback path (the primary T1325 scenario) produces a trace
 *   that carries `fallbackUsed=true` and the `resolverWarning` text.
 * - Registry-hit traces produce `fallbackUsed=false` with no `resolverWarning`.
 * - The emitted text contains all required trace fields.
 *
 * @task T1325
 * @epic T1323
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock verifyAndStore so no real brain.db is opened
// ---------------------------------------------------------------------------

const mockVerifyAndStore = vi.fn().mockResolvedValue({ action: 'stored', id: 'O-test' });

vi.mock('../extraction-gate.js', () => ({
  verifyAndStore: (...args: unknown[]) => mockVerifyAndStore(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitDispatchTrace', () => {
  it('calls verifyAndStore with memoryType=pattern and sourceConfidence=speculative', async () => {
    mockVerifyAndStore.mockClear();

    const { emitDispatchTrace } = await import('../dispatch-trace.js');

    await emitDispatchTrace('/tmp/fake-project', {
      taskId: 'T1000',
      predictedAgentId: 'ct-cleo',
      confidence: 0.87,
      reason: "resolved at tier 'packaged'",
      registryHit: true,
      fallbackUsed: false,
      resolvedAt: '2026-04-24T00:00:00.000Z',
    });

    expect(mockVerifyAndStore).toHaveBeenCalledOnce();

    const [projectRoot, candidate] = mockVerifyAndStore.mock.calls[0] as [string, unknown];
    expect(projectRoot).toBe('/tmp/fake-project');

    const c = candidate as Record<string, unknown>;
    // 'procedural' is the BRAIN schema value for process/dispatch knowledge
    // (task spec named this 'pattern' but the schema uses 'procedural')
    expect(c.memoryType).toBe('procedural');
    expect(c.sourceConfidence).toBe('speculative');
    expect(c.tier).toBe('short');
    expect(c.source).toBe('task-completion');
  });

  it('universal-fallback path — trace includes resolverWarning and fallbackUsed=true', async () => {
    mockVerifyAndStore.mockClear();

    const { emitDispatchTrace } = await import('../dispatch-trace.js');

    const warning =
      "[agent-resolver] agent 'ghost-agent' not found in project/global/packaged/fallback tiers — " +
      "falling back to universal base 'cleo-subagent'.";

    await emitDispatchTrace('/tmp/fake-project', {
      taskId: 'T9999',
      predictedAgentId: 'ghost-agent',
      confidence: 0,
      reason: 'universal-base fallback engaged after tiers: project, global, packaged, fallback',
      registryHit: false,
      fallbackUsed: true,
      resolverWarning: warning,
      resolvedAt: '2026-04-24T00:00:00.000Z',
    });

    expect(mockVerifyAndStore).toHaveBeenCalledOnce();

    const [, candidate] = mockVerifyAndStore.mock.calls[0] as [string, unknown];
    const c = candidate as Record<string, unknown>;

    // Title should signal universal fallback
    expect(c.title as string).toContain('universal-fallback');

    // Text must contain the resolver warning
    expect(c.text as string).toContain('resolverWarning:');
    expect(c.text as string).toContain('ghost-agent');
    expect(c.text as string).toContain('fallbackUsed: true');
  });

  it('registry-hit path — no resolverWarning in text', async () => {
    mockVerifyAndStore.mockClear();

    const { emitDispatchTrace } = await import('../dispatch-trace.js');

    await emitDispatchTrace('/tmp/fake-project', {
      taskId: 'T2000',
      predictedAgentId: 'ct-orchestrator',
      confidence: 0.95,
      reason: "resolved at tier 'global'",
      registryHit: true,
      fallbackUsed: false,
      resolvedAt: '2026-04-24T00:00:00.000Z',
    });

    expect(mockVerifyAndStore).toHaveBeenCalledOnce();

    const [, candidate] = mockVerifyAndStore.mock.calls[0] as [string, unknown];
    const c = candidate as Record<string, unknown>;

    expect(c.text as string).not.toContain('resolverWarning');
    expect(c.text as string).toContain('registryHit: true');
    expect(c.text as string).toContain('fallbackUsed: false');
  });
});
