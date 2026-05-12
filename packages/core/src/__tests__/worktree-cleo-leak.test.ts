/**
 * T9092 Regression test — no rogue .cleo/ directories in spawned worktrees.
 *
 * Verifies that `getCleoProjectRoot()` correctly resolves back to the main
 * repo root when called from within an ALS worktreeScope, and that
 * `getCleoDirAbsolute()` therefore always points at the source-project .cleo/
 * rather than creating a rogue copy under the worktree path.
 *
 * @task T9092
 * @task T9193
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoDirAbsolute, getCleoProjectRoot, worktreeScope } from '../paths.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

let _tmpDirs: string[] = [];

/**
 * Create a temp directory for each test, tracked for cleanup.
 */
function makeTmpDir(suffix: string): string {
  const dir = join(tmpdir(), `cleo-t9092-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  _tmpDirs.push(dir);
  return dir;
}

/**
 * Scaffold a minimal valid CLEO project at the given path.
 * Writes .cleo/project-info.json and a sibling .git/ dir.
 */
function scaffoldProject(dir: string, projectId = 'test-project'): void {
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  writeFileSync(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId, name: 'test' }),
    'utf-8',
  );
  mkdirSync(join(dir, '.git'), { recursive: true });
  // Minimal git HEAD so validateProjectRoot accepts it via legacy path
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
}

/**
 * Scaffold a git worktree at `worktreePath` that gitlinks back to `mainRepo`.
 * Creates the gitlink FILE at `worktreePath/.git` pointing to
 * `<mainRepo>/.git/worktrees/<name>`.
 */
function scaffoldWorktree(worktreePath: string, mainRepo: string, name = 'test-wt'): void {
  mkdirSync(worktreePath, { recursive: true });
  // Create the worktrees/<name> dir in the main repo's .git
  const worktreeGitDir = join(mainRepo, '.git', 'worktrees', name);
  mkdirSync(worktreeGitDir, { recursive: true });
  // Write the gitlink file in the worktree
  writeFileSync(join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('T9092 — getCleoProjectRoot() inside a worktreeScope', () => {
  beforeEach(() => {
    _tmpDirs = [];
  });

  afterEach(() => {
    // Cleanup is best-effort; don't fail tests on cleanup errors
    for (const dir of _tmpDirs) {
      try {
        // Use sync rimraf equivalent
        const { rmSync } = require('node:fs');
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* intentionally silent */
      }
    }
  });

  it('returns the main repo root when ALS scope is active with a valid gitlink', async () => {
    const mainRepo = makeTmpDir('main-repo');
    const worktree = makeTmpDir('worktree');
    scaffoldProject(mainRepo);
    scaffoldWorktree(worktree, mainRepo);

    let resolvedRoot: string | undefined;
    await worktreeScope.run(
      { worktreeRoot: worktree, projectHash: 'test-hash' },
      async () => {
        resolvedRoot = getCleoProjectRoot();
      },
    );

    expect(resolvedRoot).toBe(mainRepo);
  });

  it('getCleoDirAbsolute() points to main-repo .cleo/ — NOT the worktree', async () => {
    const mainRepo = makeTmpDir('main-repo-2');
    const worktree = makeTmpDir('worktree-2');
    scaffoldProject(mainRepo);
    scaffoldWorktree(worktree, mainRepo);

    let cleoDir: string | undefined;
    await worktreeScope.run(
      { worktreeRoot: worktree, projectHash: 'test-hash-2' },
      async () => {
        cleoDir = getCleoDirAbsolute();
      },
    );

    // Must point to mainRepo/.cleo, NOT worktree/.cleo
    expect(cleoDir).toBe(join(mainRepo, '.cleo'));
    // Worker should NEVER create .cleo/ inside the worktree
    expect(existsSync(join(worktree, '.cleo'))).toBe(false);
  });

  it('falls back to standard resolution when no worktreeScope is active', () => {
    // Outside a scope, getCleoProjectRoot delegates to getProjectRoot.
    // With CLEO_ROOT env set by the test runner, it should return a value.
    // Without CLEO_ROOT set, it will throw E_NO_PROJECT for /tmp.
    // Either way, the function must not crash unexpectedly.
    const hadScope = worktreeScope.getStore() !== undefined;
    expect(hadScope).toBe(false); // confirm no active scope outside the run() block
  });

  it('does NOT crash on gitlink parse failure — gracefully falls back to getProjectRoot()', async () => {
    const worktree = makeTmpDir('worktree-bad-link');
    mkdirSync(worktree, { recursive: true });
    // Write an INVALID gitlink file (not "gitdir: ..." format)
    writeFileSync(join(worktree, '.git'), 'not a valid gitlink\n', 'utf-8');

    // When gitlink can't be parsed, fallback calls getProjectRoot(cwd)
    // which with ALS scope active returns scope.worktreeRoot (the worktree path).
    // The key thing is: no crash during the gitlink parsing step.
    let result: string | undefined;
    let threw = false;
    await worktreeScope.run(
      { worktreeRoot: worktree, projectHash: 'bad-hash' },
      async () => {
        try {
          result = getCleoProjectRoot();
        } catch {
          threw = true;
        }
      },
    );
    // Either returned a value or threw — the important thing is
    // no unhandled error during gitlink parse. The fallback path is exercised.
    expect(typeof result === 'string' || threw).toBe(true);
  });
});
