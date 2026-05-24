/**
 * Tests that `cleo labels <name>` (positional) routes to `tasks.list` with
 * a label filter (T9904 — closes GH#393).
 *
 * The bare `cleo labels` must keep dispatching to `tasks.label.list`
 * (backward compatible). Subcommands `list|show|stats` continue to
 * dispatch as before.
 *
 * @task T9904
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchFromCli = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

import { labelsCommand } from '../labels.js';

type RunCtx = Parameters<NonNullable<typeof labelsCommand.run>>[0];

describe('cleo labels — positional + dispatch routing (T9904)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('declares an optional positional `name` arg', () => {
    expect(labelsCommand.args).toBeDefined();
    const args = labelsCommand.args as Record<
      string,
      { type: string; required?: boolean; description?: string }
    >;
    expect(args['name']).toBeDefined();
    expect(args['name']!.type).toBe('positional');
    expect(args['name']!.required).toBe(false);
  });

  it('routes `cleo labels` (no args) to tasks.label.list', async () => {
    await labelsCommand.run!({
      args: { _: [] } as unknown as Record<string, unknown>,
      rawArgs: [],
      cmd: labelsCommand,
    } as unknown as RunCtx);

    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('query');
    expect(call[1]).toBe('tasks');
    expect(call[2]).toBe('label.list');
    expect(call[3]).toEqual({});
  });

  it('routes `cleo labels <name>` to tasks.list with label filter', async () => {
    await labelsCommand.run!({
      args: { name: 'bug', _: [] } as unknown as Record<string, unknown>,
      rawArgs: ['bug'],
      cmd: labelsCommand,
    } as unknown as RunCtx);

    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('query');
    expect(call[1]).toBe('tasks');
    expect(call[2]).toBe('list');
    expect(call[3]).toEqual({ label: 'bug' });
  });

  it('does NOT dispatch from root when subcommand (list/show/stats) was invoked', async () => {
    await labelsCommand.run!({
      args: { _: ['list'] } as unknown as Record<string, unknown>,
      rawArgs: ['list'],
      cmd: labelsCommand,
    } as unknown as RunCtx);

    // Citty dispatches the subcommand on its own — the root run must NOT
    // double-dispatch.
    expect(mockDispatchFromCli).not.toHaveBeenCalled();
  });
});
