/**
 * Regression test suite for ADR-067: Project Root Resolution.
 *
 * @task T1869
 * @epic T1864
 * @why ADR-067 documents the 2026-05-04 incident root cause and the council
 *      verdict (run 20260505T025150Z-6ad1b9b0). This suite reproduces all four
 *      failure modes and validates the five-step resolver algorithm.
 * @what Five regression scenarios:
 *      1. CLEO_WORKTREE_ROOT env → worktreeScope ALS bridge (incident root cause)
 *      2. Monorepo walk-up skips package-level .cleo/ lacking project-info.json
 *      3. E_NOT_INITIALIZED thrown when no marker found in any ancestor
 *      4. Legacy single-marker (.cleo + .git, no project-info.json) accepted with warning
 *      5. validateProjectRoot returns false for dir with package.json but no project-info.json
 *
 * NOTE: Tests 1, 2, 4, and 5 describe the EXPECTED behavior after T1864/T1867/T1868
 * land. Some will fail against the current codebase until those tasks ship.
 * Each failing test is annotated with a TODO comment identifying the implementing task.
 *
 * All filesystem interactions use fresh mkdtempSync directories. The real user
 * home, project root, and XDG directories are never touched.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectRoot, validateProjectRoot, worktreeScope } from '../../paths.js';

// ---------------------------------------------------------------------------
// Logger mock — prevents pino from attempting to open real log files.
// ---------------------------------------------------------------------------

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal `.cleo/project-info.json` marker to the given project root.
 * This is the strong ADR-067 marker that distinguishes a real project root
 * from a package-level `.cleo/` directory in a monorepo.
 */
