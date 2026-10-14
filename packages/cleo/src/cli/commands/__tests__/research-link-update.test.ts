/**
 * `cleo research link` and `cleo research update` send only the fields they
 * name through `pipeline.manifest.update`, never a replacement entry through
 * `manifest.append` (T13678: a link replaced the entry's title, topics, 15
 * key findings and links).
 *
 * @task T13678
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { researchCommand } from '../research.js';

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: vi.fn().mockResolvedValue(undefined),
}));

async function run(name: 'link' | 'update', args: Record<string, unknown>): Promise<void> {
  const sub = researchCommand.subCommands?.[name];
  if (!sub || typeof sub !== 'object' || !('run' in sub))
    throw new Error(`research ${name} not found`);
  await (sub as { run: (ctx: { args: typeof args; rawArgs: string[] }) => Promise<void> }).run({
    args,
    rawArgs: [],
  });
}

describe('research link/update (T13678)', () => {
  beforeEach(() => vi.mocked(dispatchFromCli).mockClear());

  it('link sends only the id and the task to add', async () => {
    await run('link', { researchId: 'res_1791930862719', taskId: 'T1981' });
    expect(dispatchFromCli).toHaveBeenCalledOnce();
    expect(vi.mocked(dispatchFromCli).mock.calls[0]?.slice(0, 4)).toEqual([
      'mutate',
      'pipeline',
      'manifest.update',
      { id: 'res_1791930862719', linkTask: 'T1981' },
    ]);
  });

  it('update sends only the flags given', async () => {
    await run('update', { id: 'res_1', status: 'completed' });
    expect(vi.mocked(dispatchFromCli).mock.calls[0]?.slice(2, 4)).toEqual([
      'manifest.update',
      { id: 'res_1', status: 'completed' },
    ]);
    await run('update', { id: 'res_1', findings: 'a, b', topic: 'Sync' });
    expect(vi.mocked(dispatchFromCli).mock.calls[1]?.[3]).toEqual({
      id: 'res_1',
      key_findings: ['a', 'b'],
      title: 'Sync',
      topics: ['Sync'],
    });
  });
});
