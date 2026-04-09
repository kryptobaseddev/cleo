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
 * execSync usage mirrors worktree.test.ts — inputs are all literal strings.
 *
 * @task T406
 * @task T380
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorktree,
  mergeWorktree,
} from '../src/worktree.js';
import type { WorktreeConfig, WorktreeRequest } from '../src/worktree.js';

let tempDir: string;
let gitRoot: string;
let worktreeRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cleo-w9-'));
  gitRoot = join(tempDir, 'repo');
  worktreeRoot = join(tempDir, 'worktrees');

  execSync(
    [
      `mkdir -p "${gitRoot}"`,
      `cd "${gitRoot}"`,
      'git init',
      'git config user.email "test@cleo.dev"',
      'git config user.name "CLEO W9 Test"',
      'echo "initial" > README.md',
      'git add README.md',
      'git commit -m "init"',
    ].join(' && '),
    { stdio: 'pipe' },
  );
});

afterEach(() => {
  try {
    execSync('git worktree prune', { cwd: gitRoot, stdio: 'pipe' });
  } catch {
    // best effort
  }
  rmSync(tempDir, { recursive: true, force: true });
});

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
    execSync(
      [
        `cd "${h.path}"`,
        'git add feature.txt',
        'git commit -m "worker-1 output"',
      ].join(' && '),
      { stdio: 'pipe' },
    );

    const result = mergeWorktree(h, config, { strategy: 'ff-only' });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(existsSync(h.path)).toBe(false);

    const log = execSync('git log --oneline -1', { cwd: gitRoot, encoding: 'utf-8' });
    expect(log).toContain('worker-1 output');
  });

  it('retains worktree-2 on ff-merge failure for forensic inspection (T403)', () => {
    const config = testConfig();
    const h = createWorktree(testRequest('T-W9-conflict'), config);

    // Advance main repo so ff-only will fail.
    writeFileSync(join(gitRoot, 'diverged.txt'), 'main-repo diverged');
    execSync(
      [
        `cd "${gitRoot}"`,
        'git add diverged.txt',
        'git commit -m "main diverged"',
      ].join(' && '),
      { stdio: 'pipe' },
    );

    writeFileSync(join(h.path, 'worker-output.txt'), 'conflict worker output');
    execSync(
      [
        `cd "${h.path}"`,
        'git add worker-output.txt',
        'git commit -m "worker-2 output"',
      ].join(' && '),
      { stdio: 'pipe' },
    );

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
