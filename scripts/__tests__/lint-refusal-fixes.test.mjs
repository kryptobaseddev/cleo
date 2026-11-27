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
  refusalChecker,
} from '../lint-refusal-fixes.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A fixture file under a scratch root, judged as one refusal path. */
function judge(source, check = () => [], functions, results) {
  const root = mkdtempSync(path.join(tmpdir(), 'refusal-fixes-'));
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/x.ts'), source);
    return offendingRefusals(
      root,
      {
        path: 'test',
        file: 'src/x.ts',
        ...(functions ? { functions } : {}),
        ...(results ? { results } : {}),
      },
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
    expect(
      REFUSAL_PATHS.find((entry) => entry.file === 'packages/cleo/src/dispatch/domains/check.ts')
        ?.functions,
    ).toContain('gate.run');
    // T14663: `cleo docs update` is covered at dispatch and in core.
    expect(
      REFUSAL_PATHS.some(
        (entry) =>
          entry.file === 'packages/cleo/src/dispatch/domains/docs.ts' &&
          entry.functions?.includes('update'),
      ),
    ).toBe(true);
    expect(
      REFUSAL_PATHS.find((entry) => entry.file === 'packages/core/src/docs/docs-update.ts')
        ?.results,
    ).toBe(true);
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

  it('checks a fix named by a local const through its literal', () => {
    const offending = judge(
      [
        "const fix = 'cleo nope T1';",
        "throw new CleoError(4, 'gone', { fix });",
        "const ok = 'cleo show T1';",
        "return engineError('E_X', 'bad', { fix: ok });",
      ].join('\n'),
      (text) => (text.includes('cleo nope') ? ['no such command: cleo nope'] : []),
    );
    expect(offending).toEqual([
      { file: 'src/x.ts', line: 2, reason: 'fix does not run: no such command: cleo nope' },
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

  it('on a results path, counts an { ok: false, error } result with no fix or an unrunnable one (T14663)', () => {
    const source = [
      "function f() { return { ok: false, error: { code: 'E_X', message: 'bad' } }; }",
      "function g() { return { ok: false, error: { code: 'E_X', message: 'bad', fix: 'cleo docs update s --nope' } }; }",
      "function h() { return { ok: false, error: { code: 'E_X', message: 'bad', fix: 'cleo docs fetch s' } }; }",
      "function i() { return { ok: false, error: { code: 'E_X', message: 'bad', fix: c ? 'cleo docs fetch s' : 'cleo nope' } }; }",
      "function j() { return { ok: true, error: { code: 'E_X', message: 'bad' } }; }",
    ].join('\n');
    const check = (text) =>
      text.includes('--nope') || text.includes('cleo nope') ? [`bad: ${text}`] : [];
    expect(judge(source, check, undefined, true)).toEqual([
      { file: 'src/x.ts', line: 1, reason: '{ ok: false } result with no fix' },
      { file: 'src/x.ts', line: 2, reason: 'fix does not run: bad: cleo docs update s --nope' },
      { file: 'src/x.ts', line: 4, reason: 'fix does not run: bad: cleo nope' },
    ]);
    // Without `results: true`, result literals are not refusals.
    expect(judge(source, check)).toEqual([]);
  });

  it('judges a docs update refusal with the real command manifest (T14663)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'refusal-fixes-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src/x.ts'),
        [
          "function a() { return { ok: false, error: { code: 'E_X', message: 'm', fix: 'cleo docs update s --status draft' } }; }",
          "function b() { return { ok: false, error: { code: 'E_X', message: 'm', fix: 'cleo docs fetch s --bogus-flag x' } }; }",
          "function c() { return { ok: false, error: { code: 'E_X', message: 'm', fix: 'cleo docs no-such-verb s' } }; }",
        ].join('\n'),
      );
      const { check } = refusalChecker(REPO_ROOT);
      expect(
        offendingRefusals(
          root,
          { path: 'docs-update', file: 'src/x.ts', results: true },
          check,
        ).map((o) => o.line),
      ).toEqual([2, 3]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
