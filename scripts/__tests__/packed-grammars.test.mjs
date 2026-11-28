/** T14665: each grammar parses, or a toolchain-free install reports it with its fix. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containerCommand, GRAMMAR_SAMPLES, judgeGrammarOutline } from '../lib/packed-grammars.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'packed-grammars-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('grammar outcomes without a toolchain (T14665)', () => {
  it('parses every grammar sample with the installed grammars', async () => {
    const { smartOutline } = await import('../../packages/nexus/src/code/outline.ts');
    for (const [language, name, , source, symbol] of GRAMMAR_SAMPLES) {
      const file = join(root, name);
      writeFileSync(file, source);
      const outline = smartOutline(file, root);
      expect(outline.errors, language).toEqual([]);
      const names = outline.symbols.flatMap((sym) => [
        sym.name,
        ...sym.children.map((c) => c.name),
      ]);
      expect(names, language).toContain(symbol);
    }
  });

  it('accepts a missing grammar only when the toolchain-free report names it and its fix', async () => {
    const { missingGrammarMessage } = await import('../../packages/nexus/src/code/parser.ts');
    const cpp = GRAMMAR_SAMPLES.find(([language]) => language === 'cpp');
    const reported = { ok: false, output: `Error: ${missingGrammarMessage('cpp')} (1)` };
    expect(judgeGrammarOutline(cpp, reported, { installed: false, toolchainFree: true })).toBe(
      'reported-missing',
    );
    expect(() =>
      judgeGrammarOutline(cpp, reported, { installed: false, toolchainFree: false }),
    ).toThrow('is installed');
    expect(() =>
      judgeGrammarOutline(cpp, reported, { installed: true, toolchainFree: true }),
    ).toThrow('is installed');
    expect(() =>
      judgeGrammarOutline(
        cpp,
        { ok: false, output: 'Error: boom' },
        { installed: false, toolchainFree: true },
      ),
    ).toThrow('without naming tree-sitter-cpp');
    expect(() =>
      judgeGrammarOutline(
        cpp,
        { ok: true, output: 'sample.cpp (cpp)' },
        { installed: true, toolchainFree: false },
      ),
    ).toThrow('did not report');
  });

  it('runs a command in the image with the evidence root mounted and PATH left to the image', () => {
    const argv = containerCommand('node:24-slim', process.execPath, ['-e', '1'], {
      cwd: '/evidence/app',
      env: { PATH: '/host/bin', HOME: '/evidence/home' },
      mount: '/evidence',
    });
    expect(argv).toContain('/evidence:/evidence');
    expect(argv).toContain('HOME=/evidence/home');
    expect(argv.some((arg) => arg.startsWith('PATH='))).toBe(false);
    expect(argv.slice(argv.indexOf('node:24-slim'))).toEqual(['node:24-slim', 'node', '-e', '1']);
  });
});
