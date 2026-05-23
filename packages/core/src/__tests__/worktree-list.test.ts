/**
 * Integration test for the structured `worktree list` primitive (T9546 AC5).
 *
 * Unlike `packages/core/src/worktree/__tests__/list.test.ts` (which mocks
 * `execFileSync` to drive every classifier branch), this suite spins up a
 * real on-disk git repository plus real `git worktree add` calls so the
 * end-to-end envelope shape is validated against actual git output.
 *
 * Coverage matrix:
 *  - AC1: structured JSON returned for all CLEO-managed worktrees
 *  - AC2: worktrees rooted under the canonical `<cleoHome>/worktrees/...`
 *         path bubble up correctly (covered by the spawned-style worktree)
 *  - AC3: sentinel `.cleo/worktrees.json` entries are unioned into the listing
 *  - AC4: every entry exposes
 *         `{ taskId, path, branch, source, createdAt, lockState }`
 *
 * @task T9546
 * @epic T10192
 * @saga T10176
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listWorktrees } from '../worktree/list.js';
import { type SentinelWorktreeEntry, writeSentinelIndex } from '../worktree/sentinel-index.js';

interface Fixture {
  /** Absolute path to the project root inside a fresh tmp dir. */
  projectRoot: string;
  /** Absolute path to a sibling directory used as the "<cleoHome>/worktrees" parent. */
  worktreesRoot: string;
  /** Cleanup callback — removes tmp dirs. */
  cleanup: () => void;
}

/**
 * Build a fresh on-disk repo with one commit on `main`, plus a sibling
 * `worktrees/` directory that holds the linked worktrees this test creates.
 *
 * We do NOT depend on `spawnWorktree` here so the integration test exercises
 * `listWorktrees` directly without coupling to the broader worktree-napi
 * pipeline. Real `git worktree add` calls are issued from each test body.
 */
