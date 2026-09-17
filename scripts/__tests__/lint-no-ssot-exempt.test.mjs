/**
 * Tests for scripts/lint-no-ssot-exempt.mjs — specifically the boundary between
 * "this PR added an exemption" and "CI could not determine what this PR added".
 *
 * gh#1469: `getAddedLines` returns `null` when git cannot produce a diff, and the
 * caller fell back to scanning all of `packages/`. Under `--strict` that is not a
 * degraded answer, it is a different question — strict rejects every exemption it
 * is shown, so a whole-tree scan of a repo that legitimately contains them is
 * guaranteed to fail, naming files the change never touched.
 *
 * The production trigger is reproduced in `strict refuses a grafted base` below,
 * because two plausible explanations were both wrong. The runner checkout is NOT
 * shallow (`fetch-depth: 0`), and forking is irrelevant. The
 * `git fetch origin main --depth=1` step that followed re-shallowed the complete
 * clone; `origin/main` still resolves, only the merge base is gone — and only
 * when main's tip is not already an ancestor of HEAD.
 *
 * On a pull_request event HEAD is `refs/pull/N/merge`, which GitHub rebuilds on
 * push and not when main moves, so the real trigger is main advancing while a PR
 * sits. That makes it a race rather than a property of the change: #1444's merge
 * ref was built against d1f64f56 and main had become 77cd117f. The fixture below
 * models the same condition with a plain branch, which is the cheaper way to
 * construct "HEAD whose history does not contain the base tip".
 *
 * @task T12240
 * @epic T12119
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LINT_SCRIPT = join(REPO_ROOT, 'scripts/lint-no-ssot-exempt.mjs');

/** Exit code meaning "violations were found in the diff". */
const EXIT_VIOLATIONS = 1;
/** Exit code meaning "the base could not be resolved, so no verdict is possible". */
const EXIT_INDETERMINATE = 2;

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Run a git command, throwing with context when it fails.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} trimmed stdout
 */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Run the linter.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function lint(args, cwd) {
  return spawnSync(process.execPath, [LINT_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

/**
 * Build an upstream repo plus a consumer clone whose branch is BEHIND the default
 * branch, then re-shallow it exactly as the CI step did.
 *
 * @returns {{consumer: string, defaultBranch: string}}
 */
function makeGraftedClone() {
  const root = mkdtempSync(join(tmpdir(), 'ssot-exempt-graft-'));
  tmpDirs.push(root);
  const upstream = join(root, 'upstream');

  git(['init', '-q', upstream], root);
  git(['config', 'user.email', 'test@example.invalid'], upstream);
  git(['config', 'user.name', 'Test'], upstream);
  writeFileSync(join(upstream, 'a.ts'), 'export const a = 1;\n');

  // A PRE-EXISTING exemption, committed at the base and never touched by the
  // branch under test. Without this the fixture cannot reproduce production:
  // the full-scan fallback would find nothing to accuse and the unfixed script
  // would exit 0, making the "accuses nothing" assertion pass vacuously. It
  // must live under `packages/` because that is the tree the fallback scans.
  mkdirSync(join(upstream, 'packages/core/src'), { recursive: true });
  writeFileSync(
    join(upstream, 'packages/core/src/legacy.ts'),
    '// SSoT-EXEMPT:engine-migration-T1571\nexport const legacy = 1;\n',
  );
  git(['add', 'a.ts', 'packages'], upstream);
  git(['commit', '-q', '-m', 'base'], upstream);
  const defaultBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], upstream);

  // A branch cut from that point — no exemption added, so the only honest
  // verdict on its CONTENT is "clean".
  git(['checkout', '-q', '-b', 'feature'], upstream);
  writeFileSync(join(upstream, 'b.ts'), 'export const b = 2;\n');
  git(['add', 'b.ts'], upstream);
  git(['commit', '-q', '-m', 'feature work'], upstream);

  // Main moves on. This is the whole precondition: the branch is now behind.
  git(['checkout', '-q', defaultBranch], upstream);
  writeFileSync(join(upstream, 'a.ts'), 'export const a = 99;\n');
  git(['add', 'a.ts'], upstream);
  git(['commit', '-q', '-m', 'main moves ahead'], upstream);

  const consumer = join(root, 'consumer');
  git(['clone', '-q', '--branch', 'feature', `file://${upstream}`, consumer], root);
  // The CI step verbatim. This is what grafts a complete clone.
  git(['fetch', 'origin', defaultBranch, '--depth=1'], consumer);

  return { consumer, defaultBranch };
}

describe('lint-no-ssot-exempt — base resolution vs content verdict (gh#1469)', () => {
  it('strict refuses a grafted base instead of reporting a content violation', () => {
    const { consumer, defaultBranch } = makeGraftedClone();

    // Precondition: the ref RESOLVES. The failure is not "no such branch" — that
    // is why it was mistaken for a content problem for as long as it was.
    expect(() => git(['rev-parse', `origin/${defaultBranch}`], consumer)).not.toThrow();
    // Precondition: there is genuinely no merge base.
    expect(
      spawnSync('git', ['merge-base', `origin/${defaultBranch}`, 'HEAD'], {
        cwd: consumer,
        encoding: 'utf8',
      }).status,
    ).not.toBe(0);

    const r = lint(['--strict', '--base', `origin/${defaultBranch}`], consumer);

    expect(r.status).toBe(EXIT_INDETERMINATE);
    // The distinction is the point: it must NOT look like "you added an exemption".
    expect(r.status).not.toBe(EXIT_VIOLATIONS);
    expect(r.stderr).toMatch(/cannot resolve a diff/i);
    // It must say WHY, not merely that.
    expect(r.stderr).toMatch(/merge base|git said/i);
  });

  it('names no source file when it cannot resolve the base', () => {
    // The original failure printed `packages/core/src/system/safestop.ts:29` on a
    // PR that never touched it. An indeterminate result must accuse nothing.
    //
    // Assert on BOTH streams. An earlier draft of this test checked `stdout`
    // alone and passed against the unfixed script — violations are written to
    // stderr, so it was asserting on a stream that is empty either way. It was
    // caught only because the unfixed run produced 1 failure where 2 were
    // predicted; the name claimed a property the assertion did not isolate.
    const { consumer, defaultBranch } = makeGraftedClone();
    const r = lint(['--strict', '--base', `origin/${defaultBranch}`], consumer);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\.ts:\d+/);
  });

  it('still fails with the violations code when the diff DOES resolve and adds one', () => {
    // Guards against "fixed by making it never fail" — the gate must keep working.
    const root = mkdtempSync(join(tmpdir(), 'ssot-exempt-live-'));
    tmpDirs.push(root);
    git(['init', '-q', root], root);
    git(['config', 'user.email', 'test@example.invalid'], root);
    git(['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    git(['add', 'a.ts'], root);
    git(['commit', '-q', '-m', 'base'], root);
    const base = git(['rev-parse', 'HEAD'], root);

    writeFileSync(join(root, 'a.ts'), '// SSoT-EXEMPT: deliberate\nexport const a = 1;\n');
    git(['add', 'a.ts'], root);
    git(['commit', '-q', '-m', 'adds an exemption'], root);

    const r = lint(['--strict', '--base', base], root);
    expect(r.status).toBe(EXIT_VIOLATIONS);
  });

  it('exits 0 under strict when the diff resolves and adds no exemption', () => {
    const root = mkdtempSync(join(tmpdir(), 'ssot-exempt-clean-'));
    tmpDirs.push(root);
    git(['init', '-q', root], root);
    git(['config', 'user.email', 'test@example.invalid'], root);
    git(['config', 'user.name', 'Test'], root);
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    git(['add', 'a.ts'], root);
    git(['commit', '-q', '-m', 'base'], root);
    const base = git(['rev-parse', 'HEAD'], root);

    writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
    git(['add', 'b.ts'], root);
    git(['commit', '-q', '-m', 'no exemption'], root);

    expect(lint(['--strict', '--base', base], root).status).toBe(0);
  });

  it('leaves the baseline-mode fallback intact — it is only unsound under strict', () => {
    // Local runs outside a PR context rely on the full scan. The fix must not
    // take that away; baseline mode must behave exactly as it did before.
    const { consumer, defaultBranch } = makeGraftedClone();
    const r = lint(['--base', `origin/${defaultBranch}`], consumer);
    expect(r.status).not.toBe(EXIT_INDETERMINATE);
    expect(r.stderr).not.toMatch(/cannot resolve a diff/i);
  });
});
