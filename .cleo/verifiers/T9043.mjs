#!/usr/bin/env node
/**
 * Verifier for T9043: BUG — Worktree + temp-dir cleanup incomplete.
 *
 * AC:
 *   - packages/core/src/gc/cleanup.ts exists with CLEO_TEMP_PREFIXES registry
 *   - branch-lock.ts has post-merge worktree cleanup (worktree remove after merge)
 *   - packages/cleo/src/cli/commands/gc.ts exists (cleo gc worktrees+temp subcommands)
 *   - doctor checks has orphan audit
 *
 * NEGATIVE SPACE: CLEO_TEMP_PREFIXES must have > 1 prefix (not just one hardcoded pattern)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

function readFile(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Check 1: gc/cleanup.ts exists with CLEO_TEMP_PREFIXES
// ---------------------------------------------------------------------------
const cleanupPath = 'packages/core/src/gc/cleanup.ts';
if (existsSync(join(REPO_ROOT, cleanupPath))) {
  const cleanup = readFile(cleanupPath);

  if (cleanup.includes('CLEO_TEMP_PREFIXES')) {
    pass('gc/cleanup.ts has CLEO_TEMP_PREFIXES registry');

    // Extract prefix count — must be more than 1 (the original bug was only 1 pattern)
    // Match from the array literal opening bracket to the closing bracket
    const prefixBlock = cleanup.match(/CLEO_TEMP_PREFIXES[^=]*=\s*\[([\s\S]*?)\];/);
    if (prefixBlock) {
      const prefixStrings = prefixBlock[1].match(/'cleo-[^']+'/g) || [];
      if (prefixStrings.length >= 2) {
        pass(
          `CLEO_TEMP_PREFIXES has ${prefixStrings.length} prefixes (covers multiple CLEO-generated patterns)`,
        );
      } else {
        fail(
          `CLEO_TEMP_PREFIXES only has ${prefixStrings.length} prefix(es) — must cover multiple CLEO temp dir patterns (T9043)`,
        );
      }
    } else {
      fail('Could not extract CLEO_TEMP_PREFIXES array contents from cleanup.ts');
    }
  } else {
    fail('gc/cleanup.ts missing CLEO_TEMP_PREFIXES registry (T9043)');
  }

  // Check for orphan audit functionality
  if (cleanup.includes('orphan') || cleanup.includes('Orphan')) {
    pass('gc/cleanup.ts has orphan audit logic');
  } else {
    fail('gc/cleanup.ts missing orphan audit logic (T9043)');
  }
} else {
  fail(`${cleanupPath} does not exist (T9043 not implemented)`);
}

// ---------------------------------------------------------------------------
// Check 2: branch-lock.ts has post-merge worktree cleanup
// ---------------------------------------------------------------------------
const branchLock = readFile('packages/core/src/spawn/branch-lock.ts');
if (branchLock.includes('worktree') && branchLock.includes("worktree', 'remove'")) {
  pass('branch-lock.ts has git worktree remove for cleanup');
} else {
  fail('branch-lock.ts missing git worktree remove calls (post-merge cleanup, T9043)');
}

// Check that completeAgentWorktreeViaMerge exists (ADR-062 merge function)
if (branchLock.includes('completeAgentWorktreeViaMerge')) {
  pass('branch-lock.ts has completeAgentWorktreeViaMerge (ADR-062 merge + cleanup)');
} else {
  fail('branch-lock.ts missing completeAgentWorktreeViaMerge function (ADR-062, T9043)');
}

// ---------------------------------------------------------------------------
// Check 3: cleo gc.ts command exists
// ---------------------------------------------------------------------------
const gcPath = 'packages/cleo/src/cli/commands/gc.ts';
if (existsSync(join(REPO_ROOT, gcPath))) {
  const gc = readFile(gcPath);
  pass('packages/cleo/src/cli/commands/gc.ts exists');

  if (gc.includes('worktree') && gc.includes('temp')) {
    pass('gc.ts covers both worktrees and temp-dir cleanup subcommands');
  } else {
    fail('gc.ts missing worktree or temp subcommand (T9043 — must cover both)');
  }
} else {
  fail(`${gcPath} does not exist (T9043 — cleo gc command not implemented)`);
}

// ---------------------------------------------------------------------------
// Check 4: doctor checks has orphan audit
// ---------------------------------------------------------------------------
const doctorChecks = readFile('packages/core/src/validation/doctor/checks.ts');
if (doctorChecks.includes('orphan') || doctorChecks.includes('worktree')) {
  pass('doctor/checks.ts has orphan/worktree audit check');
} else {
  fail('doctor/checks.ts missing orphan audit for worktrees (T9043)');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(
    '\nVERIFIER PASS: T9043 — worktree + temp-dir cleanup implemented with CLEO_TEMP_PREFIXES',
  );
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
