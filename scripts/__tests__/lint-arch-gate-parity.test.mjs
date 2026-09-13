/**
 * Tests for scripts/lint-arch-gate-parity.mjs — the gate on the gates (T12122).
 *
 * The live repo assertion is the important one: it is what would have caught
 * the 10-vs-15 drift the day it appeared. The parser tests pin the behaviour
 * that makes it trustworthy — table scoping, `--strict` stripping, and
 * matching on script path rather than gate number.
 *
 * @task T12122
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledScripts, documentedScripts } from '../lint-arch-gate-parity.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('lint-arch-gate-parity — live repo', () => {
  it('every gate bundled in `cleo check arch` is documented in AGENTS.md', () => {
    const bundled = bundledScripts(
      readFileSync(join(REPO_ROOT, 'packages/cleo/src/cli/commands/check.ts'), 'utf-8'),
    );
    const documented = documentedScripts(readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf-8'));

    const undocumented = [...bundled].filter((s) => !documented.has(s)).sort();
    expect(undocumented).toEqual([]);
  });

  it('every gate documented in AGENTS.md is bundled in `cleo check arch`', () => {
    // This is the direction that produced the false green: 9 documented gates
    // the runner never ran, while reporting "10 passed, 0 failed".
    const bundled = bundledScripts(
      readFileSync(join(REPO_ROOT, 'packages/cleo/src/cli/commands/check.ts'), 'utf-8'),
    );
    const documented = documentedScripts(readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf-8'));

    const unbundled = [...documented].filter((s) => !bundled.has(s)).sort();
    expect(unbundled).toEqual([]);
  });

  it('finds a non-trivial number of gates (guards against a parser that matches nothing)', () => {
    // A regex that silently stopped matching would make both assertions above
    // pass vacuously — the exact failure mode this gate exists to prevent.
    const bundled = bundledScripts(
      readFileSync(join(REPO_ROOT, 'packages/cleo/src/cli/commands/check.ts'), 'utf-8'),
    );
    expect(bundled.size).toBeGreaterThanOrEqual(15);
  });
});

describe('bundledScripts', () => {
  it('extracts each gate script path from the gates array', () => {
    const source = `
      const gates = [
        { id: 'gate-1', script: 'scripts/lint-a.mjs', description: 'a' },
        { id: 'gate-2', script: 'scripts/lint-b.mjs', description: 'b' },
      ] as const;`;
    expect([...bundledScripts(source)].sort()).toEqual([
      'scripts/lint-a.mjs',
      'scripts/lint-b.mjs',
    ]);
  });

  it('ignores script paths that are not a gate `script:` field', () => {
    const source = `// see scripts/lint-unrelated.mjs for details
      { id: 'gate-1', script: 'scripts/lint-a.mjs' },`;
    expect([...bundledScripts(source)]).toEqual(['scripts/lint-a.mjs']);
  });
});

describe('documentedScripts', () => {
  const table = [
    '## SSoT & Architectural Gates (Saga T9831)',
    '',
    '| # | Gate | Script | Baseline | Rule |',
    '|---|------|--------|----------|------|',
    '| 1 | A | `scripts/lint-a.mjs` | inline | rule a |',
    '| 2 | B | `scripts/lint-b.mjs --strict` | inline | rule b |',
    '',
    '## Some Other Section',
    '',
    '| 1 | X | `scripts/lint-not-a-gate.mjs` | inline | nope |',
  ].join('\n');

  it('reads the gate table and stops at the next heading', () => {
    expect([...documentedScripts(table)].sort()).toEqual([
      'scripts/lint-a.mjs',
      'scripts/lint-b.mjs',
    ]);
  });

  it('strips a trailing --strict so the table and the runner compare equal', () => {
    // The table documents the invocation; the runner supplies the mode flag.
    expect(documentedScripts(table).has('scripts/lint-b.mjs')).toBe(true);
  });

  it('throws rather than silently reporting zero gates when the heading moves', () => {
    // Returning an empty set here would make the parity check pass vacuously.
    expect(() => documentedScripts('# no gate table here')).toThrow(
      /could not find the "## SSoT & Architectural Gates" heading/,
    );
  });
});
