/**
 * Unit tests for {@link adoptWorktree} and {@link extractBranchFromWorktree}
 * (T9804 — Claude Code Agent isolation:worktree bridge).
 *
 * Covers:
 *  - Happy path: valid gitlink worktree → sentinel entry + audit log written.
 *  - Happy path: `.git` directory (primary checkout) → branch extracted.
 *  - Idempotency: re-adopting the same path → `isNew=false`, entry updated.
 *  - Sentinel index updated: upsertSentinelEntry called with correct fields.
 *  - Audit log written: appendWorktreeAuditEntry called with `action: 'adopt'`.
 *  - Error: worktreePath does not exist → `E_WORKTREE_NOT_FOUND`.
 *  - Error: no `.git` file/dir → `E_WORKTREE_NOT_FOUND`.
 *  - Error: detached HEAD (SHA) → branch set to SHA string.
 *  - taskId extraction: `task/T1234` → `T1234`; `feat/T9804-slug` → `T9804`.
 *  - explicit taskId override wins over branch-derived taskId.
 *
 * @task T9804
 * @epic T9804
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const appendAuditCalls: Array<Parameters<typeof import('../audit.js').appendWorktreeAuditEntry>> =
  [];

vi.mock('../audit.js', () => ({
  appendWorktreeAuditEntry: vi.fn((...args) => {
    appendAuditCalls.push(
      args as Parameters<typeof import('../audit.js').appendWorktreeAuditEntry>,
    );
  }),
  resolveWorktreeAuditActor: vi.fn(() => 'test-actor'),
  WORKTREE_LIFECYCLE_AUDIT_FILE: '.cleo/audit/worktree-lifecycle.jsonl',
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { readSentinelIndex } from '../sentinel-index.js';
import { adoptWorktree, extractBranchFromWorktree, taskIdFromBranch } from '../worktree-adopt.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Create a fake git-linked worktree directory with a `.git` gitlink file. */
function createFakeLinkedWorktree(
  dir: string,
  opts: { branch: string; useDirectory?: boolean } = { branch: 'task/T9804' },
): { worktreeDir: string; adminDir: string } {
  const worktreeDir = join(dir, 'fake-worktree');
  const adminDir = join(dir, 'fake-admin');
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(adminDir, { recursive: true });

  if (opts.useDirectory) {
    // Simulate a primary checkout with a real `.git` directory
    const gitDir = join(worktreeDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${opts.branch}\n`);
  } else {
    // Simulate a linked worktree with a `.git` FILE
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, 'HEAD'), `ref: refs/heads/${opts.branch}\n`);
  }

  return { worktreeDir, adminDir };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('adoptWorktree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-adopt-test-'));
    appendAuditCalls.length = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: linked worktree → sentinel entry + audit log written', async () => {
    const { worktreeDir } = createFakeLinkedWorktree(tmpDir, { branch: 'task/T9804' });
    const sentinelIndexPath = join(tmpDir, 'worktrees.json');

    const result = await adoptWorktree({
      worktreePath: worktreeDir,
      projectRoot: tmpDir,
      source: 'claude-agent',
      sentinelIndexPath,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.path).toBe(worktreeDir);
    expect(result.data.branch).toBe('task/T9804');
    expect(result.data.taskId).toBe('T9804');
    expect(result.data.source).toBe('claude-agent');
    expect(result.data.isNew).toBe(true);
    expect(result.data.adoptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Sentinel index should contain the entry
    const entries = readSentinelIndex(tmpDir, sentinelIndexPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: worktreeDir,
      branch: 'task/T9804',
      taskId: 'T9804',
      source: 'claude-agent',
    });

    // Audit log should have been written
    expect(appendAuditCalls).toHaveLength(1);
    const [, auditEntry] = appendAuditCalls[0]!;
    expect(auditEntry.action).toBe('adopt');
    expect(auditEntry.target).toBe(worktreeDir);
    expect(auditEntry.branch).toBe('task/T9804');
    expect(auditEntry.taskId).toBe('T9804');
    expect(auditEntry.success).toBe(true);
  });

  it('happy path: primary checkout with .git directory', async () => {
    const { worktreeDir } = createFakeLinkedWorktree(tmpDir, {
      branch: 'feat/T9804-isolation-bridge',
      useDirectory: true,
    });
    const sentinelIndexPath = join(tmpDir, 'worktrees.json');

    const result = await adoptWorktree({
      worktreePath: worktreeDir,
      projectRoot: tmpDir,
      source: 'manual',
      sentinelIndexPath,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.branch).toBe('feat/T9804-isolation-bridge');
    expect(result.data.taskId).toBe('T9804');
    expect(result.data.source).toBe('manual');
  });

  it('idempotency: re-adopting the same path returns isNew=false + updates entry', async () => {
    const { worktreeDir } = createFakeLinkedWorktree(tmpDir, { branch: 'task/T9804' });
    const sentinelIndexPath = join(tmpDir, 'worktrees.json');

    // First adopt
    const first = await adoptWorktree({
      worktreePath: worktreeDir,
      projectRoot: tmpDir,
      sentinelIndexPath,
    });
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.isNew).toBe(true);

    // Second adopt — same path
    const second = await adoptWorktree({
      worktreePath: worktreeDir,
      projectRoot: tmpDir,
      source: 'manual', // update source
      sentinelIndexPath,
    });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.isNew).toBe(false);

    // Sentinel index should still have only ONE entry (upserted, not duplicated)
    const entries = readSentinelIndex(tmpDir, sentinelIndexPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('manual'); // updated
  });

  it('explicit taskId override wins over branch-derived taskId', async () => {
    const { worktreeDir } = createFakeLinkedWorktree(tmpDir, { branch: 'feature/something' });
    const sentinelIndexPath = join(tmpDir, 'worktrees.json');

    const result = await adoptWorktree({
      worktreePath: worktreeDir,
      projectRoot: tmpDir,
      taskId: 'T9999',
      sentinelIndexPath,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.taskId).toBe('T9999');
  });

  it('error: worktreePath does not exist', async () => {
    const result = await adoptWorktree({
      worktreePath: join(tmpDir, 'nonexistent'),
      projectRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_WORKTREE_NOT_FOUND');
  });

  it('error: path exists but has no .git file or directory', async () => {
    const noGit = join(tmpDir, 'no-git');
    mkdirSync(noGit);

    const result = await adoptWorktree({
      worktreePath: noGit,
      projectRoot: tmpDir,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_WORKTREE_NOT_FOUND');
    expect(result.error.message).toMatch(/Cannot read branch/);
  });

  it('detached HEAD (SHA) → branch set to SHA string', async () => {
    const worktreeDir = join(tmpDir, 'detached');
    const adminDir = join(tmpDir, 'detached-admin');
    mkdirSync(worktreeDir);
    mkdirSync(adminDir);
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${adminDir}\n`);
    // Write a 40-char SHA as the detached HEAD
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    writeFileSync(join(adminDir, 'HEAD'), `${sha}\n`);
    const sentinelIndexPath = join(tmpDir, 'worktrees.json');

    const result = await adoptWorktree({
      worktreePath: worktreeDir,
      projectRoot: tmpDir,
      sentinelIndexPath,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.branch).toBe(sha);
    expect(result.data.taskId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractBranchFromWorktree unit tests
// ---------------------------------------------------------------------------

describe('extractBranchFromWorktree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-extract-branch-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gitlink file → correct branch extracted', () => {
    const wtDir = join(tmpDir, 'wt');
    const adminDir = join(tmpDir, 'admin');
    mkdirSync(wtDir);
    mkdirSync(adminDir);
    writeFileSync(join(wtDir, '.git'), `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, 'HEAD'), 'ref: refs/heads/task/T1234\n');

    const res = extractBranchFromWorktree(wtDir);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.branch).toBe('task/T1234');
  });

  it('.git directory (primary checkout) → correct branch extracted', () => {
    const wtDir = join(tmpDir, 'primary');
    const gitDir = join(wtDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const res = extractBranchFromWorktree(wtDir);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.branch).toBe('main');
  });

  it('missing .git → failure', () => {
    const wtDir = join(tmpDir, 'no-git');
    mkdirSync(wtDir);

    const res = extractBranchFromWorktree(wtDir);
    expect(res.success).toBe(false);
  });

  it('detached HEAD SHA → returned as branch', () => {
    const wtDir = join(tmpDir, 'detached');
    const adminDir = join(tmpDir, 'detached-admin');
    mkdirSync(wtDir);
    mkdirSync(adminDir);
    const sha = 'deadbeefdeadbeef1234567890abcdef12345678';
    writeFileSync(join(wtDir, '.git'), `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, 'HEAD'), `${sha}\n`);

    const res = extractBranchFromWorktree(wtDir);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.branch).toBe(sha);
  });
});

// ---------------------------------------------------------------------------
// taskIdFromBranch unit tests
// ---------------------------------------------------------------------------

describe('taskIdFromBranch', () => {
  it.each([
    ['task/T1234', 'T1234'],
    ['task/T9804', 'T9804'],
    ['feat/T9804-some-slug', 'T9804'],
    ['feat/T9804', 'T9804'],
    ['feature/something', null],
    ['main', null],
    ['HEAD', null],
    ['', null],
  ])('%s → %s', (branch, expected) => {
    expect(taskIdFromBranch(branch)).toBe(expected);
  });
});
