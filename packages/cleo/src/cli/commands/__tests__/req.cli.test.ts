/** Argv-level routing checks for typed requirement commands (T12292). */
import { runCommand } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { reqCommand } from '../req.js';

vi.mock('../../../dispatch/adapters/cli.js', () => ({ dispatchFromCli: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('req argv routing', () => {
  it.each([
    ['migrate', 'T121'],
    ['migrate', 'T121', '--no-apply'],
  ])('keeps migration preview read-only for %j', async (...rawArgs) => {
    await runCommand(reqCommand, { rawArgs });
    expect(dispatchFromCli).toHaveBeenCalledExactlyOnceWith(
      'query',
      'tasks',
      'req.migrate.preview',
      { taskId: 'T121', apply: false },
      { command: 'req migrate' },
    );
  });

  it('requires the explicit apply flag for migration mutation', async () => {
    await runCommand(reqCommand, { rawArgs: ['migrate', 'T121', '--apply'] });
    expect(dispatchFromCli).toHaveBeenCalledExactlyOnceWith(
      'mutate',
      'tasks',
      'req.migrate',
      { taskId: 'T121', apply: true },
      { command: 'req migrate' },
    );
  });

  it('preserves the full gate JSON argument for canonical validation', async () => {
    const gate = JSON.stringify({
      kind: 'test',
      command: 'node',
      args: ['axiom-app/scripts/verify-partner-completion.mjs', '--task', 'T121'],
      expect: 'exit0',
      description: 'Verify partner criteria',
      req: 'PARTNER-121',
      timeoutMs: 1800000,
    });
    await runCommand(reqCommand, { rawArgs: ['add', 'T121', '--gate', gate] });
    expect(dispatchFromCli).toHaveBeenCalledExactlyOnceWith(
      'mutate',
      'tasks',
      'req.add',
      { taskId: 'T121', gate },
      { command: 'req add' },
    );
  });

  it('lists requirements through the read route', async () => {
    await runCommand(reqCommand, { rawArgs: ['list', 'T121'] });
    expect(dispatchFromCli).toHaveBeenCalledExactlyOnceWith(
      'query',
      'tasks',
      'req.list',
      { taskId: 'T121' },
      { command: 'req list' },
    );
  });

  it('rejects missing required gate arguments before dispatch', async () => {
    await expect(runCommand(reqCommand, { rawArgs: ['add', 'T121'] })).rejects.toThrow();
    expect(dispatchFromCli).not.toHaveBeenCalled();
  });
});
