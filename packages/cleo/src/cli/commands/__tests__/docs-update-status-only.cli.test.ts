/**
 * `cleo docs update <slug> --status <s>` with no --file/--content — T12654.
 *
 * The CLI guard refused any update without `--file` or `--content`
 * ("provide --file <path> OR --content <text>"), although `--help` lists
 * every lifecycle status for `--status`. So `cleo docs update <spec> --status
 * accepted` could not work, and specs stayed at draft/proposed.
 *
 * Every status is read from the command's own help text — the text `--help`
 * prints — so an advertised status the command refuses cannot pass again.
 * Dispatch and renderers are mocked; the fast path for the quarantined E2E
 * suite (`docs-update.test.ts` cases k/l).
 *
 * @task T12654
 */

import { DOCS_LIFECYCLE_STATUSES } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchFromCli = vi.fn(async () => undefined);
const mockCliError = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliError: (...args: unknown[]) => mockCliError(...args),
  cliOutput: vi.fn(),
  humanInfo: vi.fn(),
}));

const { docsCommand } = await import('../docs.js');

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

/** The `docs update` subcommand: its help text and run handler. */
function updateSubcommand(): { help: string; run: RunFn } {
  const sub = (docsCommand.subCommands as Record<string, unknown> | undefined)?.['update'] as
    | { meta?: { description?: string }; run?: RunFn }
    | undefined;
  if (!sub?.run || typeof sub.meta?.description !== 'string') {
    throw new Error('docs update subcommand not found');
  }
  return { help: sub.meta.description, run: sub.run };
}

/** Statuses the `--status` line of the help text advertises. */
function advertisedStatuses(help: string): string[] {
  const line = help.split('\n').find((l) => /--status <string>/.test(l)) ?? '';
  return /\(([a-z|]+)\)\s*$/.exec(line)?.[1]?.split('|') ?? [];
}

beforeEach(() => {
  mockDispatchFromCli.mockClear();
  mockCliError.mockClear();
});

describe('cleo docs update --status alone (T12654)', () => {
  it('help advertises exactly the lifecycle statuses', () => {
    expect(advertisedStatuses(updateSubcommand().help)).toEqual([...DOCS_LIFECYCLE_STATUSES]);
  });

  it.each([
    ...DOCS_LIFECYCLE_STATUSES,
  ])('--status %s alone reaches dispatch as a lifecycle-only update', async (status) => {
    const { help, run } = updateSubcommand();
    expect(advertisedStatuses(help)).toContain(status);
    await run({ args: { slug: 'my-spec', status }, rawArgs: ['my-spec', '--status', status] });
    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'docs',
      'update',
      { slug: 'my-spec', status },
      { command: 'docs update' },
    );
  });

  it('still rejects an update with no --file, --content or --status', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await expect(
        updateSubcommand().run({ args: { slug: 'my-spec' }, rawArgs: ['my-spec'] }),
      ).rejects.toThrow('process.exit');
      expect(mockCliError.mock.calls[0]?.[0]).toMatch(/--status <status> alone/);
      expect(exit).toHaveBeenCalledWith(6);
      expect(mockDispatchFromCli).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
