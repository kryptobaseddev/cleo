/**
 * Regression tests for task CLI compatibility aliases.
 *
 * The task command surface is intentionally split across root commands, so
 * alias normalization lives in each owning command file rather than in a
 * central `commands/tasks.ts` router.
 *
 * @task T1472
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../add.js';
import { listCommand } from '../list.js';
import { updateCommand } from '../update.js';

const mocks = vi.hoisted(() => ({
  cliOutput: vi.fn(),
  dispatchFromCli: vi.fn(),
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
}));

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: mocks.dispatchFromCli,
  dispatchRaw: mocks.dispatchRaw,
  handleRawError: mocks.handleRawError,
}));

vi.mock('../../renderers/index.js', () => ({
  cliError: vi.fn(),
  cliOutput: mocks.cliOutput,
}));

vi.mock('@cleocode/core', () => ({
  createPage: vi.fn(),
  getProjectRoot: vi.fn(() => '/mock/project'),
  // T1490: add.ts now calls inferTaskAddParams from Core
  inferTaskAddParams: vi.fn().mockResolvedValue({}),
}));

async function invokeAdd(args: Record<string, string | boolean>): Promise<void> {
  const run = addCommand.run;
  if (!run) throw new Error('addCommand.run is missing');
  await run({ args, rawArgs: [] });
}

async function invokeUpdate(args: Record<string, string | boolean>): Promise<void> {
  const run = updateCommand.run;
  if (!run) throw new Error('updateCommand.run is missing');
  await run({ args, rawArgs: [] });
}

async function invokeList(args: Record<string, string | boolean>): Promise<void> {
  const run = listCommand.run;
  if (!run) throw new Error('listCommand.run is missing');
  await run({ args, rawArgs: [] });
}

describe('task CLI command alias normalization (T1472)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.dispatchRaw.mockResolvedValue({
      success: true,
      data: {
        duplicate: false,
        filtered: 1,
        task: { id: 'T200', title: 'Alias task' },
        tasks: [{ id: 'T200', title: 'Alias task' }],
      },
      page: { total: 1 },
    });

    mocks.dispatchFromCli.mockResolvedValue(undefined);
  });

  it('normalizes add aliases to canonical task params', async () => {
    await invokeAdd({
      title: 'Alias task',
      'parent-id': 'T100',
      kind: 'bug',
      note: 'legacy note',
    });

    expect(mocks.dispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        notes: 'legacy note',
        parent: 'T100',
        role: 'bug',
      }),
    );
  });

  it('prefers canonical add flags over legacy aliases', async () => {
    await invokeAdd({
      title: 'Alias task',
      parent: 'T100',
      'parent-id': 'T999',
      role: 'work',
      kind: 'bug',
      notes: 'canonical note',
      note: 'legacy note',
    });

    expect(mocks.dispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        notes: 'canonical note',
        parent: 'T100',
        role: 'work',
      }),
    );
  });

  it('normalizes update aliases to canonical task params', async () => {
    await invokeUpdate({
      taskId: 'T200',
      'parent-id': 'T100',
      kind: 'research',
      note: 'legacy note',
    });

    expect(mocks.dispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'update',
      expect.objectContaining({
        notes: 'legacy note',
        parent: 'T100',
        role: 'research',
        taskId: 'T200',
      }),
      { command: 'update' },
    );
  });

  it('--note alone (singular) is not dropped — maps to notes (T1472 BUG-CLI-NOTE)', async () => {
    // Regression: --note (singular) was silently dropped; only --notes (plural) worked.
    // The fix wires `note` as a CLI arg alias so it normalizes to params.notes before dispatch.
    await invokeUpdate({
      taskId: 'T201',
      note: 'singular note text',
    });

    expect(mocks.dispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'update',
      expect.objectContaining({
        notes: 'singular note text',
        taskId: 'T201',
      }),
      { command: 'update' },
    );
  });

  it('--notes takes precedence over --note when both are supplied', async () => {
    await invokeUpdate({
      taskId: 'T202',
      notes: 'canonical notes',
      note: 'should be ignored',
    });

    expect(mocks.dispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'update',
      expect.objectContaining({
        notes: 'canonical notes',
        taskId: 'T202',
      }),
      { command: 'update' },
    );
  });

  it('normalizes list --parent-id to parent', async () => {
    await invokeList({ 'parent-id': 'T100' });

    expect(mocks.dispatchRaw).toHaveBeenCalledWith(
      'query',
      'tasks',
      'list',
      expect.objectContaining({ parent: 'T100' }),
    );
  });
});
