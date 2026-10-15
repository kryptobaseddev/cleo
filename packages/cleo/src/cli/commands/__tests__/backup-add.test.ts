/**
 * Unit tests for `cleo backup add` (T13724: `--note` exposure).
 *
 * Verifies the `backup add` subcommand run handler in backup.ts:
 *   - `--note <text>` reaches the dispatch params as `note`
 *   - without `--note`, a `--destination` still produces the legacy
 *     `destination:<dir>` note
 *   - `--global` keeps passing `includeGlobal: true`
 *
 * dispatchFromCli is mocked — no store or backup is touched. Pattern mirrors
 * backup-export.test.ts.
 *
 * @task T13724
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { backupCommand } from '../backup.js';

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
}));

type AddArgs = {
  destination?: string;
  note?: string;
  global?: boolean;
};

/**
 * Invoke the citty `backup add` subcommand's run handler with the given args.
 *
 * @param args - Arguments to pass to the add run handler.
 */
async function runAdd(args: AddArgs): Promise<void> {
  const addCmd = backupCommand.subCommands?.['add'];
  if (!addCmd || typeof addCmd !== 'object' || !('run' in addCmd)) {
    throw new Error('backup add subcommand not found');
  }
  const merged = { destination: undefined, note: undefined, global: false, ...args };
  await (addCmd as { run: (ctx: { args: typeof merged }) => Promise<void> }).run({ args: merged });
}

describe('T13724 cleo backup add — --note', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes --note through to the dispatch params', async () => {
    await runAdd({ note: 'before store surgery' });

    expect(dispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'admin',
      'backup',
      {
        type: 'snapshot',
        note: 'before store surgery',
        includeGlobal: false,
      },
      { command: 'backup' },
    );
  });

  it('keeps the legacy destination note when --note is absent', async () => {
    await runAdd({ destination: '/mnt/backups' });

    expect(dispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'admin',
      'backup',
      {
        type: 'snapshot',
        note: 'destination:/mnt/backups',
        includeGlobal: false,
      },
      { command: 'backup' },
    );
  });

  it('lets --note win over --destination and keeps --global', async () => {
    await runAdd({ note: 'nightly', destination: '/mnt/backups', global: true });

    expect(dispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'admin',
      'backup',
      {
        type: 'snapshot',
        note: 'nightly',
        includeGlobal: true,
      },
      { command: 'backup' },
    );
  });
});
