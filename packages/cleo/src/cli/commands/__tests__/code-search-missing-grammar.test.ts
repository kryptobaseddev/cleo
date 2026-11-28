/**
 * `cleo code search` names every grammar that did not load, with its package
 * and fix, instead of returning an empty result that reads as "no match"
 * (T14665).
 *
 * @task T14665
 */

import { drainWarnings } from '@cleocode/core/output';
import type { Warning } from '@cleocode/lafs';
import type { MissingGrammarReport } from '@cleocode/nexus';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gap: MissingGrammarReport = {
  language: 'typescript',
  package: 'tree-sitter-typescript',
  fix: 'install a C++ toolchain, then reinstall: npm install -g @cleocode/cleo',
  message: 'Grammar tree-sitter-typescript (typescript) did not load on linux/arm64. Fix: …',
};

vi.mock('@cleocode/core/internal', () => ({
  isTreeSitterAvailable: () => true,
  smartSearchReport: () => ({ results: [], missingGrammars: [gap] }),
}));

/** Warnings pending when the envelope was written — what it carries in meta.warnings. */
let warningsAtOutput: Warning[] = [];
const cliOutput = vi.fn().mockImplementation(() => {
  warningsAtOutput = drainWarnings() ?? [];
});
const humanWarn = vi.fn();

vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  cliOutput: (...args: unknown[]) => cliOutput(...args),
  humanWarn: (message: string) => humanWarn(message),
}));

const { setFormatContext } = await import('../../format-context.js');
const { codeCommand } = await import('../code.js');

async function runSearch(): Promise<void> {
  const search = codeCommand.subCommands?.search;
  const resolved = typeof search === 'function' ? await search() : search;
  const run = (resolved as { run?: (ctx: unknown) => Promise<void> } | undefined)?.run;
  if (!run) throw new Error('code search has no run function');
  await run({ args: { query: 'parseFile' }, rawArgs: [], cmd: resolved });
}

afterEach(() => {
  setFormatContext({ format: 'json', source: 'default', quiet: false });
  vi.clearAllMocks();
  drainWarnings();
});

describe('cleo code search reports missing grammars (T14665)', () => {
  it('puts one W_GRAMMAR_MISSING warning per grammar in the JSON envelope', async () => {
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    await runSearch();

    expect(cliOutput).toHaveBeenCalledWith(
      { query: 'parseFile', results: [] },
      { command: 'code', operation: 'code.search' },
    );
    expect(warningsAtOutput).toEqual([
      {
        code: 'W_GRAMMAR_MISSING',
        message: `typescript files were not searched. ${gap.message}`,
        severity: 'warn',
        context: { language: 'typescript', package: 'tree-sitter-typescript', fix: gap.fix },
      },
    ]);
  });

  it('warns a person on stderr in human mode', async () => {
    setFormatContext({ format: 'human', source: 'flag', quiet: false });
    await runSearch();

    expect(cliOutput).not.toHaveBeenCalled();
    expect(humanWarn).toHaveBeenCalledWith(
      `warning: typescript files were not searched. ${gap.message}`,
    );
  });
});
