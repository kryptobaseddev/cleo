/**
 * `splitCommandLine` follows POSIX `sh` word splitting and refuses what only a
 * shell would interpret (T12718 review).
 *
 * @task T12718
 */

import { describe, expect, it } from 'vitest';
import { joinCommandLine, splitCommandLine } from '../command-line.js';

const SHELL_HINT = /without a shell.*sh -c '<script>'.*script file/;

describe('splitCommandLine (T12718)', () => {
  it('honours quotes and escapes', () => {
    expect(splitCommandLine(`node -e "setTimeout(()=>process.exit(1),3000)"`)).toEqual([
      'node',
      '-e',
      'setTimeout(()=>process.exit(1),3000)',
    ]);
    expect(splitCommandLine(`a 'b c' d\\ e`)).toEqual(['a', 'b c', 'd e']);
  });

  it('drops a backslash-newline inside double quotes, as sh does', () => {
    expect(splitCommandLine('node -e "process.\\\nexit(0)"')).toEqual([
      'node',
      '-e',
      'process.exit(0)',
    ]);
  });

  it('refuses a # comment at the start of a word', () => {
    expect(() => splitCommandLine('vitest run # only the fast suite')).toThrow(SHELL_HINT);
    expect(() => splitCommandLine('vitest run # only the fast suite')).toThrow(/comment/);
    // Mid-word and quoted `#` are literal in sh.
    expect(splitCommandLine(`grep a#b '#x'`)).toEqual(['grep', 'a#b', '#x']);
  });

  it('refuses ~ tilde expansion at the start of a word', () => {
    expect(() => splitCommandLine('node ~/scripts/check.mjs')).toThrow(SHELL_HINT);
    expect(() => splitCommandLine('node ~/scripts/check.mjs')).toThrow(/tilde/);
    expect(splitCommandLine(`node a~b '~/x'`)).toEqual(['node', 'a~b', '~/x']);
  });

  it('refuses a leading NAME=value environment assignment', () => {
    expect(() => splitCommandLine('CI=1 pnpm test')).toThrow(SHELL_HINT);
    expect(() => splitCommandLine('CI=1 pnpm test')).toThrow(/CI= environment assignment/);
    // Not an assignment in sh: a quoted name, a non-leading word, an invalid name.
    expect(splitCommandLine(`"CI"=1 x`)).toEqual(['CI=1', 'x']);
    expect(splitCommandLine('node --flag=value')).toEqual(['node', '--flag=value']);
    expect(splitCommandLine('1A=2 x')).toEqual(['1A=2', 'x']);
  });

  it('joinCommandLine re-quotes words so splitting round-trips', () => {
    const words = ['vitest', 'run', '-t', "it's a test", '--flag=value', '*.ts'];
    const line = joinCommandLine(words);
    expect(line).toBe(`vitest run -t 'it'\\''s a test' --flag=value '*.ts'`);
    expect(splitCommandLine(line)).toEqual(words);
  });

  it('joinCommandLine leaves only a placeholder bare; a word a shell would brace-expand is quoted (T13125)', () => {
    expect(joinCommandLine(['pnpm', '{filters}', 'run', 'test'])).toBe('pnpm {filters} run test');
    expect(splitCommandLine('pnpm {filters} run test')).toEqual([
      'pnpm',
      '{filters}',
      'run',
      'test',
    ]);
    // Rendered into a workflow `run:` step, bash would expand these into
    // several words: they must stay quoted (review of #1818).
    expect(joinCommandLine(['prettier', '--check', 'src/{a,b}'])).toBe(
      "prettier --check 'src/{a,b}'",
    );
    expect(joinCommandLine(['echo', '{1..3}'])).toBe("echo '{1..3}'");
  });
});
