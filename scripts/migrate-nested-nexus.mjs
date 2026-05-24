#!/usr/bin/env node

/**
 * migrate-nested-nexus.mjs — Delete the nested `~/.local/share/cleo/nexus/`
 * subdirectory and its DB / sidecar / sidecar-bak debris.
 *
 * Per ADR-086 (Nested-Nexus Disposition — BAN), Saga T10281
 * SG-BRAIN-DB-RESILIENCE / Epic T10285 E4-DB-CROSS-LINKS / T10321: the
 * canonical CLEO global-tier layout is FLAT. The nested subdirectory at
 * `$XDG_DATA_HOME/cleo/nexus/` is migration debris left by an incomplete
 * 2026-04-28 layout flattening. It MUST NOT exist on post-T10321 installs.
 *
 * This script deletes the following allowlisted files only:
 *
 *   <cleoHome>/nexus/nexus.db
 *   <cleoHome>/nexus/nexus.db-shm
 *   <cleoHome>/nexus/nexus.db-wal
 *   <cleoHome>/nexus/nexus-pre-cleo.db.bak
 *   <cleoHome>/nexus/signaldock.db
 *   <cleoHome>/nexus/signaldock.db-shm
 *   <cleoHome>/nexus/signaldock.db-wal
 *   <cleoHome>/nexus/signaldock-pre-cleo.db.bak
 *   <cleoHome>/nexus/global-salt        (only if directory is otherwise empty after sweep)
 *   <cleoHome>/nexus/cache              (only if otherwise empty after sweep)
 *
 * The nested directory itself is removed via rmdir() after the contents
 * are gone. The parent `<cleoHome>/` and every flat-tier sibling
 * (`nexus.db`, `signaldock.db`, ...) are NEVER touched.
 *
 * Defence-in-depth: any file under the nested directory that does NOT
 * appear in the explicit allowlist is reported as "unexpected" and left
 * untouched — manual review required before re-running.
 *
 * Usage:
 *   node scripts/migrate-nested-nexus.mjs --dry-run    # preview only
 *   node scripts/migrate-nested-nexus.mjs              # interactive (prompts y/N)
 *   node scripts/migrate-nested-nexus.mjs --no-confirm # auto-confirm (CI / scripted)
 *
 * Flags:
 *   --dry-run     Print plan only; no filesystem mutations.
 *   --no-confirm  Skip the interactive y/N prompt; proceed directly.
 *   --cleo-home   Override `getCleoHome()` (test harnesses only).
 *
 * Idempotency: safe to re-run. If the nested directory does not exist
 * the script reports a no-op and exits 0. Partial states (some files
 * already deleted) are handled per-file.
 *
 * Exit codes:
 *   0  - success (including no-op + dry-run)
 *   1  - unexpected files refused deletion; manual review needed
 *   2  - I/O error during deletion
 *   3  - user declined the interactive prompt
 *
 * @task T10321
 * @adr ADR-086
 */

import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');
const NO_CONFIRM = process.argv.includes('--no-confirm');

/** Parse `--cleo-home <path>` if provided (test harnesses). */
function parseCleoHomeOverride() {
  const idx = process.argv.indexOf('--cleo-home');
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith('--')) {
    throw new Error('--cleo-home requires an absolute path argument');
  }
  return next;
}

// ---------------------------------------------------------------------------
// Path helpers (mirrors @cleocode/paths runtime resolution)
// ---------------------------------------------------------------------------

/** Resolve the canonical CLEO XDG data home. */
function resolveCleoHome() {
  const override = parseCleoHomeOverride();
  if (override) return override;
  if (process.env['CLEO_HOME']) return process.env['CLEO_HOME'];
  const xdgData = process.env['XDG_DATA_HOME'];
  if (xdgData) return join(xdgData, 'cleo');
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'cleo');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return join(localAppData, 'cleo', 'Data');
  }
  return join(home, '.local', 'share', 'cleo');
}

// ---------------------------------------------------------------------------
// Allowlist (ADR-086 §2.1)
// ---------------------------------------------------------------------------

/**
 * Files (relative to `<cleoHome>/nexus/`) the script is permitted to delete.
 * Any nested file NOT in this list triggers an "unexpected file" report.
 */
const ALLOWED_FILES = [
  'nexus.db',
  'nexus.db-shm',
  'nexus.db-wal',
  'nexus-pre-cleo.db.bak',
  'signaldock.db',
  'signaldock.db-shm',
  'signaldock.db-wal',
  'signaldock-pre-cleo.db.bak',
  'global-salt',
];

/**
 * Subdirectories (relative to `<cleoHome>/nexus/`) the script is permitted
 * to remove if empty after the file sweep. Removed via rmdir(), never
 * recursive rm.
 */
const ALLOWED_SUBDIRS = ['cache'];

// ---------------------------------------------------------------------------
// Detection / planning
// ---------------------------------------------------------------------------

/**
 * Plan the migration for the given `cleoHome` path. Pure / read-only —
 * `execute()` is the corresponding mutating function.
 */
