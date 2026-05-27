/**
 * Tests for the `cleo cancel` CLI command.
 *
 * Asserts:
 *   - Command surface (name, description, taskId positional, --reason flag)
 *   - Dispatch call routes to `mutate` / `tasks` / `cancel` with the args
 *     supplied by the user (taskId + reason).
 *   - **T9947 regression lock**: the `cancel` verb appears in
 *     `COMMAND_MANIFEST` with the correct `exportName`, `name`,
 *     `description`, and a `load()` function that resolves to the same
 *     `cancelCommand` binding exported here. Pre-T9947 ship the help
 *     generator surfaced `cancel` while the dispatch registry was missing
 *     the entry, so invoking `cleo cancel <id>` returned `E_NOT_FOUND`
 *     despite the `--help` text advertising it.
 *
 * @task T9838
 * @task T9947
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchFromCli } = vi.hoisted(() => ({
  dispatchFromCli: vi.fn(async () => undefined),
}));

vi.mock('../../dispatch/adapters/cli.js', () => ({ dispatchFromCli }));

import { cancelCommand } from '../commands/cancel.js';
import { COMMAND_MANIFEST } from '../generated/command-manifest.js';

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

describe('cancel verb is registered in COMMAND_MANIFEST (T9947 regression lock)', () => {
  /**
   * Pre-T9947 bug: the CLI help generator listed `cancel` under Task
   * Management, but the `cleo` root subCommand registry never received a
   * loader for it. Invoking `cleo cancel <id>` therefore exited with
   * `E_NOT_FOUND`. This test asserts the manifest entry exists with the
   * correct shape AND that its `load()` resolves to the same module export
   * the rest of the CLI imports — making divergence impossible.
   */
  it('exposes a manifest entry with name="cancel"', () => {
    const entry = COMMAND_MANIFEST.find((e) => e.name === 'cancel');
    expect(entry).toBeDefined();
    expect(entry?.exportName).toBe('cancelCommand');
    expect(entry?.description).toMatch(/cancel/i);
    expect(entry?.description).toMatch(/soft|reversible|restore/i);
  });

  it('manifest load() resolves to the same cancelCommand export', async () => {
    const entry = COMMAND_MANIFEST.find((e) => e.name === 'cancel');
    expect(entry).toBeDefined();
    const loaded = await entry!.load();
    // Reference identity: the manifest must load EXACTLY the binding the
    // dispatch registry would otherwise miss.
    expect(loaded).toBe(cancelCommand);
  });
});
