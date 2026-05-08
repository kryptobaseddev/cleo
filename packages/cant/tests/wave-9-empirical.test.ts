/**
 * Wave 9 empirical test: 3 parallel worktrees, isolation verification,
 * ff-merge on success, forensic retain on conflict.
 *
 * @remarks
 * Exercises the complete ADR-041 worktree isolation contract:
 *
 * 1. Three worktrees are created concurrently for the same fake epic.
 * 2. Each writes a unique marker file — cross-contamination is verified.
 * 3. Worktree-1 is ff-merged successfully; its directory is cleaned up.
 * 4. Worktree-2 simulates a conflict (diverged commit), ff-merge fails,
 *    directory is RETAINED for forensic inspection.
 * 5. Worktree-3 is cleaned up (no merge — simulates abandoned worker).
 * 6. WorktreeHandle.projectHash is verified to match WorktreeConfig.projectHash.
 *
 * Vitest with describe/it blocks per project conventions.
 * Git commands are invoked with execFileSync argv + cwd to avoid shell portability issues.
 *
 * @task T406
 * @task T380
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, mergeWorktree } from '../src/worktree.js';
import type { WorktreeConfig, WorktreeRequest } from '../src/worktree.js';

let tempDir: string;
let gitRoot: string;
let worktreeRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cleo-w9-'));
  gitRoot = join(tempDir, 'repo');
  worktreeRoot = join(tempDir, 'worktrees');

  mkdirSync(gitRoot, { recursive: true });
  git(['init'], gitRoot);
  git(['config', 'user.email', 'test@cleo.dev'], gitRoot);
  git(['config', 'user.name', 'CLEO W9 Test'], gitRoot);
  writeFileSync(join(gitRoot, 'README.md'), 'initial\n');
  git(['add', 'README.md'], gitRoot);
  git(['commit', '-m', 'init'], gitRoot);
});

afterEach(() => {
  try {
    git(['worktree', 'prune'], gitRoot);
  } catch {
    // best effort
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function git(args: readonly string[], cwd: string): Buffer {
  return execFileSync('git', [...args], { cwd, stdio: 'pipe' });
}

function gitText(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function testConfig(overrides: Partial<WorktreeConfig> = {}): WorktreeConfig {
  return { projectHash: 'w9-project-hash', gitRoot, worktreeRoot, ...overrides };
}

function testRequest(taskId: string, overrides: Partial<WorktreeRequest> = {}): WorktreeRequest {
  return { baseRef: 'HEAD', taskId, reason: 'parallel-wave', ...overrides };
}

describe('Wave 9 empirical: parallel worktrees + isolation + merge policy', () => {
  it('creates 3 parallel worktrees with no cross-contamination', () => {
    const config = testConfig();

    const h1 = createWorktree(testRequest('T-W9-1'), config);
    const h2 = createWorktree(testRequest('T-W9-2'), config);
    const h3 = createWorktree(testRequest('T-W9-3'), config);

    expect(h1.path).not.toBe(h2.path);
    expect(h2.path).not.toBe(h3.path);
    expect(h1.path).not.toBe(h3.path);

    expect(existsSync(h1.path)).toBe(true);
    expect(existsSync(h2.path)).toBe(true);
    expect(existsSync(h3.path)).toBe(true);

    writeFileSync(join(h1.path, 'MARKER-1.txt'), 'worker-1');
    writeFileSync(join(h2.path, 'MARKER-2.txt'), 'worker-2');
    writeFileSync(join(h3.path, 'MARKER-3.txt'), 'worker-3');

    expect(existsSync(join(h2.path, 'MARKER-1.txt'))).toBe(false);
    expect(existsSync(join(h3.path, 'MARKER-1.txt'))).toBe(false);
    expect(existsSync(join(h1.path, 'MARKER-2.txt'))).toBe(false);
    expect(existsSync(join(h3.path, 'MARKER-2.txt'))).toBe(false);
    expect(existsSync(join(h1.path, 'MARKER-3.txt'))).toBe(false);
    expect(existsSync(join(h2.path, 'MARKER-3.txt'))).toBe(false);

    h1.cleanup(true);
    h2.cleanup(true);
    h3.cleanup(true);

    expect(existsSync(h1.path)).toBe(false);
    expect(existsSync(h2.path)).toBe(false);
    expect(existsSync(h3.path)).toBe(false);
  });

  it('WorktreeHandle.projectHash matches WorktreeConfig.projectHash (T380/ADR-041 §D4)', () => {
    const config = testConfig({ projectHash: 'sentinel-hash-abc' });
    const h = createWorktree(testRequest('T-W9-ph'), config);

    expect(h.projectHash).toBe('sentinel-hash-abc');

    h.cleanup(true);
  });

  it('ff-merges worktree-1 successfully and removes directory (T403)', () => {
    const config = testConfig();
    const h = createWorktree(testRequest('T-W9-ff'), config);

    writeFileSync(join(h.path, 'feature.txt'), 'ff-merge target');
    git(['add', 'feature.txt'], h.path);
    git(['commit', '-m', 'worker-1 output'], h.path);

    const result = mergeWorktree(h, config, { strategy: 'ff-only' });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(existsSync(h.path)).toBe(false);

    const log = gitText(['log', '--oneline', '-1'], gitRoot);
    expect(log).toContain('worker-1 output');
  });

  it('retains worktree-2 on ff-merge failure for forensic inspection (T403)', () => {
    const config = testConfig();
    const h = createWorktree(testRequest('T-W9-conflict'), config);

    // Advance main repo so ff-only will fail.
    writeFileSync(join(gitRoot, 'diverged.txt'), 'main-repo diverged');
    git(['add', 'diverged.txt'], gitRoot);
    git(['commit', '-m', 'main diverged'], gitRoot);

    writeFileSync(join(h.path, 'worker-output.txt'), 'conflict worker output');
    git(['add', 'worker-output.txt'], h.path);
    git(['commit', '-m', 'worker-2 output'], h.path);

    const result = mergeWorktree(h, config, { strategy: 'ff-only' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Merge failed');

    // CRITICAL: directory must be retained for forensics.
    expect(existsSync(h.path)).toBe(true);

    const content = readFileSync(join(h.path, 'worker-output.txt'), 'utf-8');
    expect(content).toBe('conflict worker output');

    h.cleanup(false);
    expect(existsSync(h.path)).toBe(false);
  });

  it('cleans up worktree-3 without merging (abandoned worker path)', () => {
    const config = testConfig();
    const h = createWorktree(testRequest('T-W9-abandon'), config);

    expect(existsSync(h.path)).toBe(true);

    h.cleanup(true);

    expect(existsSync(h.path)).toBe(false);
  });
});
