/**
 * Tests for worktree-orphan scan + prune (T9790).
 *
 * Covers:
 *   - scanWorktreeOrphans walks `.claude/worktrees/` and discovers
 *     orphans nested 1 and 2 levels deep
 *   - Empty / non-existent roots return [] (not an error)
 *   - isFullDuplicate flag set when adrs/agent-outputs/etc. are present
 *   - pruneWorktreeOrphans dry-run leaves filesystem and audit log untouched
 *   - pruneWorktreeOrphans writes a tar.gz archive, appends audit-log line
 *     per entry, then removes the orphan directories
 *   - Idempotency: a second prune call with the same input returns
 *     rejected entries (path-not-found) because step 1 was a no-op
 *   - SECURITY: orphanPath outside `<projectRoot>/.claude/worktrees/` is
 *     rejected without unlink
 *
 * Uses real tmp directories (mkdtemp). No mocked filesystem.
 *
 * @task T9790
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneWorktreeOrphans, scanWorktreeOrphans } from '../worktree-orphans.js';

let tmpRoot: string;
let projectRoot: string;
let worktreesRoot: string;
let archiveDir: string;
let auditLogPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-doctor-orphans-'));
  projectRoot = join(tmpRoot, 'fake-project');
  worktreesRoot = join(projectRoot, '.claude', 'worktrees');
  archiveDir = join(projectRoot, '.cleo', 'backups');
  auditLogPath = join(projectRoot, '.cleo', 'audit', 'worktree-prune.jsonl');
  mkdirSync(worktreesRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Materialize a synthetic orphan layout matching the cleocode damage:
 *   - .claude/worktrees/agent-A/.cleo/tasks.db                (depth-1 orphan)
 *   - .claude/worktrees/agent-B/T9220/.cleo/tasks.db          (depth-2 orphan)
 *   - .claude/worktrees/agent-C/.cleo/{adrs, agent-outputs}/  (full-duplicate orphan)
 */
function seedOrphans(): { depth1: string; depth2: string; fullDup: string } {
  const depth1 = join(worktreesRoot, 'agent-A', '.cleo');
  mkdirSync(depth1, { recursive: true });
  writeFileSync(join(depth1, 'tasks.db'), 'fake-sqlite-bytes');

  const depth2 = join(worktreesRoot, 'agent-B', 'T9220', '.cleo');
  mkdirSync(depth2, { recursive: true });
  writeFileSync(join(depth2, 'tasks.db'), 'fake-sqlite-bytes');
  writeFileSync(join(depth2, 'brain.db'), 'fake-brain-bytes');

  const fullDup = join(worktreesRoot, 'agent-C', '.cleo');
  mkdirSync(join(fullDup, 'adrs'), { recursive: true });
  mkdirSync(join(fullDup, 'agent-outputs'), { recursive: true });
  writeFileSync(join(fullDup, 'adrs', 'ADR-001.md'), '# fake ADR');
  writeFileSync(join(fullDup, 'agent-outputs', 'output.md'), '# fake output');
  writeFileSync(join(fullDup, 'tasks.db'), 'fake-sqlite');

  return { depth1, depth2, fullDup };
}