function plan(cleoHome) {
  const nestedRoot = join(cleoHome, 'nexus');
  const exists = existsSync(nestedRoot);
  const filesToDelete = [];
  const subdirsToRemove = [];
  const unexpected = [];

  if (!exists) {
    return {
      nestedRoot,
      exists: false,
      filesToDelete,
      subdirsToRemove,
      unexpected,
      noOp: true,
    };
  }

  // Walk the immediate contents of the nested directory only. We do NOT
  // recurse — `cache/` is checked separately as an allowed subdirectory.
  const entries = readdirSync(nestedRoot);
  for (const name of entries) {
    const fullPath = join(nestedRoot, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      // File disappeared between readdir + stat — treat as already gone.
      continue;
    }

    if (stat.isFile()) {
      if (ALLOWED_FILES.includes(name)) {
        filesToDelete.push(fullPath);
      } else {
        unexpected.push(fullPath);
      }
      continue;
    }

    if (stat.isDirectory()) {
      if (ALLOWED_SUBDIRS.includes(name)) {
        // Only remove if empty — script does NOT recurse.
        try {
          const subEntries = readdirSync(fullPath);
          if (subEntries.length === 0) {
            subdirsToRemove.push(fullPath);
          } else {
            unexpected.push(fullPath);
          }
        } catch {
          unexpected.push(fullPath);
        }
      } else {
        unexpected.push(fullPath);
      }
      continue;
    }

    // Symlink / other — refuse.
    unexpected.push(fullPath);
  }

  return {
    nestedRoot,
    exists: true,
    filesToDelete,
    subdirsToRemove,
    unexpected,
    noOp: filesToDelete.length === 0 && subdirsToRemove.length === 0 && unexpected.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function execute(planResult) {
  const errors = [];
  let deletedFiles = 0;
  let removedSubdirs = 0;
  let removedRoot = false;

  for (const file of planResult.filesToDelete) {
    try {
      unlinkSync(file);
      deletedFiles += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: file, error: message });
    }
  }

  for (const dir of planResult.subdirsToRemove) {
    try {
      rmdirSync(dir);
      removedSubdirs += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: dir, error: message });
    }
  }

  // Remove the nested root last — only if it is now empty AND no unexpected
  // files remain.
  if (planResult.unexpected.length === 0 && existsSync(planResult.nestedRoot)) {
    try {
      const remaining = readdirSync(planResult.nestedRoot);
      if (remaining.length === 0) {
        rmdirSync(planResult.nestedRoot);
        removedRoot = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: planResult.nestedRoot, error: message });
    }
  }

  return { deletedFiles, removedSubdirs, removedRoot, errors };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printPlan(planResult, cleoHome) {
  const rel = (p) => relative(cleoHome, p) || '.';

  console.log(`[migrate-nested-nexus] CLEO home: ${cleoHome}`);
  console.log(`[migrate-nested-nexus] Nested root: ${planResult.nestedRoot}`);

  if (!planResult.exists) {
    console.log('[migrate-nested-nexus] Nested directory does NOT exist — no-op.');
    return;
  }

  if (planResult.noOp) {
    console.log('[migrate-nested-nexus] Nested directory is empty — no-op.');
    return;
  }

  if (planResult.filesToDelete.length > 0) {
    console.log(`[migrate-nested-nexus] Files to delete (${planResult.filesToDelete.length}):`);
    for (const f of planResult.filesToDelete) {
      console.log(`  - ${rel(f)}`);
    }
  }

  if (planResult.subdirsToRemove.length > 0) {
    console.log(
      `[migrate-nested-nexus] Empty subdirs to remove (${planResult.subdirsToRemove.length}):`,
    );
    for (const d of planResult.subdirsToRemove) {
      console.log(`  - ${rel(d)}`);
    }
  }

  if (planResult.unexpected.length > 0) {
    console.log(`[migrate-nested-nexus] UNEXPECTED entries (${planResult.unexpected.length}):`);
    for (const u of planResult.unexpected) {
      console.log(`  ! ${rel(u)}`);
    }
    console.log(
      '[migrate-nested-nexus] Unexpected entries are NOT deleted. Review manually and remove before re-running.',
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (DRY_RUN) {
    console.log('[migrate-nested-nexus] DRY-RUN mode — no changes will be made.\n');
  }

  const cleoHome = resolveCleoHome();
  const planResult = plan(cleoHome);

  printPlan(planResult, cleoHome);

  if (planResult.noOp) {
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('\n[migrate-nested-nexus] Dry-run complete. Re-run without --dry-run to execute.');
    process.exit(0);
  }

  if (
    planResult.unexpected.length > 0 &&
    planResult.filesToDelete.length === 0 &&
    planResult.subdirsToRemove.length === 0
  ) {
    // Nothing safe to delete; only unexpected entries remain.
    console.log('\n[migrate-nested-nexus] Nothing to delete safely — unexpected entries only.');
    process.exit(1);
  }

  if (!NO_CONFIRM) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\n[migrate-nested-nexus] Proceed with deletion? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('[migrate-nested-nexus] Aborted by user.');
      process.exit(3);
    }
  }

  const result = execute(planResult);

  console.log(
    `\n[migrate-nested-nexus] Deleted ${result.deletedFiles} file(s), removed ${result.removedSubdirs} subdir(s)` +
      (result.removedRoot ? ', removed nested root.' : '.'),
  );

  if (result.errors.length > 0) {
    console.log(`[migrate-nested-nexus] ${result.errors.length} error(s) during deletion:`);
    for (const e of result.errors) {
      console.log(`  ! ${e.path}: ${e.error}`);
    }
    process.exit(2);
  }

  if (planResult.unexpected.length > 0) {
    console.log(
      '[migrate-nested-nexus] Allowlisted entries deleted, but unexpected entries remain — manual review needed.',
    );
    process.exit(1);
  }

  process.exit(0);
}

// Export pure helpers so the unit test can exercise the planning + allowlist
// logic without spawning a subprocess.
export { ALLOWED_FILES, ALLOWED_SUBDIRS, execute, plan, resolveCleoHome };

// CLI entry point — only run main() when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[migrate-nested-nexus] Fatal error:', err);
    process.exit(2);
  });
}
