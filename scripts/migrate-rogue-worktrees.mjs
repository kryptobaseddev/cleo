#!/usr/bin/env node

/**
 * migrate-rogue-worktrees.mjs — Move non-canonical worktrees to XDG location.
 *
 * Per Saga T9800 SG-WORKTREE-CANON / council verdict D009 / ADR-055:
 * all git worktrees must live under `<cleoHome>/worktrees/<projectHash>/<taskId>/`.
 *
 * This script detects worktrees outside the canonical location, archives the
 * original paths, then moves them with `git worktree move`.
 *
 * Usage:
 *   node scripts/migrate-rogue-worktrees.mjs --dry-run   # preview only
 *   node scripts/migrate-rogue-worktrees.mjs             # execute migration
 *
 * Flags:
 *   --dry-run    Print plan only; make no filesystem or git changes.
 *   --no-archive Skip the .tar.gz backup step (useful in CI test environments).
 *
 * Idempotency: re-running after a partial migration is safe. Worktrees already
 * at canonical paths are skipped. The audit log is always appended, never
 * overwritten.
 *
 * @task T9809
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');
const NO_ARCHIVE = process.argv.includes('--no-archive');

if (DRY_RUN) {
  console.log('[migrate-rogue-worktrees] DRY-RUN mode — no changes will be made.\n');
}

// ---------------------------------------------------------------------------
// Path helpers (mirrors runtime implementation)
// ---------------------------------------------------------------------------

/** Resolve the CLEO XDG home directory. */
function getCleoHome() {
  if (process.env['CLEO_HOME']) return process.env['CLEO_HOME'];
  const xdgData = process.env['XDG_DATA_HOME'];
  if (xdgData) return join(xdgData, 'cleo');
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'cleo');
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return join(localAppData, 'cleo', 'Data');
  }
  return join(home, '.local', 'share', 'cleo');
}

/** Canonical worktrees root — `<cleoHome>/worktrees/`. */
function getCanonicalWorktreesRoot() {
  return join(getCleoHome(), 'worktrees');
}