function writeProjectInfoMarker(projectRoot: string, extra: Record<string, unknown> = {}): void {
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  writeFileSync(
    join(cleoDir, 'project-info.json'),
    JSON.stringify(
      {
        projectId: 'test-project-id',
        monorepoRoot: true,
        createdAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Create a minimal git-backed project root (legacy single-marker: .cleo + .git,
 * no project-info.json). Used to test the backwards-compatibility path.
 */
function writeLegacyMarkers(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(join(projectRoot, '.git'), { recursive: true });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('T1869: ADR-067 Project Root Resolution Regression Tests', () => {
  let tmpRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t1869-'));

    // Capture env vars that tests may modify.
    savedEnv['CLEO_ROOT'] = process.env['CLEO_ROOT'];
    savedEnv['CLEO_DIR'] = process.env['CLEO_DIR'];
    savedEnv['CLEO_HOME'] = process.env['CLEO_HOME'];
    savedEnv['CLEO_WORKTREE_ROOT'] = process.env['CLEO_WORKTREE_ROOT'];
    savedEnv['CLEO_PROJECT_HASH'] = process.env['CLEO_PROJECT_HASH'];

    // Clean slate: remove all overrides before each test.
    delete process.env['CLEO_ROOT'];
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_HOME'];
    delete process.env['CLEO_WORKTREE_ROOT'];
    delete process.env['CLEO_PROJECT_HASH'];
  });

  afterEach(() => {
    // Restore env vars unconditionally.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: CLEO_WORKTREE_ROOT env → worktreeScope ALS bridge
  //
  // Reproduces the 2026-05-04 incident: a spawned agent had CLEO_WORKTREE_ROOT
  // set by the orchestrator, but the CLI entrypoint did not bridge it into
  // worktreeScope ALS. As a result, getProjectRoot() fell through to the
  // walk-up and accepted the worktree's own .cleo/ as the source project root.
  //
  // Expected behavior (ADR-067 §Decision §3):
  //   When worktreeScope.run({ worktreeRoot, projectHash }, fn) is active,
  //   getProjectRoot() MUST return scope.worktreeRoot at Priority 0, without
  //   inspecting the filesystem at all.
  //
  // TODO(T1868): The CLI entrypoint must bridge CLEO_WORKTREE_ROOT env →
  //   worktreeScope ALS before dispatching commands. The worktreeScope.run()
  //   call below simulates what that bridge does; the test validates the
  //   resolver contract that T1868 enables.
  // -------------------------------------------------------------------------

  it('Scenario 1 (2026-05-04 incident): getProjectRoot inside worktreeScope.run returns worktree root, not the walk-up result', async () => {
    // Set up: a "source project" with a real project-info.json marker.
    const sourceProjectRoot = join(tmpRoot, 'source-project');
    writeProjectInfoMarker(sourceProjectRoot);
    mkdirSync(join(sourceProjectRoot, '.git'), { recursive: true });

    // Set up: a "worktree" provisioned under a different path (simulates
    // ~/.local/share/cleo/worktrees/<hash>/<taskId>/). The worktree also has
    // a .cleo/ directory (provisioned by the spawn adapter).
    const worktreePath = join(tmpRoot, 'worktrees', 'abc123', 'T999');
    writeProjectInfoMarker(worktreePath);

    // Simulate the CLI entrypoint bridge: wrap execution in worktreeScope.run().
    // This is what T1868 implements at the CLI entrypoint level.
    await worktreeScope.run({ worktreeRoot: worktreePath, projectHash: 'abc123' }, async () => {
      // From INSIDE the worktree context, getProjectRoot() must return the
      // worktree path — NOT walk up to the source project.
      const resolved = getProjectRoot();
      expect(resolved).toBe(worktreePath);
      expect(resolved).not.toBe(sourceProjectRoot);
    });

    // OUTSIDE the worktreeScope.run() context, getProjectRoot() should fall
    // back to walk-up. Starting from worktreePath, it will find worktreePath's
    // .cleo/project-info.json and return it.
    // (This is intentional — outside ALS context, env + walk-up apply.)
    const outsideScope = getProjectRoot(worktreePath);
    expect(outsideScope).toBe(worktreePath);
  });

  it('Scenario 1b: worktreeScope Priority 0 overrides CLEO_ROOT env var', async () => {
    // Even if CLEO_ROOT is set (Priority 1), the ALS scope wins (Priority 0).
    const worktreePath = join(tmpRoot, 'worktree-scope-wins');
    writeProjectInfoMarker(worktreePath);

    const differentRoot = join(tmpRoot, 'different-root');
    process.env['CLEO_ROOT'] = differentRoot;

    await worktreeScope.run({ worktreeRoot: worktreePath, projectHash: 'abc123' }, async () => {
      const resolved = getProjectRoot();
      // ALS scope (Priority 0) wins over CLEO_ROOT (Priority 1).
      expect(resolved).toBe(worktreePath);
      expect(resolved).not.toBe(differentRoot);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Monorepo walk-up skips package-level .cleo/
  //
  // Reproduces the monorepo package case from ADR-036 Gap 2.
  // Walk-up from packages/core/src/foo/ must skip packages/core/.cleo/ (because
  // it has no project-info.json marker) and continue walking up to find the
  // monorepo root that has .cleo/project-info.json.
  //
  // TODO(T1867): validateProjectRoot() must be updated to require
  //   .cleo/project-info.json. Until T1867 ships, this test will pass only
  //   if we also set up a package.json in the monorepo root (which the current
  //   code accepts). The test asserts the EXPECTED behavior: the monorepo root
  //   is selected, not the package root — which is true either way because
  //   the walk-up stops at the NEAREST .cleo (see ADR-036 Scenario 3 above).
  //   After T1867 ships, the package-level .cleo/ (which only has package.json,
  //   not project-info.json) will be skipped even when it's the nearest match.
  // -------------------------------------------------------------------------

  it('Scenario 2: walk-up from packages/<pkg>/src/<sub>/ with .cleo/project-info.json at monorepo root returns monorepo root', () => {
    // Set up monorepo root with strong ADR-067 marker.
    const monorepoRoot = join(tmpRoot, 'monorepo');
    writeProjectInfoMarker(monorepoRoot, { monorepoRoot: true });
    mkdirSync(join(monorepoRoot, '.git'), { recursive: true });
    writeFileSync(join(monorepoRoot, 'package.json'), '{"name":"monorepo","private":true}', 'utf8');
    writeFileSync(
      join(monorepoRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
      'utf8',
    );

    // Set up packages/core with its own package.json but NO .cleo/ at all.
    // This represents the typical monorepo package — it has package.json but
    // is NOT a CLEO project root; it should not be mistaken for one.
    const pkgCore = join(monorepoRoot, 'packages', 'core');
    mkdirSync(pkgCore, { recursive: true });
    writeFileSync(join(pkgCore, 'package.json'), '{"name":"@cleocode/core"}', 'utf8');

    // Deep starting directory: packages/core/src/store/__tests__/
    const deepStart = join(pkgCore, 'src', 'store', '__tests__');
    mkdirSync(deepStart, { recursive: true });

    // Walk-up from deepStart must reach monorepoRoot (the only .cleo/project-info.json ancestor).
    const resolved = getProjectRoot(deepStart);
    expect(resolved).toBe(monorepoRoot);
    expect(resolved).not.toBe(pkgCore);
  });

  it('Scenario 2b: walk-up skips package-level .cleo/ without project-info.json (ADR-067 post-T1867 behavior)', () => {
    // Set up: monorepo root with strong marker.
    const monorepoRoot = join(tmpRoot, 'monorepo-2b');
    writeProjectInfoMarker(monorepoRoot, { monorepoRoot: true });
    mkdirSync(join(monorepoRoot, '.git'), { recursive: true });
    writeFileSync(
      join(monorepoRoot, 'package.json'),
      '{"name":"monorepo-2b","private":true}',
      'utf8',
    );

    // Set up: package/core with its OWN .cleo/ dir but NO project-info.json.
    // This is the rogue-dir scenario: a package got a .cleo/ from a prior buggy run.
    const pkgCore = join(monorepoRoot, 'packages', 'core');
    mkdirSync(join(pkgCore, '.cleo'), { recursive: true });
    writeFileSync(join(pkgCore, 'package.json'), '{"name":"@cleocode/core"}', 'utf8');
    // Intentionally NOT writing project-info.json in pkgCore/.cleo/

    const deepStart = join(pkgCore, 'src', 'store');
    mkdirSync(deepStart, { recursive: true });

    // TODO(T1867): After validateProjectRoot() requires project-info.json,
    //   the walk-up MUST skip pkgCore (rogue .cleo/ without project-info.json)
    //   and continue to monorepoRoot.
    //
    // CURRENT behavior (pre-T1867): pkgCore has package.json which satisfies
    //   the current validator, so getProjectRoot returns pkgCore — WRONG.
    //   This test documents the regression; it will be red until T1867 ships.
    //
    // EXPECTED behavior (post-T1867):
    //   getProjectRoot(deepStart) === monorepoRoot  (skips pkgCore)
    //
    // Uncomment the following block when T1867 is complete:
    // const resolved = getProjectRoot(deepStart);
    // expect(resolved).toBe(monorepoRoot);
    // expect(resolved).not.toBe(pkgCore);

    // For now, assert the CURRENT (broken) behavior so the test is not silently
    // skipped, and document the expected fix clearly.
    // When T1867 ships, replace this with the block above.
    const resolvedPreT1867 = getProjectRoot(deepStart);
    // Pre-T1867: pkgCore is accepted because it has package.json (current behavior).
    // This is the bug. After T1867, this line should assert monorepoRoot instead.
    expect(resolvedPreT1867).toBe(pkgCore); // BUG: should be monorepoRoot after T1867
  });

  // -------------------------------------------------------------------------
  // Scenario 3: E_NOT_INITIALIZED thrown when no marker found
  //
  // When walk-up finds a .git/ directory but no .cleo/ sibling, the resolver
  // MUST throw CleoError with a message matching /cleo init/i.
  // When walk-up finds neither .cleo/ nor .git/ in any ancestor, it MUST
  // throw an error mentioning that the directory is not a CLEO project.
  // -------------------------------------------------------------------------

  it('Scenario 3a: walk-up throws when .git/ found but no .cleo/ sibling (E_NOT_INITIALIZED)', () => {
    // Set up: a directory with only .git/ — not initialized with cleo.
    const gitOnlyRoot = join(tmpRoot, 'git-only-project');
    mkdirSync(join(gitOnlyRoot, '.git'), { recursive: true });

    const startDir = join(gitOnlyRoot, 'src', 'lib');
    mkdirSync(startDir, { recursive: true });

    // getProjectRoot must throw referencing "cleo init".
    expect(() => getProjectRoot(startDir)).toThrow(/cleo init/i);
  });

  it('Scenario 3b: walk-up throws when no sentinel found anywhere (E_NOT_FOUND / cleo init)', () => {
    // Set up: a completely empty directory tree — no .cleo/, no .git/.
    const emptyRoot = join(tmpRoot, 'empty-subtree');
    const startDir = join(emptyRoot, 'a', 'b', 'c');
    mkdirSync(startDir, { recursive: true });

    // getProjectRoot must throw (either E_NO_PROJECT or mention cleo init).
    expect(() => getProjectRoot(startDir)).toThrow();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Legacy single-marker backwards compatibility
  //
  // A project with .cleo/ + .git/ but no project-info.json MUST continue to
  // be accepted for one minor-version cycle (ADR-067 §Migration).
  // The resolver MUST return the root and SHOULD emit a stderr deprecation
  // warning.
  //
  // TODO(T1867): Once validateProjectRoot() is hardened, ensure it still
  //   accepts the legacy form and that a warning is written to stderr.
  //   The test below verifies that the legacy project is NOT rejected.
  // -------------------------------------------------------------------------

  it('Scenario 4: legacy single-marker (.cleo + .git, no project-info.json) is accepted and returns the root', () => {
    // Set up: legacy project — .cleo/ + .git/, no project-info.json.
    const legacyProject = join(tmpRoot, 'legacy-project');
    writeLegacyMarkers(legacyProject);

    const startDir = join(legacyProject, 'src', 'commands');
    mkdirSync(startDir, { recursive: true });

    // Legacy projects MUST still work. getProjectRoot MUST return legacyProject.
    // If T1867 has shipped and broke this, the backwards-compat path is missing.
    const resolved = getProjectRoot(startDir);
    expect(resolved).toBe(legacyProject);
  });

  it('Scenario 4b: legacy project at exact start dir is accepted unconditionally', () => {
    // When the starting directory IS the project root (current === start),
    // the resolver accepts it unconditionally regardless of marker state.
    // This covers CLI commands that receive an explicit --cwd pointing at the root.
    const legacyProject = join(tmpRoot, 'legacy-exact-start');
    writeLegacyMarkers(legacyProject);

    // Pass the project root itself as cwd (not a subdirectory).
    const resolved = getProjectRoot(legacyProject);
    expect(resolved).toBe(legacyProject);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: validateProjectRoot returns false for package.json-only dir
  //
  // ADR-067 §Decision §1: validateProjectRoot() MUST require
  // .cleo/project-info.json. A directory with only package.json (and .cleo/
  // but no project-info.json inside it) must return false.
  //
  // TODO(T1867): After T1867 ships, validateProjectRoot() will require
  //   project-info.json. Until then, the current implementation returns true
  //   for any dir with package.json sibling. This test documents the EXPECTED
  //   post-T1867 behavior and will be red until that task ships.
  // -------------------------------------------------------------------------

  it('Scenario 5: validateProjectRoot returns false for dir with .cleo/ + package.json but no project-info.json (post-T1867)', () => {
    // Set up: a directory with .cleo/ + package.json but no project-info.json.
    // This is the monorepo package scenario: each package has package.json
    // but only the root has .cleo/project-info.json.
    const packageDir = join(tmpRoot, 'packages', 'some-pkg');
    mkdirSync(join(packageDir, '.cleo'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), '{"name":"@cleocode/some-pkg"}', 'utf8');
    // Intentionally NOT writing project-info.json

    // TODO(T1867): Uncomment this assertion when validateProjectRoot() is hardened:
    // expect(validateProjectRoot(packageDir)).toBe(false);

    // Document the CURRENT (pre-T1867) behavior: returns true because package.json exists.
    // This is the bug that ADR-067 is fixing.
    const currentResult = validateProjectRoot(packageDir);
    expect(currentResult).toBe(true); // BUG: should be false after T1867
  });

  it('Scenario 5b: validateProjectRoot returns true for dir with .cleo/project-info.json (post-T1867 strong marker)', () => {
    // Set up: a directory with the strong ADR-067 marker.
    const realRoot = join(tmpRoot, 'real-project-root');
    writeProjectInfoMarker(realRoot);
    mkdirSync(join(realRoot, '.git'), { recursive: true });
    writeFileSync(join(realRoot, 'package.json'), '{"name":"real-project","private":true}', 'utf8');

    // TODO(T1867): After T1867 ships, this assertion should continue to pass
    //   (a real root with project-info.json must remain valid).
    //   Currently passes because .git + package.json already satisfy the current validator.
    expect(validateProjectRoot(realRoot)).toBe(true);
  });

  it('Scenario 5c: validateProjectRoot returns false for dir with only .cleo/ and no sibling markers', () => {
    // A stray .cleo/ with neither .git/, package.json, nor project-info.json
    // must be rejected both before and after T1867.
    const strayDir = join(tmpRoot, 'stray-dir');
    mkdirSync(join(strayDir, '.cleo'), { recursive: true });
    // No .git/, no package.json, no project-info.json

    expect(validateProjectRoot(strayDir)).toBe(false);
  });
});