function makeFixture(): Fixture {
  // macOS resolves `/var/folders/...` (the OS tmpdir) through a symlink to
  // `/private/var/folders/...`. Git porcelain emits the realpath, so we
  // canonicalise the tmp root here to keep path comparisons portable across
  // macOS + Linux runners.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-worktree-list-it-')));
  const projectRoot = join(tmp, 'project');
  const worktreesRoot = join(tmp, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });

  execFileSync('git', ['init', '-b', 'main', projectRoot], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: projectRoot, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });

  return {
    projectRoot,
    worktreesRoot,
    cleanup() {
      try {
        // `git worktree remove` would be cleaner but tests may legitimately
        // leave administrative state behind; rm -rf is safe inside tmpdir.
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Create a linked git worktree on a fresh branch and return its absolute path.
 *
 * Mirrors `git worktree add -b task/<taskId> <root>/<taskId> main` — the same
 * shape `cleo orchestrate spawn` produces, minus the XDG location override.
 */
function addLinkedWorktree(fixture: Fixture, taskId: string): string {
  const path = join(fixture.worktreesRoot, taskId);
  execFileSync('git', ['worktree', 'add', '-b', `task/${taskId}`, path, 'main'], {
    cwd: fixture.projectRoot,
    stdio: 'pipe',
  });
  return path;
}

describe('listWorktrees — integration (T9546 AC1-AC5)', () => {
  let fixture: Fixture | undefined;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('returns a structured envelope with one entry per worktree (AC1)', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    addLinkedWorktree(fixture, 'T9546-it-a');
    addLinkedWorktree(fixture, 'T9546-it-b');

    const result = await listWorktrees({ projectRoot: fixture.projectRoot });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    // Primary + 2 linked = 3 total.
    expect(result.data.worktrees).toHaveLength(3);

    const paths = result.data.worktrees.map((w) => w.path).sort();
    expect(paths).toContain(join(fixture.worktreesRoot, 'T9546-it-a'));
    expect(paths).toContain(join(fixture.worktreesRoot, 'T9546-it-b'));
    expect(paths).toContain(fixture.projectRoot);
  });

  it('every entry exposes taskId, path, branch, source, createdAt, lockState (AC4)', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    addLinkedWorktree(fixture, 'T9546-shape');

    const result = await listWorktrees({ projectRoot: fixture.projectRoot });
    if (!result.success) throw new Error('expected success');

    // Inspect the linked worktree specifically — it has a deterministic
    // taskId derived from the branch name (`task/T9546-shape` → null because
    // the regex is `^task\/(T\d+)$` which excludes hyphenated suffixes).
    // Use a numeric-only task ID for the shape assertion.
    const linked = result.data.worktrees.find((w) => w.path.endsWith('T9546-shape'));
    expect(linked).toBeDefined();
    if (!linked) throw new Error('expected linked worktree in listing');

    expect(typeof linked.path).toBe('string');
    expect(typeof linked.branch).toBe('string');
    expect(linked.branch).toBe('task/T9546-shape');
    // T9546-shape does NOT match `^task\/(T\d+)$` (hyphenated suffix) → taskId is null.
    expect(linked.taskId).toBeNull();
    expect(linked.source).toBe('cleo-spawn');
    expect(typeof linked.createdAt).toBe('string');
    expect(() => new Date(linked.createdAt).toISOString()).not.toThrow();
    expect(linked.lockState).toBe('unlocked');
    expect(linked.isLocked).toBe(false);
  });

  it('extracts taskId from the canonical `task/T####` branch convention (AC4)', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    // Numeric-only taskId so the `^task\/(T\d+)$` regex matches.
    addLinkedWorktree(fixture, 'T1234');

    const result = await listWorktrees({ projectRoot: fixture.projectRoot });
    if (!result.success) throw new Error('expected success');

    const linked = result.data.worktrees.find((w) => w.path.endsWith('T1234'));
    expect(linked).toBeDefined();
    expect(linked?.taskId).toBe('T1234');
    expect(linked?.branch).toBe('task/T1234');
    expect(linked?.source).toBe('cleo-spawn');
  });

  it('unions sentinel-index entries with claude-agent source (AC3)', async () => {
    if (!fixture) throw new Error('fixture not initialised');

    // Write a sentinel index entry whose path is NOT a real worktree — the
    // integration test covers the "registered externally" code path where
    // the sentinel index is the only place CLEO knows about the worktree.
    const sentinelPath = join(fixture.worktreesRoot, 'claude-session-abc');
    mkdirSync(sentinelPath, { recursive: true });
    const sentinel: SentinelWorktreeEntry = {
      path: sentinelPath,
      branch: 'feat/T9546-claude-agent',
      taskId: 'T9546',
      source: 'claude-agent',
      adoptedAt: '2026-05-22T12:34:56.000Z',
      adoptedBy: 'claude-agent-test',
    };
    writeSentinelIndex(fixture.projectRoot, [sentinel]);

    const result = await listWorktrees({ projectRoot: fixture.projectRoot });
    if (!result.success) throw new Error('expected success');

    const adopted = result.data.worktrees.find((w) => w.path === sentinelPath);
    expect(adopted).toBeDefined();
    if (!adopted) throw new Error('expected sentinel-only entry in listing');
    expect(adopted.source).toBe('claude-agent');
    expect(adopted.branch).toBe('feat/T9546-claude-agent');
    expect(adopted.taskId).toBe('T9546');
    // createdAt MUST fall back to the sentinel's adoptedAt timestamp for
    // sentinel-only entries (AC4 — createdAt derivation).
    expect(adopted.createdAt).toBe('2026-05-22T12:34:56.000Z');
    expect(adopted.lockState).toBe('unlocked');
  });

  it('labels git-native worktrees as source=cleo-spawn when not in sentinel index (AC4)', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    addLinkedWorktree(fixture, 'T5555');

    const result = await listWorktrees({ projectRoot: fixture.projectRoot });
    if (!result.success) throw new Error('expected success');

    const linked = result.data.worktrees.find((w) => w.path.endsWith('T5555'));
    expect(linked?.source).toBe('cleo-spawn');
  });

  it('createdAt is derived from .git/worktrees/<name>/HEAD mtime for linked worktrees (AC4)', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    addLinkedWorktree(fixture, 'T9999');

    // Touch the admin HEAD file backwards in time so we can assert the
    // listing reads from THAT file (not from the worktree dir mtime).
    const adminHead = join(fixture.projectRoot, '.git', 'worktrees', 'T9999', 'HEAD');
    const targetMs = Date.UTC(2024, 0, 15, 10, 30, 0); // 2024-01-15T10:30:00Z
    utimesSync(adminHead, targetMs / 1000, targetMs / 1000);

    const result = await listWorktrees({ projectRoot: fixture.projectRoot });
    if (!result.success) throw new Error('expected success');

    const linked = result.data.worktrees.find((w) => w.path.endsWith('T9999'));
    expect(linked).toBeDefined();
    expect(linked?.createdAt).toBe(new Date(targetMs).toISOString());
  });

  it('reports locked worktrees with lockState=locked (AC4)', async () => {
    if (!fixture) throw new Error('fixture not initialised');
    const lockedPath = addLinkedWorktree(fixture, 'T9546-locked');
    execFileSync('git', ['worktree', 'lock', lockedPath], {
      cwd: fixture.projectRoot,
      stdio: 'pipe',
    });

    const result = await listWorktrees({ projectRoot: fixture.projectRoot });
    if (!result.success) throw new Error('expected success');

    const locked = result.data.worktrees.find((w) => w.path === lockedPath);
    expect(locked).toBeDefined();
    expect(locked?.lockState).toBe('locked');
    expect(locked?.isLocked).toBe(true);
    expect(locked?.statusCategory).toBe('locked');
  });
});
