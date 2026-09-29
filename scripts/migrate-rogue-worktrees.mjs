#!/usr/bin/env node

/**
 * migrate-rogue-worktrees.mjs — Move non-canonical worktrees to XDG location.
 *
 * Per Saga T9800 SG-WORKTREE-CANON / council verdict D009 / ADR-055:
 * all git worktrees must live under `<cleoHome>/worktrees/<projectHash>/<taskId>/`.
 *
 * This is a MANUAL, OWNER-INVOKED REPAIR — not a gate and not a check. It
 * detects worktrees outside the canonical location and, only with `--apply`,
 * archives the original paths and moves them with `git worktree move`.
 *
 * Usage:
 *   node scripts/migrate-rogue-worktrees.mjs              # dry-run (default)
 *   node scripts/migrate-rogue-worktrees.mjs --dry-run    # dry-run (explicit)
 *   node scripts/migrate-rogue-worktrees.mjs --apply      # execute migration
 *
 * Flags:
 *   --dry-run       Print the plan only; make no filesystem or git changes (default).
 *   --apply         Archive and move eligible worktrees.
 *   --no-archive    Skip the .tar.gz backup step (useful in test environments).
 *   --force-unused  When in-use detection is UNAVAILABLE on this host, treat
 *                   worktrees as unused. It never overrides a lock or a
 *                   detected in-use process.
 *   -h, --help      Print usage and exit 0.
 *
 * Any other argument (including `--check`) is refused with exit 2 before any
 * git or filesystem action (T12725).
 *
 * Safety (T12725): a worktree is NEVER unlocked or moved when
 *   - it is locked (a `locked` line in `git worktree list --porcelain`), or
 *   - a running process has its cwd inside it (probed via /proc on Linux,
 *     `lsof -d cwd` elsewhere), or
 *   - in-use detection is unavailable and `--force-unused` was not passed.
 * Skipped worktrees are reported with the reason.
 *
 * Idempotency: re-running after a partial migration is safe. Worktrees already
 * at canonical paths are skipped. The audit log is always appended, never
 * overwritten.
 *
 * @task T9809
 * @task T12725
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// CLI flags (T12725: strict — unknown flags are refused before any action)
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/migrate-rogue-worktrees.mjs [--dry-run | --apply] [--no-archive] [--force-unused]

Manual, owner-invoked repair (not a gate): moves git worktrees that live
outside <cleoHome>/worktrees/<projectHash>/ into the canonical location.

  --dry-run       Print the plan only (default).
  --apply         Archive and move eligible worktrees.
  --no-archive    Skip the .tar.gz backup step.
  --force-unused  Treat worktrees as unused when in-use detection is unavailable.
  -h, --help      Show this message.

Locked or in-use worktrees are never unlocked or moved.`;

const KNOWN_FLAGS = new Set([
  '--dry-run',
  '--apply',
  '--no-archive',
  '--force-unused',
  '--help',
  '-h',
]);
const argv = process.argv.slice(2);
const unknownArgs = argv.filter((a) => !KNOWN_FLAGS.has(a));
if (unknownArgs.length > 0) {
  console.error(`[migrate-rogue-worktrees] ERROR: unknown argument(s): ${unknownArgs.join(' ')}\n`);
  console.error(USAGE);
  process.exit(2);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (argv.includes('--apply') && argv.includes('--dry-run')) {
  console.error('[migrate-rogue-worktrees] ERROR: --apply and --dry-run are mutually exclusive.\n');
  console.error(USAGE);
  process.exit(2);
}

const APPLY = argv.includes('--apply');
const DRY_RUN = !APPLY;
const NO_ARCHIVE = argv.includes('--no-archive');
const FORCE_UNUSED = argv.includes('--force-unused');

if (DRY_RUN) {
  console.log('[migrate-rogue-worktrees] DRY-RUN mode (default) — no changes will be made.\n');
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

/** Resolve symlinks when possible so path comparisons match what the OS reports. */
function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True when `child` equals `parent` or lies beneath it. */
function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` output.
 * Returns array of { worktree, bare, head, branch, locked, lockReason } objects.
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
      current = {
        worktree: line.slice('worktree '.length).trim(),
        bare: false,
        branch: null,
        locked: false,
        lockReason: null,
      };
    } else if (line === 'bare') {
      if (current) current.bare = true;
    } else if (line.startsWith('HEAD ')) {
      if (current) current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      if (current) current.branch = line.slice('branch '.length).trim();
    } else if (line === 'locked' || line.startsWith('locked ')) {
      if (current) {
        current.locked = true;
        const reason = line.slice('locked'.length).trim();
        current.lockReason = reason.length > 0 ? reason : null;
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

// ---------------------------------------------------------------------------
// In-use detection (T12725)
// ---------------------------------------------------------------------------

/**
 * Collect the working directories of running processes.
 *
 * Returns `{ available: true, cwds: Array<{ pid, cwd }> }` when a probe
 * worked, or `{ available: false, why }` when this host offers no way to
 * tell. Callers MUST treat "unavailable" as "in use" unless the owner passed
 * `--force-unused`.
 *
 * `MIGRATE_ROGUE_WORKTREES_NO_INUSE_PROBE=1` simulates an unavailable probe
 * (tests only).
 */
function collectProcessCwds() {
  if (process.env['MIGRATE_ROGUE_WORKTREES_NO_INUSE_PROBE'] === '1') {
    return { available: false, why: 'in-use probe disabled by environment' };
  }

  // Linux: /proc/<pid>/cwd.
  if (process.platform === 'linux' && existsSync('/proc/self/cwd')) {
    const cwds = [];
    let pids;
    try {
      pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    } catch {
      pids = null;
    }
    if (pids) {
      for (const pid of pids) {
        try {
          cwds.push({ pid, cwd: readlinkSync(`/proc/${pid}/cwd`) });
        } catch {
          // Process exited or belongs to another user — not readable.
        }
      }
      return { available: true, cwds };
    }
  }

  // Elsewhere: lsof, restricted to cwd descriptors.
  const res = spawnSync('lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || typeof res.stdout !== 'string' || res.stdout.length === 0) {
    const why = res.error ? `lsof unavailable (${res.error.message})` : 'lsof returned no output';
    return { available: false, why };
  }
  const cwds = [];
  let pid = null;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('n') && pid !== null) cwds.push({ pid, cwd: line.slice(1) });
  }
  return { available: true, cwds };
}

/**
 * Decide whether `worktree` may be touched. Returns null when it is safe to
 * move, or a human-readable skip reason.
 */
function skipReason(entry, probe) {
  if (entry.locked) {
    return `locked${entry.lockReason ? ` (${entry.lockReason})` : ''}`;
  }
  if (!probe.available) {
    if (FORCE_UNUSED) return null;
    return `in-use detection unavailable (${probe.why}); pass --force-unused to override`;
  }
  const wt = realOrSelf(entry.worktree);
  const users = probe.cwds.filter(({ cwd }) => isInside(realOrSelf(cwd), wt));
  if (users.length > 0) {
    const pids = [...new Set(users.map((u) => u.pid))].slice(0, 5).join(', ');
    return `in use (process cwd inside worktree; pid ${pids})`;
  }
  return null;
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

/** Derive the canonical destination for a rogue worktree. */
function canonicalDestFor({ worktree, branch }) {
  let taskSlug = basename(worktree);
  if (branch) {
    // e.g. refs/heads/task/T1234 -> T1234
    const m = branch.match(/(?:task\/|feat\/)?(T\d+)/i);
    if (m) taskSlug = m[1];
  }
  return join(canonicalRoot, projectHash, taskSlug);
}

const probe = collectProcessCwds();
const plan = rogues.map((entry) => ({
  entry,
  dest: canonicalDestFor(entry),
  skip: skipReason(entry, probe),
}));

console.log(`[migrate-rogue-worktrees] Found ${rogues.length} rogue worktree(s):\n`);
for (const { entry, dest, skip } of plan) {
  console.log(`  ${entry.worktree}`);
  if (skip) console.log(`    SKIP: ${skip}`);
  else console.log(`    -> ${dest}`);
  if (entry.branch) console.log(`    branch: ${entry.branch}`);
  console.log('');
}

const eligible = plan.filter((p) => p.skip === null);
const skipped = plan.filter((p) => p.skip !== null);

if (DRY_RUN) {
  console.log(
    `[migrate-rogue-worktrees] DRY-RUN complete: ${eligible.length} eligible, ${skipped.length} skipped. ` +
      'Nothing was moved. Re-run with --apply to move the eligible worktrees.',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Execute migration (--apply only)
// ---------------------------------------------------------------------------

mkdirSync(auditDir, { recursive: true });

for (const { entry, skip } of skipped) {
  console.log(`[skip] ${entry.worktree}: ${skip}`);
  const logEntry = JSON.stringify({
    ts: new Date().toISOString(),
    status: 'skipped',
    from: entry.worktree,
    branch: entry.branch ?? null,
    reason: skip,
  });
  appendFileSync(auditLog, `${logEntry}\n`, 'utf8');
}

if (!NO_ARCHIVE && eligible.length > 0) {
  mkdirSync(backupDir, { recursive: true });
}

let migrated = 0;
let failed = 0;

for (const { entry, dest } of eligible) {
  const { worktree, branch } = entry;
  console.log(`[migrate] ${worktree} -> ${dest}`);

  // Step (a): archive original location (one archive per worktree).
  let archiveResult = 'skipped';
  if (!NO_ARCHIVE) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDest = join(backupDir, `rogue-worktree-${basename(worktree)}-${ts}.tar.gz`);
    const archived = archivePath(worktree, archiveDest);
    archiveResult = archived ? archiveDest : 'failed';
    if (archived) {
      console.log(`  archived to ${archiveDest}`);
    } else {
      console.warn('  archive step failed — continuing with migration anyway');
    }
  }

  // Step (b): git worktree move. The worktree is known to be unlocked; it is
  // never unlocked here (T12725) — a lock means someone is using it.
  mkdirSync(resolve(dest, '..'), { recursive: true });

  const moveResult = spawnSync('git', ['worktree', 'move', worktree, dest], {
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
      to: dest,
      branch: branch ?? null,
      archive: archiveResult,
      error: moveResult.stderr?.trim() ?? 'unknown',
    });
    appendFileSync(auditLog, `${logEntry}\n`, 'utf8');
    failed++;
    continue;
  }

  console.log('  moved OK');

  // Step (c): log success.
  const logEntry = JSON.stringify({
    ts: new Date().toISOString(),
    status: 'migrated',
    from: worktree,
    to: dest,
    branch: branch ?? null,
    archive: archiveResult,
  });
  appendFileSync(auditLog, `${logEntry}\n`, 'utf8');
  migrated++;
}

console.log(
  `\n[migrate-rogue-worktrees] Done: ${migrated} migrated, ${skipped.length} skipped, ${failed} failed.`,
);
if (failed > 0) {
  console.error(`[migrate-rogue-worktrees] ${failed} failure(s) — see ${auditLog} for details.`);
  process.exit(1);
}
process.exit(0);
