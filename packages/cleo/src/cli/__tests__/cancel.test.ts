/**
 * Tests for the `cleo cancel` CLI command.
 *
 * Asserts:
 *   - Command surface (name, description, taskId positional, --reason flag)
 *   - Dispatch call routes to `mutate` / `tasks` / `cancel` with the args
 *     supplied by the user (taskId + reason).
 *
 * @task T9838
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchFromCli } = vi.hoisted(() => ({
  dispatchFromCli: vi.fn(async () => undefined),
}));

vi.mock('../../dispatch/adapters/cli.js', () => ({ dispatchFromCli }));

import { cancelCommand } from '../commands/cancel.js';

describe('cancelCommand (CLI surface)', () => {
  beforeEach(() => {
    dispatchFromCli.mockClear();
  });

  it('exports a command named "cancel"', () => {
    expect(cancelCommand).toBeDefined();
    const meta =
      typeof cancelCommand.meta === 'function' ? cancelCommand.meta() : cancelCommand.meta;
    expect((meta as { name: string }).name).toBe('cancel');
  });

  it('has a description mentioning the soft terminal state', () => {
    const meta =
      typeof cancelCommand.meta === 'function' ? cancelCommand.meta() : cancelCommand.meta;
    expect((meta as { description: string }).description).toMatch(/cancel/i);
    expect((meta as { description: string }).description).toMatch(/soft|reversible|restore/i);
  });

  it('declares a required `taskId` positional and an optional `reason` flag', () => {
    const args = cancelCommand.args as Record<
      string,
      { type: string; required?: boolean; description?: string }
    >;
    expect(args).toBeDefined();
    expect(args.taskId).toBeDefined();
    expect(args.taskId.type).toBe('positional');
    expect(args.taskId.required).toBe(true);
    expect(args.reason).toBeDefined();
    expect(args.reason.type).toBe('string');
    // reason is intentionally OPTIONAL.
    expect(args.reason.required).not.toBe(true);
  });

  it('dispatches to mutate/tasks/cancel with the supplied taskId', async () => {
    const runner = cancelCommand.run as (ctx: {
      args: { taskId: string; reason?: string };
    }) => Promise<void>;
    await runner({ args: { taskId: 'T0001' } });

    expect(dispatchFromCli).toHaveBeenCalledTimes(1);
    const call = dispatchFromCli.mock.calls[0];
    expect(call[0]).toBe('mutate');
    expect(call[1]).toBe('tasks');
    expect(call[2]).toBe('cancel');
    expect(call[3]).toEqual({ taskId: 'T0001', reason: undefined });
  });

  it('passes --reason through to the dispatcher', async () => {
    const runner = cancelCommand.run as (ctx: {
      args: { taskId: string; reason?: string };
    }) => Promise<void>;
    await runner({ args: { taskId: 'T0002', reason: 'Superseded by T0003' } });

    expect(dispatchFromCli).toHaveBeenCalledTimes(1);
    const call = dispatchFromCli.mock.calls[0];
    expect(call[3]).toEqual({ taskId: 'T0002', reason: 'Superseded by T0003' });
  });
});
