/**
 * Focused CLI wiring tests for `cleo worktree adopt --recover` (T10457).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchFromCli = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: vi.fn(() => '/repo'),
  listWorktrees: vi.fn(),
}));

import { worktreeCommand } from '../worktree.js';

async function getSubCommands(): Promise<Record<string, import('citty').CommandDef>> {
  const resolved =
    typeof worktreeCommand.subCommands === 'function'
      ? await worktreeCommand.subCommands()
      : worktreeCommand.subCommands;
  return (resolved ?? {}) as Record<string, import('citty').CommandDef>;
}

async function invokeSubCommand(name: string, args: Record<string, unknown>): Promise<void> {
  const subCommands = await getSubCommands();
  const cmd = subCommands[name];
  if (!cmd) throw new Error(`Subcommand ${name} not found`);
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const run = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!run) throw new Error(`Subcommand ${name} has no run function`);
  await run({ args, rawArgs: [], cmd: resolved });
}

describe('worktree adopt CLI recovery wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes recover=true to the worktree adopt dispatch operation', async () => {
    await invokeSubCommand('adopt', {
      path: '.claude/worktrees/session-abc',
      source: 'claude-agent',
      'task-id': 'T10457',
      actor: 'test-worker',
      recover: true,
    });

    expect(mockDispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'worktree',
      'adopt',
      {
        worktreePath: '.claude/worktrees/session-abc',
        source: 'claude-agent',
        taskId: 'T10457',
        actor: 'test-worker',
        recover: true,
      },
      { command: 'worktree-adopt', operation: 'worktree.adopt' },
    );
  });
});
