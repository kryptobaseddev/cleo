#!/usr/bin/env node
/**
 * Repair T991 BRAIN Integrity epic parent-child DB links.
 *
 * Each of T992-T999 shipped real work in v2026.4.98 (release commit
 * 18128e3cec) but their `parent_id` column was never written in tasks.db.
 * This script calls `cleo update <id> --parent T991` for each child — the
 * canonical write path per AGENTS.md (no direct SQLite).
 *
 * Idempotent: if a child already has parentId=T991 the update is a no-op.
 *
 * ## Usage
 *
 *   node scripts/repair-t991-parent-links.mjs
 *   node scripts/repair-t991-parent-links.mjs --dry-run
 *   node scripts/repair-t991-parent-links.mjs --verbose
 *
 * ## Exit codes
 *
 *   0  All children linked successfully (or already correct)
 *   1  One or more children failed to link
 *
 * @task T1419
 * @epic T991
 */

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARENT_EPIC_ID = 'T991';

/** Git evidence: release commit documenting all 8 children. */
const RELEASE_COMMIT = '18128e3cec6b61f7486c136fb9a2cd956c51b37c';
const RELEASE_TAG = 'v2026.4.98';

const CHILD_TASK_IDS = ['T992', 'T993', 'T994', 'T995', 'T996', 'T997', 'T998', 'T999'];

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerbose = args.includes('--verbose') || isDryRun;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke `cleo` with the given arguments and return parsed JSON output.
 *
 * @param {string[]} cmdArgs - Argument array to pass to cleo.
 * @returns {{ success: boolean, data?: unknown, error?: { message: string } } | null}
 */
function callCleo(cmdArgs) {
  const proc = spawnSync('cleo', cmdArgs, {
    encoding: 'utf-8',
    env: { ...process.env, LOG_LEVEL: 'silent' },
  });

  if (proc.error) {
    return null;
  }

  const raw = (proc.stdout ?? '').trim();
  const lines = raw.split('\n');
  const jsonStart = lines.findIndex((l) => l.trim().startsWith('{'));
  if (jsonStart === -1) return null;

  try {
    return JSON.parse(lines.slice(jsonStart).join('\n'));
  } catch {
    return null;
  }
}

/**
 * Fetch the current parentId for a task.
 *
 * @param {string} taskId
 * @returns {string | null | undefined} Current parentId, null if unset, undefined on error.
 */
function getCurrentParentId(taskId) {
  const result = callCleo(['show', taskId, '--json']);
  if (!result?.success) return undefined;
  const task = result.data?.task ?? result.data;
  return task?.parentId ?? null;
}

// ---------------------------------------------------------------------------
// Pre-flight: verify git evidence
// ---------------------------------------------------------------------------

/**
 * Confirm the release commit is reachable in the local git history.
 * This ensures the repair is grounded in real shipped work.
 *
 * @returns {boolean}
 */
function verifyGitEvidence() {
  const proc = spawnSync('git', ['cat-file', '-t', RELEASE_COMMIT], {
    encoding: 'utf-8',
  });
  const ok = proc.status === 0 && proc.stdout.trim() === 'commit';
  if (!ok) {
    console.error(
      `[WARN] Release commit ${RELEASE_COMMIT} not found in local git history. ` +
        'Proceeding anyway — task DB state is the authoritative source.',
    );
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log(`T991 parent-link repair — ${isDryRun ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log(`Parent epic: ${PARENT_EPIC_ID}`);
  console.log(`Children:    ${CHILD_TASK_IDS.join(', ')}`);
  console.log(`Evidence:    ${RELEASE_TAG} @ ${RELEASE_COMMIT.slice(0, 12)}`);
  console.log('');

  // Pre-flight git check (non-blocking — only warns).
  verifyGitEvidence();

  let repaired = 0;
  let skipped = 0;
  let failed = 0;

  /** @type {Array<{taskId: string, previousParentId: string|null, skipped: boolean, success: boolean, error?: string}>} */
  const results = [];

  for (const taskId of CHILD_TASK_IDS) {
    const currentParentId = getCurrentParentId(taskId);

    if (currentParentId === undefined) {
      console.error(`  [ERROR] ${taskId}: could not fetch current state — skipping`);
      results.push({
        taskId,
        previousParentId: null,
        skipped: false,
        success: false,
        error: 'fetch failed',
      });
      failed++;
      continue;
    }

    if (currentParentId === PARENT_EPIC_ID) {
      if (isVerbose) {
        console.log(`  [SKIP]  ${taskId}: already parentId=${PARENT_EPIC_ID}`);
      }
      results.push({ taskId, previousParentId: currentParentId, skipped: true, success: true });
      skipped++;
      continue;
    }

    if (isDryRun) {
      console.log(
        `  [DRY]   ${taskId}: would set parentId ${currentParentId ?? 'null'} → ${PARENT_EPIC_ID}`,
      );
      results.push({ taskId, previousParentId: currentParentId, skipped: false, success: true });
      repaired++;
      continue;
    }

    // Live write via canonical cleo update path.
    const updateResult = callCleo(['update', taskId, '--parent', PARENT_EPIC_ID]);

    if (updateResult?.success) {
      console.log(`  [OK]    ${taskId}: parentId ${currentParentId ?? 'null'} → ${PARENT_EPIC_ID}`);
      results.push({ taskId, previousParentId: currentParentId, skipped: false, success: true });
      repaired++;
    } else {
      const errMsg = updateResult?.error?.message ?? 'unknown error';
      console.error(`  [ERROR] ${taskId}: update failed — ${errMsg}`);
      results.push({
        taskId,
        previousParentId: currentParentId,
        skipped: false,
        success: false,
        error: errMsg,
      });
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('');
  console.log('--- Summary ---');
  console.log(`  Repaired : ${repaired}`);
  console.log(`  Skipped  : ${skipped} (already correct)`);
  console.log(`  Failed   : ${failed}`);
  console.log('');

  if (!isDryRun && failed === 0) {
    // Verify final state.
    console.log('Verifying post-repair state via cleo list --parent T991 --status archived...');
    // Children are archived tasks; the default list excludes archived, so pass --status archived.
    const listResult = callCleo([
      'list',
      '--parent',
      PARENT_EPIC_ID,
      '--status',
      'archived',
      '--json',
    ]);
    if (listResult?.success) {
      const items = listResult.data?.tasks ?? listResult.data ?? [];
      const count = Array.isArray(items) ? items.length : 0;
      console.log(`  ${count} children found under ${PARENT_EPIC_ID}`);
      if (count < CHILD_TASK_IDS.length) {
        console.warn(
          `  [WARN] Expected ${CHILD_TASK_IDS.length} children but found ${count}. ` +
            'Run cleo list --parent T991 to inspect.',
        );
      } else {
        console.log('  All children confirmed.');
      }
    } else {
      console.warn('  [WARN] Could not verify via cleo list — inspect manually.');
    }
    console.log('');
  }

  if (failed > 0) {
    console.error(`Repair INCOMPLETE — ${failed} task(s) failed. Review errors above.`);
    process.exit(1);
  }

  if (isDryRun) {
    console.log('Dry run complete. Re-run without --dry-run to apply changes.');
  } else {
    console.log(
      'Repair complete. Run `cleo show T991` to confirm childRollup reflects the updated links.',
    );
  }
}

main();
