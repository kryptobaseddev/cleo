/**
 * A grammar that did not load is reported once, with its package and fix, by
 * code search and by the analyze pipeline (T14665).
 *
 * `node:module` is mocked so `require('tree-sitter-typescript')` throws, the way
 * it does on a linux/arm64 install whose typescript grammar could not build.
 *
 * @task T14665
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  const createRequire = (url: string | URL): NodeJS.Require => {
    const real = actual.createRequire(url);
    const blocked = (id: string): unknown => {
      if (id === 'tree-sitter-typescript') throw new Error(`Cannot find module '${id}'`);
      return real(id);
    };
    return Object.assign(blocked, real);
  };
  return { ...actual, createRequire, default: { ...actual, createRequire } };
});

const { missingGrammarMessage, TREE_SITTER_GRAMMAR_FIX } = await import('../code/parser.js');
const { smartSearchReport } = await import('../code/search.js');
const { runPipeline } = await import('../pipeline/index.js');

let root: string;

function write(path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-missing-grammar-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('missing grammar reporting (T14665)', () => {
  it('code search names the missing grammar once and still searches other languages', () => {
    write('src/a.ts', 'export function alpha() {}');
    write('src/b.ts', 'export function alphabet() {}');
    write('src/c.py', 'def alpha_py():\n    pass\n');

    const { results, missingGrammars } = smartSearchReport('alpha', { rootDir: root });

    expect(missingGrammars).toEqual([
      {
        language: 'typescript',
        package: 'tree-sitter-typescript',
        fix: TREE_SITTER_GRAMMAR_FIX,
        message: missingGrammarMessage('typescript'),
      },
    ]);
    expect(results.map((r) => r.symbol.filePath)).toEqual(['src/c.py']);
  });

  it('analyze names the missing grammar, package and fix once, not once per file', async () => {
    write('src/a.ts', 'export const a = 1;');
    write('src/b.ts', 'export const b = 2;');
    write('src/c.ts', 'export const c = 3;');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const db = {
      insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }),
    };

    const publishGraph = vi.fn();
    const failure = await runPipeline(
      root,
      'proj',
      db,
      { nexusNodes: 'nodes', nexusRelations: 'relations' },
      undefined,
      { publishGraph },
    ).then(
      () => null,
      (error: Error) => error.message,
    );

    const message = missingGrammarMessage('typescript');
    expect(failure).not.toBeNull();
    expect(failure).toContain(`3 file(s) not parsed. ${message}`);
    expect(failure?.split(message)).toHaveLength(2);
    expect(failure).not.toContain('src/a.ts');
    expect(publishGraph).not.toHaveBeenCalled();
    const warnings = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes(message));
    expect(warnings).toEqual([`[nexus] WARNING: 3 file(s) not parsed. ${message}\n`]);
  });
});
