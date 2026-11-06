/**
 * Gate 42 (T14299): every refusal on the close, cancel, verify, done, review
 * and docs-link paths carries a runnable fix, and the pinned count only falls.
 *
 * @task T14299
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  judgeRefusalFixes,
  offendingRefusals,
  PINNED,
  REFUSAL_PATHS,
} from '../lint-refusal-fixes.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A fixture file under a scratch root, judged as one refusal path. */
function judge(source, check = () => [], functions) {
  const root = mkdtempSync(path.join(tmpdir(), 'refusal-fixes-'));
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/x.ts'), source);
    return offendingRefusals(
      root,
      { path: 'test', file: 'src/x.ts', ...(functions ? { functions } : {}) },
      check,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('lint-refusal-fixes (gate 42, T14299)', () => {
  it('the repository is at its pins, and every pin is zero', () => {
    expect(judgeRefusalFixes(REPO_ROOT).failures).toEqual([]);
    expect(judgeRefusalFixes(REPO_ROOT, true).failures).toEqual([]);
    expect(Object.values(PINNED).every((n) => n === 0)).toBe(true);
    for (const entry of REFUSAL_PATHS) expect(PINNED[entry.file], entry.file).toBeDefined();
  });

  it('counts a CleoError, engineError or lafsError with no fix, and accepts one with a fix', () => {
    const offending = judge(
      [
        "throw new CleoError(4, 'gone');",
        "return engineError('E_X', 'bad');",
        "return lafsError('E_X', 'bad', 'op');",
        "throw new CleoError(4, 'gone', { fix: 'cleo show T1' });",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, a template literal in the judged file
        "return engineError('E_X', 'bad', { details: {}, fix: `cleo show ${id}` });",
        "return lafsError('E_X', 'bad', 'op', 'cleo show T1');",
      ].join('\n'),
    );
    expect(offending.map((o) => o.line)).toEqual([1, 2, 3]);
  });

  it('counts a fix naming a command the CLI rejects', () => {
    const offending = judge(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, a template literal in the judged file
      "throw new CleoError(4, 'gone', { fix: `cleo nope ${id}` });",
      (text) => (text.includes('cleo nope') ? ['no such command: cleo nope'] : []),
    );
    expect(offending).toEqual([
      { file: 'src/x.ts', line: 1, reason: 'fix does not run: no such command: cleo nope' },
    ]);
  });

  it('judges only the named functions of a scoped path, object-property handlers included', () => {
    const source = [
      "function outside() { return engineError('E_X', 'bad'); }",
      "function inside() { return engineError('E_X', 'bad'); }",
      "const h = { 'link-decision': async () => engineError('E_X', 'bad') };",
    ].join('\n');
    expect(judge(source, () => [], ['inside', 'link-decision']).map((o) => o.line)).toEqual([2, 3]);
  });
});