/** Compute a stable 16-char project hash from an absolute project root path. */
function computeProjectHash(projectRoot) {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

/** Find the repo root by walking up from cwd until we find .git. */
function findGitRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error('Not inside a git repository');
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` output.
 * Returns array of { worktree, bare, head, branch } objects.
 */
function listWorktrees(cwd) {
  let raw;
  try {
    raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`git worktree list failed: ${err.message}`);
    process.exit(1);
  }

  const entries = [];
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { worktree: line.slice('worktree '.length).trim(), bare: false, branch: null };
    } else if (line === 'bare') {
      if (current) current.bare = true;
    } else if (line.startsWith('HEAD ')) {
      if (current) current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      if (current) current.branch = line.slice('branch '.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

// ---------------------------------------------------------------------------
// Archive helper
// ---------------------------------------------------------------------------

/**
 * Create a tar.gz archive of `sourcePath` at `archiveDest`.
 * Returns true on success, false on failure.
 */
function archivePath(sourcePath, archiveDest) {
  if (!existsSync(sourcePath)) {
    console.warn(`  [archive] source path does not exist, skipping: ${sourcePath}`);
    return false;
  }
  const parentDir = resolve(sourcePath, '..');
  const dirName = basename(sourcePath);
  const result = spawnSync('tar', ['-czf', archiveDest, '-C', parentDir, dirName], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`  [archive] tar failed (exit ${result.status}): ${result.stderr}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const repoRoot = findGitRoot(process.cwd());
const canonicalRoot = getCanonicalWorktreesRoot();
const projectHash = computeProjectHash(repoRoot);
const canonicalRootNorm = (
  canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`
).replaceAll('\\', '/');

// Audit log path.
const auditDir = join(repoRoot, '.cleo', 'audit');
const auditLog = join(auditDir, 'worktree-migration.jsonl');
// Backup dir for archives.
const backupDir = join(repoRoot, '.cleo', 'backups');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const archivePath_ = join(backupDir, `rogue-worktrees-${ts}.tar.gz`);

const entries = listWorktrees(repoRoot);
// Skip the primary worktree (index 0).
const rogues = entries.slice(1).filter(({ worktree }) => {
  const norm = worktree.replaceAll('\\', '/');
  return !norm.startsWith(canonicalRootNorm);
});

if (rogues.length === 0) {
  console.log('[migrate-rogue-worktrees] No rogue worktrees detected. Nothing to do.');
  process.exit(0);
}

console.log(`[migrate-rogue-worktrees] Found ${rogues.length} rogue worktree(s):\n`);
for (const { worktree, branch } of rogues) {
  // Derive a task-id slug from the directory name or branch name.
  const dirSlug = basename(worktree);
  // Extract task ID from branch (e.g. refs/heads/task/T1234 -> T1234) or use dirSlug.
  let taskSlug = dirSlug;
  if (branch) {
    const m = branch.match(/(?:task\/|feat\/)?(T\d+)/i);
    if (m) taskSlug = m[1];
  }
  const canonicalDest = join(canonicalRoot, projectHash, taskSlug);
  console.log(`  ${worktree}`);
  console.log(`    -> ${canonicalDest}`);
  if (branch) console.log(`    branch: ${branch}`);
  console.log('');
}

if (DRY_RUN) {
  console.log('[migrate-rogue-worktrees] DRY-RUN complete. Run without --dry-run to execute.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Execute migration
// ---------------------------------------------------------------------------

if (!NO_ARCHIVE) {
  mkdirSync(backupDir, { recursive: true });
}
mkdirSync(auditDir, { recursive: true });

let migrated = 0;
let failed = 0;

for (const { worktree, branch } of rogues) {
  const dirSlug = basename(worktree);
  let taskSlug = dirSlug;
  if (branch) {
    const m = branch.match(/(?:task\/|feat\/)?(T\d+)/i);
    if (m) taskSlug = m[1];
  }
  const canonicalDest = join(canonicalRoot, projectHash, taskSlug);

  console.log(`[migrate] ${worktree} -> ${canonicalDest}`);

  // Step (a): archive original location.
  let archiveResult = 'skipped';
  if (!NO_ARCHIVE) {
    const archived = archivePath(worktree, archivePath_);
    archiveResult = archived ? archivePath_ : 'failed';
    if (archived) {
      console.log(`  archived to ${archivePath_}`);
    } else {
      console.warn('  archive step failed — continuing with migration anyway');
    }
  }

  // Step (b): git worktree move.
  mkdirSync(resolve(canonicalDest, '..'), { recursive: true });

  // Unlock before move (git worktree move fails on locked worktrees).
  spawnSync('git', ['worktree', 'unlock', worktree], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  const moveResult = spawnSync('git', ['worktree', 'move', worktree, canonicalDest], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (moveResult.status !== 0) {
    console.error(`  [ERROR] git worktree move failed: ${moveResult.stderr?.trim()}`);
    // Step (c): log failure.
    const logEntry = JSON.stringify({
      ts: new Date().toISOString(),
      status: 'failed',
      from: worktree,
      to: canonicalDest,
      branch: branch ?? null,
      archive: archiveResult,
      error: moveResult.stderr?.trim() ?? 'unknown',
    });
    appendFileSync(auditLog, `${logEntry}\n`, 'utf8');
    failed++;
    continue;
  }

  console.log(`  moved OK`);

  // Step (c): log success.
  const logEntry = JSON.stringify({
    ts: new Date().toISOString(),
    status: 'migrated',
    from: worktree,
    to: canonicalDest,
    branch: branch ?? null,
    archive: archiveResult,
  });
  appendFileSync(auditLog, `${logEntry}\n`, 'utf8');
  migrated++;
}

console.log(`\n[migrate-rogue-worktrees] Done: ${migrated} migrated, ${failed} failed.`);
if (failed > 0) {
  console.error(`[migrate-rogue-worktrees] ${failed} failure(s) — see ${auditLog} for details.`);
  process.exit(1);
}
process.exit(0);
