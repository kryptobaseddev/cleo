/**
 * `cleo docs update <slug> --content -` reads the body from stdin — T13564.
 *
 * `docs add` documented `--content -` as stdin (T10965), but `docs update`
 * passed the literal `-` through and replaced a canonical doc with one
 * character. Dispatch is mocked; stdin is a piped stream.
 *
 * @task T13564
 */

import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockDispatchFromCli = vi.fn(async () => undefined);

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliError: vi.fn(),
  cliOutput: vi.fn(),
  humanInfo: vi.fn(),
}));

const { docsCommand } = await import('../docs.js');

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

afterEach(() => {
  vi.restoreAllMocks();
  mockDispatchFromCli.mockClear();
});

describe('cleo docs update --content - (T13564)', () => {
  it('stores the piped stdin body, not a literal "-"', async () => {
    const body = '# Spec\n\nPiped body.';
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([`${body}\n`]),
      configurable: true,
    });
    try {
      const run = (docsCommand.subCommands as Record<string, { run: RunFn }>)['update']!.run;
      await run({
        args: { slug: 'my-spec', content: '-' },
        rawArgs: ['my-spec', '--content', '-'],
      });
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    }
    expect(mockDispatchFromCli).toHaveBeenCalledWith(
      'mutate',
      'docs',
      'update',
      { slug: 'my-spec', content: body },
      { command: 'docs update' },
    );
  });
});