describe('scanWorktreeOrphans', () => {
  it('returns [] when .claude/worktrees/ does not exist', async () => {
    rmSync(worktreesRoot, { recursive: true, force: true });
    const result = await scanWorktreeOrphans(projectRoot);
    expect(result).toEqual([]);
  });

  it('returns [] when worktrees root is empty', async () => {
    const result = await scanWorktreeOrphans(projectRoot);
    expect(result).toEqual([]);
  });

  it('discovers depth-1 and depth-2 orphans, sorted by path', async () => {
    const { depth1, depth2 } = seedOrphans();
    const result = await scanWorktreeOrphans(projectRoot);

    const paths = result.map((r) => r.orphanPath);
    expect(paths).toContain(depth1);
    expect(paths).toContain(depth2);
    // Sorted ascending.
    expect(paths).toEqual([...paths].sort());
  });

  it('populates dbFiles, sizeBytes, ageSeconds, and lastModifiedAt', async () => {
    const { depth1 } = seedOrphans();
    const result = await scanWorktreeOrphans(projectRoot);

    const entry = result.find((r) => r.orphanPath === depth1);
    expect(entry).toBeDefined();
    if (!entry) throw new Error('orphan not found');
    expect(entry.dbFiles).toContain(join(depth1, 'tasks.db'));
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(entry.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(() => new Date(entry.lastModifiedAt).toISOString()).not.toThrow();
    // The worktreePath is the top-level directory under worktrees/, not the orphan itself.
    expect(entry.worktreePath).toBe(join(worktreesRoot, 'agent-A'));
  });

  it('flags isFullDuplicate when adrs/agent-outputs are present', async () => {
    const { fullDup } = seedOrphans();
    const result = await scanWorktreeOrphans(projectRoot);
    const entry = result.find((r) => r.orphanPath === fullDup);
    expect(entry?.isFullDuplicate).toBe(true);

    const plain = result.find((r) => r.orphanPath.endsWith(join('agent-A', '.cleo')));
    expect(plain?.isFullDuplicate).toBe(false);
  });
});

describe('pruneWorktreeOrphans — dry run', () => {
  it('does not touch the filesystem or audit log', async () => {
    const { depth1 } = seedOrphans();
    const entries = await scanWorktreeOrphans(projectRoot);

    const result = await pruneWorktreeOrphans(entries, {
      archiveDir,
      auditLogPath,
      dryRun: true,
      projectRoot,
    });

    expect(result.dryRun).toBe(true);
    expect(result.archivePath).toBeNull();
    expect(result.pruned.length).toBe(entries.length);
    expect(result.rejected).toEqual([]);

    // Filesystem untouched.
    expect(existsSync(depth1)).toBe(true);
    // No archive directory created.
    expect(existsSync(archiveDir)).toBe(false);
    // No audit log written.
    expect(existsSync(auditLogPath)).toBe(false);
  });
});

describe('pruneWorktreeOrphans — apply', () => {
  it('archives, writes audit-log line per entry, and removes orphans', async () => {
    const { depth1, depth2, fullDup } = seedOrphans();
    const entries = await scanWorktreeOrphans(projectRoot);
    expect(entries.length).toBeGreaterThanOrEqual(3);

    const result = await pruneWorktreeOrphans(entries, {
      archiveDir,
      auditLogPath,
      projectRoot,
    });

    expect(result.dryRun).toBe(false);
    expect(result.archivePath).not.toBeNull();
    if (!result.archivePath) throw new Error('archivePath missing');
    expect(existsSync(result.archivePath)).toBe(true);
    expect(result.totalSizeBytes).toBeGreaterThan(0);

    // The tarball is a real gzip stream and lists our orphans.
    const list = spawnSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    const listing = list.stdout;
    expect(listing).toContain('.claude/worktrees/agent-A/.cleo/');
    expect(listing).toContain('.claude/worktrees/agent-B/T9220/.cleo/');

    // Orphans removed from disk.
    expect(existsSync(depth1)).toBe(false);
    expect(existsSync(depth2)).toBe(false);
    expect(existsSync(fullDup)).toBe(false);

    // One audit-log line per pruned entry.
    expect(existsSync(auditLogPath)).toBe(true);
    const lines = readFileSync(auditLogPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(result.pruned.length);
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        action: string;
        agent: string;
        dryRun: boolean;
        archivePath: string;
        orphanPath: string;
        worktreePath: string;
        sizeBytes: number;
        dbFileCount: number;
        timestamp: string;
      };
      expect(parsed.action).toBe('prune-worktree-orphan');
      expect(parsed.agent).toBe('cleo');
      expect(parsed.dryRun).toBe(false);
      expect(parsed.archivePath).toBe(result.archivePath);
      expect(parsed.orphanPath.startsWith(worktreesRoot + sep)).toBe(true);
    }
  });

  it('is idempotent — a second prune with the same input returns path-not-found rejections', async () => {
    seedOrphans();
    const entries = await scanWorktreeOrphans(projectRoot);
    const first = await pruneWorktreeOrphans(entries, {
      archiveDir,
      auditLogPath,
      projectRoot,
    });
    expect(first.pruned.length).toBeGreaterThan(0);

    const second = await pruneWorktreeOrphans(entries, {
      archiveDir,
      auditLogPath,
      projectRoot,
    });
    expect(second.pruned).toEqual([]);
    expect(second.rejected.length).toBe(entries.length);
    for (const r of second.rejected) {
      expect(r.reason).toBe('path-not-found');
    }
  });
});

describe('pruneWorktreeOrphans — security', () => {
  it('rejects orphans whose path is outside <projectRoot>/.claude/worktrees/', async () => {
    seedOrphans();
    const legitimate = await scanWorktreeOrphans(projectRoot);

    // Craft a hostile entry pointing outside the worktrees root.
    const escapeRoot = join(tmpRoot, 'outside-cleo');
    mkdirSync(escapeRoot, { recursive: true });
    writeFileSync(join(escapeRoot, 'tasks.db'), 'real-db');

    const hostile = {
      worktreePath: join(worktreesRoot, 'agent-A'),
      orphanPath: escapeRoot,
      dbFiles: [join(escapeRoot, 'tasks.db')],
      sizeBytes: 1,
      lastModifiedAt: new Date().toISOString(),
      ageSeconds: 0,
      isFullDuplicate: false,
    };

    const result = await pruneWorktreeOrphans([hostile, ...legitimate], {
      archiveDir,
      auditLogPath,
      projectRoot,
    });

    // Hostile entry rejected, legitimate entries pruned.
    expect(result.rejected.some((r) => r.entry.orphanPath === escapeRoot)).toBe(true);
    expect(result.rejected.find((r) => r.entry.orphanPath === escapeRoot)?.reason).toBe(
      'path-outside-worktrees-root',
    );
    // External directory NOT touched.
    expect(existsSync(escapeRoot)).toBe(true);
    expect(existsSync(join(escapeRoot, 'tasks.db'))).toBe(true);
  });
});
