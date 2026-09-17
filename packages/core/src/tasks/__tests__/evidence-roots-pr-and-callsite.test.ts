/**
 * `pr:` and `callsite-coverage:` must resolve against the repository under
 * test, not the CLEO store root (gh#1365, second pass).
 *
 * ## Why there was a second pass
 *
 * The first fix threaded an execution root to `commit:`, `files:`, `test-run:`
 * and `tool:` — four of the eleven arms of the `validateAtom` switch. `pr:` and
 * `callsite-coverage:` were on the same switch and kept the bare store root.
 *
 * Measured in production on v2026.9.5, in a project whose CLEO root is
 * `/mnt/projects/axiom-analytics` and whose git repo is the `axiom-app/`
 * subdirectory:
 *
 * ```
 * $ cleo verify T419 --gate implemented --evidence "pr:712"
 * E_EVIDENCE_TOOL_FAILED: gh pr view failed: failed to run git:
 *   fatal: not a git repository (or any parent up to mount point /mnt)
 * ```
 *
 * `pr:` is the arm that most needed the fix: it is the only atom that shells
 * out to a tool performing its OWN repo discovery. `gh` walks up from its cwd,
 * finds no repository before the mount point, and fails. No resolver threaded
 * inside CLEO can reach that — only its cwd can.
 *
 * `callsite-coverage:` fails in the more dangerous direction: `rg` searching
 * the store root reports a symbol UNCOVERED when it is covered. A false
 * negative on a coverage gate fails closed and looks like diligence, so it
 * would be chased as a real gap before anyone suspected the searcher's cwd.
 *
 * ## The shape the fix uses, and what it protects
 *
 * `EvidenceRoots` carries `{ storeRoot, executionRoot }` as two NAMED fields
 * rather than one parameter called `root`, because "root" is one word for two
 * things and a single parameter relocates that ambiguity into a signature. With
 * both named, every arm declares what it is about by which field it reads —
 * and `decision:`/`satisfies:` reading `storeRoot` is self-documenting rather
 * than an exception. Those two are asserted here too: they are CORRECT on the
 * store root, and a blanket "thread the execution root everywhere" pass would
 * have pointed them at the wrong database.
 *
 * @task T12238 (gh#1365)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePrEvidenceAtom } from '../../release/pr-evidence.js';
import { validateAtom } from '../evidence.js';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

/** Store root with the git checkout in a SUBDIRECTORY — the reported layout. */
let storeRoot: string;
let repoRoot: string;

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), 'roots-store-'));
  mkdirSync(join(storeRoot, '.cleo'), { recursive: true });
  repoRoot = join(storeRoot, 'app');
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
});

afterEach(() => {
  rmSync(storeRoot, { recursive: true, force: true });
});

describe('pr: atom runs gh in the REPO, caches in the STORE (gh#1365)', () => {
  it('hands the execution root to the gh fetcher, not the store root', async () => {
    // The production defect, as an assertion. The injectable fetcher stands in
    // for `gh pr view` and records the cwd it was given — which is the single
    // value that decided whether the real command worked.
    const seen: string[] = [];
    await resolvePrEvidenceAtom(
      712,
      { storeRoot, executionRoot: repoRoot },
      {
        bypassCache: true,
        fetchGhPrPayload: async (_pr, cwd) => {
          seen.push(cwd);
          return { ok: false, reason: 'stub — cwd is what this test is about' };
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(repoRoot);
    expect(seen[0]).not.toBe(storeRoot);
  });
});

describe('the store-root arms are CORRECT and must not be threaded (gh#1365)', () => {
  it('decision: resolves against the store, not the repo', async () => {
    // Guarding a decision, not a mechanism. A decision lives in the BRAIN db —
    // CLEO's own record. A blanket execution-root pass would point this at a
    // database that does not exist in the repo subdirectory. Asserting the
    // failure NAMES the decision rather than a missing database is enough to
    // show which root was consulted.
    const r = await validateAtom({ kind: 'decision', decisionId: 'D-NOPE-404' }, storeRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('D-NOPE-404');
    }
  });
});

describe('callsite-coverage: searches the REPO (gh#1365)', () => {
  it('finds a symbol present only in the caller worktree', async () => {
    // Uses a real `git worktree`, because `resolveEvidenceExecutionRoot` only
    // redirects when the caller's toplevel belongs to the SAME project as the
    // store root — an unrelated tmpdir falls back by design.
    //
    // The first draft of this test used a store root that CONTAINED the repo as
    // a subdirectory. That cannot discriminate: `rg` from the parent searches
    // the child too, so it passes whichever root is used. It also never
    // exercised the resolver at all, since `validateAtom` derives the execution
    // root from `process.cwd()` — which under vitest is the cleocode checkout,
    // not the fixture. It passed against a non-result.
    const main = mkdtempSync(join(tmpdir(), 'cc-main-'));
    git(main, ['init', '-q', '-b', 'main']);
    git(main, ['config', 'user.name', 'Test']);
    git(main, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(main, 'README.md'), 'base\n');
    git(main, ['add', 'README.md']);
    git(main, ['commit', '-q', '-m', 'base']);

    const wt = `${main}-wt`;
    git(main, ['worktree', 'add', '-q', '-b', 'feature', wt]);
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(
      join(wt, 'src', 'thing.ts'),
      'export function uniqueSymbolForTest(): number {\n  return 1;\n}\n',
    );
    writeFileSync(
      join(wt, 'src', 'caller.ts'),
      "import { uniqueSymbolForTest } from './thing.js';\nuniqueSymbolForTest();\n",
    );
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'symbol on the branch']);

    const cwd0 = process.cwd();
    try {
      process.chdir(wt);
      const r = await validateAtom(
        {
          kind: 'callsite-coverage',
          symbolName: 'uniqueSymbolForTest',
          relativeSourcePath: 'src/thing.ts',
        },
        main,
      );
      // The symbol and its caller exist ONLY in the worktree. Searching the
      // store root finds neither, which is the false negative this fixes.
      expect(r.ok).toBe(true);
    } finally {
      process.chdir(cwd0);
      try {
        git(main, ['worktree', 'remove', '--force', wt]);
      } catch {
        /* tmpdir removal below is the real cleanup */
      }
      rmSync(main, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
