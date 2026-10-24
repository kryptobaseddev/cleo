/**
 * `cleo admin scaffold-hub` is deprecated (T13994, ADR-098): hidden from
 * `cleo admin --help`, it still runs and leaves a W_DEPRECATED_COMMAND
 * warning for the envelope.
 *
 * @task T13994
 */

import { drainWarnings } from '@cleocode/core/output';
import type { Warning } from '@cleocode/lafs';
import { renderUsage } from 'citty';
import { describe, expect, it, vi } from 'vitest';

/** Warnings pending when dispatch ran — what the real dispatch drains into meta.warnings. */
let warningsAtDispatch: Warning[] = [];
const mockDispatchFromCli = vi.fn().mockImplementation(async () => {
  warningsAtDispatch = drainWarnings() ?? [];
});

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

import { adminCommand } from '../admin.js';

/** Resolve `adminCommand.subCommands` (may be a function). */
async function getSubCommands(): Promise<Record<string, import('citty').CommandDef>> {
  const resolved =
    typeof adminCommand.subCommands === 'function'
      ? await adminCommand.subCommands()
      : adminCommand.subCommands;
  return (resolved ?? {}) as Record<string, import('citty').CommandDef>;
}

describe('cleo admin scaffold-hub is deprecated (T13994)', () => {
  it('is hidden from `cleo admin --help` but still registered', async () => {
    const usage = await renderUsage(adminCommand);
    expect(usage).not.toContain('scaffold-hub');
    expect(usage).toContain('install-global');
    expect(await getSubCommands()).toHaveProperty('scaffold-hub');
  });

  it('still dispatches and warns that it is deprecated', async () => {
    drainWarnings();
    warningsAtDispatch = [];
    const hub = (await getSubCommands())['scaffold-hub'];
    if (!hub) throw new Error('scaffold-hub is not registered');
    const resolved = typeof hub === 'function' ? await hub() : hub;
    const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
    if (!runFn) throw new Error('scaffold-hub has no run function');
    await runFn({ args: {}, rawArgs: [], cmd: resolved });
    expect(mockDispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'admin',
      'scaffold-hub',
      {},
      { command: 'admin' },
    );
    const warning = warningsAtDispatch.find((w) => w.code === 'W_DEPRECATED_COMMAND');
    expect(warning?.message).toContain('ADR-098');
  });
});
