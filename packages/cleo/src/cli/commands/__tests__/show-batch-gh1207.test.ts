/**
 * Tests for batched `cleo show` (gh#1207).
 *
 * CLI startup is a fixed ~1.31s floor, measured and dominated by module
 * loading rather than by the query itself. The reporter's 25-task status
 * sweep therefore spent ~33s of its 2.5 minutes simply starting Node 25 times.
 * Accepting several ids amortises that floor across one process.
 *
 * The contract that matters most here is the one that is easy to break
 * silently: a SINGLE id must keep the exact prior envelope, because every
 * existing script and agent parses that shape.
 *
 * @task T12141 (gh#1207)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchFromCliMock = vi.fn();
const dispatchRawMock = vi.fn();
const cliOutputMock = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...a: unknown[]) => dispatchFromCliMock(...a),
  dispatchRaw: (...a: unknown[]) => dispatchRawMock(...a),
}));
vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...a: unknown[]) => cliOutputMock(...a),
}));
vi.mock('../../lib/registry-args.js', () => ({
  getOperationParams: () => [],
  paramsToCittyArgs: () => ({}),
}));

const { showCommand } = await import('../show.js');

// citty's run receives a ctx; only `args` is read by this handler.
function run(args: Record<string, unknown>): Promise<void> {
  const cmd = showCommand as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
  };
  return cmd.run({ args });
}

beforeEach(() => {
  dispatchFromCliMock.mockReset();
  dispatchRawMock.mockReset();
  cliOutputMock.mockReset();
  process.exitCode = 0;
});

describe('gh#1207 — a single id is unchanged', () => {
  it('uses the normal dispatch path and emits no batch envelope', async () => {
    await run({ taskId: 'T1' });

    expect(dispatchFromCliMock).toHaveBeenCalledTimes(1);
    expect(dispatchRawMock).not.toHaveBeenCalled();
    expect(cliOutputMock).not.toHaveBeenCalled();
    const [, , op, params] = dispatchFromCliMock.mock.calls[0] as unknown[];
    expect(op).toBe('show');
    expect((params as Record<string, unknown>).taskId).toBe('T1');
  });
});

describe('gh#1207 — several ids are fetched in one process', () => {
  it('dispatches once per id and returns them in a single envelope', async () => {
    dispatchRawMock.mockImplementation((_g, _d, _o, p: { taskId: string }) =>
      Promise.resolve({ success: true, data: { id: p.taskId }, meta: {} }),
    );

    await run({ taskId: 'T1', _: ['T2', 'T3'] });

    expect(dispatchRawMock).toHaveBeenCalledTimes(3);
    expect(dispatchFromCliMock).not.toHaveBeenCalled();
    expect(cliOutputMock).toHaveBeenCalledTimes(1); // ONE envelope (ADR-086)

    const [payload] = cliOutputMock.mock.calls[0] as [Record<string, unknown>];
    expect(payload.count).toBe(3);
    expect(payload.requested).toBe(3);
    expect(payload.notFound).toEqual([]);
    expect(payload.tasks).toEqual([{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }]);
    expect(process.exitCode).toBe(0);
  });

  it('de-duplicates repeated ids and preserves order', async () => {
    dispatchRawMock.mockImplementation((_g, _d, _o, p: { taskId: string }) =>
      Promise.resolve({ success: true, data: { id: p.taskId }, meta: {} }),
    );

    await run({ taskId: 'T1', _: ['T1', 'T2', 'T1'] });

    expect(dispatchRawMock).toHaveBeenCalledTimes(2);
    const [payload] = cliOutputMock.mock.calls[0] as [Record<string, unknown>];
    expect(payload.tasks).toEqual([{ id: 'T1' }, { id: 'T2' }]);
  });
});

describe('gh#1207 — a partial batch must be loud, not silent', () => {
  it('returns the successes, records the failures, and exits non-zero', async () => {
    // One bad id must not discard the other N-1 results — that would make the
    // batch strictly worse than the loop it replaces. But a script must also
    // not read a partial batch as a complete one.
    dispatchRawMock.mockImplementation((_g, _d, _o, p: { taskId: string }) =>
      p.taskId === 'T2'
        ? Promise.resolve({
            success: false,
            error: { code: 'E_NOT_FOUND', message: 'nope' },
            meta: {},
          })
        : Promise.resolve({ success: true, data: { id: p.taskId }, meta: {} }),
    );

    await run({ taskId: 'T1', _: ['T2', 'T3'] });

    const [payload] = cliOutputMock.mock.calls[0] as [Record<string, unknown>];
    expect(payload.count).toBe(2);
    expect(payload.requested).toBe(3);
    expect(payload.tasks).toEqual([{ id: 'T1' }, { id: 'T3' }]);
    expect(payload.notFound).toEqual([{ taskId: 'T2', reason: 'nope' }]);
    expect(process.exitCode).toBe(1);
  });
});

describe('gh#1207 — flags are threaded to every id, not just the first', () => {
  it('passes history/ivtrHistory/relations on each dispatch', async () => {
    dispatchRawMock.mockResolvedValue({ success: true, data: {}, meta: {} });

    await run({ taskId: 'T1', _: ['T2'], history: true, relations: true });

    for (const call of dispatchRawMock.mock.calls) {
      const params = call[3] as Record<string, unknown>;
      expect(params.history).toBe(true);
      expect(params.relations).toBe(true);
      expect(params.ivtrHistory).toBe(false);
    }
  });

  it('ignores flag-shaped and empty positionals', async () => {
    dispatchRawMock.mockResolvedValue({ success: true, data: {}, meta: {} });

    await run({ taskId: 'T1', _: ['T2', '--verbose', '', '  '] });

    expect(dispatchRawMock).toHaveBeenCalledTimes(2);
  });
});
