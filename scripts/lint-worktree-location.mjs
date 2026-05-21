#!/usr/bin/env node
/**
 * lint-worktree-location.mjs — CI gate for worktree location hygiene.
 *
 * Enforces two rules per council verdict D009 (Saga T9800 SG-WORKTREE-CANON):
 *
 * RULE-1: Every git worktree (excluding the primary work tree) MUST live under
 *   `<cleoHome>/worktrees/<projectHash>/<taskId>/`. Worktrees found at the
 *   project root, sibling `/mnt/projects/*` paths, or nested inside another
 *   worktree are rejected.
 *
 * RULE-2: No directory named `worktrees` may exist under `<repo>/.cleo/`.
 *   Only the sentinel file `<repo>/.cleo/worktrees.json` is allowed; an actual
 *   directory at that path violates the in-project sentinel pattern from D009.
 *
 * Usage:
 *   node scripts/lint-worktree-location.mjs
 *   node scripts/lint-worktree-location.mjs --warn   # exit 0 even on violations
 *
 * @task T9809
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the CLEO XDG home directory (mirrors getCleoHome() at runtime). */
function getCleoHome() {
  if (process.env['CLEO_HOME']) return process.env['CLEO_HOME'];
  // XDG_DATA_HOME override (Linux standard).
  const xdgData = process.env['XDG_DATA_HOME'];
  if (xdgData) return join(xdgData, 'cleo');
  // Platform defaults.
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

/**
 * Run `git worktree list --porcelain` and return parsed entries.
 * Each entry: { worktree: string, bare: boolean, head?: string }
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
    console.error(`[lint-worktree-location] git worktree list failed: ${err.message}`);
    process.exit(1);
  }

  const entries = [];
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { worktree: line.slice('worktree '.length).trim(), bare: false };
    } else if (line === 'bare') {
      if (current) current.bare = true;
    } else if (line.startsWith('HEAD ')) {
      if (current) current.head = line.slice('HEAD '.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
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
// Main
// ---------------------------------------------------------------------------

const warnMode = process.argv.includes('--warn');
const repoRoot = findGitRoot(process.cwd());
const canonicalRoot = getCanonicalWorktreesRoot();
// Normalise: always ends with separator for prefix-matching.
const canonicalRootNorm = (
  canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`
).replaceAll('\\', '/');

const violations = [];

// RULE-1: Check git worktree paths.
const entries = listWorktrees(repoRoot);
// First entry is always the primary worktree — it is allowed to be anywhere.
for (let i = 1; i < entries.length; i++) {
  const { worktree } = entries[i];
  const norm = worktree.replaceAll('\\', '/');
  if (!norm.startsWith(canonicalRootNorm)) {
    violations.push(
      `RULE-1: git worktree at non-canonical path: "${worktree}"\n` +
        `  Expected prefix: ${canonicalRoot}\n` +
        `  Fix: run \`node scripts/migrate-rogue-worktrees.mjs\` to move it.`,
    );
  }
}

// RULE-2: No directory named `worktrees` under `<repo>/.cleo/`.
const cleoDirWorktrees = join(repoRoot, '.cleo', 'worktrees');
if (existsSync(cleoDirWorktrees)) {
  const stat = statSync(cleoDirWorktrees);
  if (stat.isDirectory()) {
    violations.push(
      `RULE-2: directory "${cleoDirWorktrees}" exists.\n` +
        `  Only the sentinel file \`.cleo/worktrees.json\` is allowed here.\n` +
        `  An actual "worktrees" directory violates the in-project sentinel pattern (D009).\n` +
        `  Fix: remove or rename the directory and migrate worktrees to the XDG location.`,
    );
  }
}

// Output results.
if (violations.length === 0) {
  console.log('[lint-worktree-location] OK — all worktrees are in canonical XDG location.');
  process.exit(0);
} else {
  const prefix = warnMode ? 'WARNING' : 'ERROR';
  console.error(`[lint-worktree-location] ${prefix}: ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    const tag = warnMode ? '::warning ::' : '::error ::';
    if (process.env['GITHUB_ACTIONS']) {
      console.error(`${tag}${v}`);
    } else {
      console.error(`  ${v}\n`);
    }
  }
  process.exit(warnMode ? 0 : 1);
}
