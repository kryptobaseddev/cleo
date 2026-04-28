#!/usr/bin/env node
/**
 * Re-parent 39 orphaned tasks across 5 epic groups (T1503 / P0-7).
 *
 * Groups:
 *   EP1 Nexus  (T1057-T1061) → T1054 (Nexus P0: Core Query Power)
 *   EP2 Nexus  (T1062-T1065) → T1055 (Nexus P1: Competitive Closure)
 *   EP3 Nexus  (T1066-T1073) → T1056 (Nexus P2: Living Brain Completion)
 *   Agents-arch (T897-T909)  → T1232 (PRE-WAVE: Agents Architecture Remediation)
 *   Sandbox/Tier3:
 *     T923, T925, T1009       → T911  (Sandbox Harness Coverage)
 *     T1010-T1012, T1029-T1030, T1032 → T942 (Sentient Architecture Redesign)
 *
 * EXCLUDED (pending owner T1106 decision):
 *   T1104, T1105, T1108, T1109, T1111, T1112, T1115, T1116, T1117, T1130, T1131, T1132
 *
 * Idempotent: tasks that already have the correct parentId are skipped.
 * Per AGENTS.md: NO direct sqlite3. All writes via `cleo update --parent`.
 *
 * ## Usage
 *
 *   node scripts/reparent-orphans-2026-04-28.mjs
 *   node scripts/reparent-orphans-2026-04-28.mjs --dry-run
 *   node scripts/reparent-orphans-2026-04-28.mjs --verbose
 *
 * ## Exit codes
 *
 *   0  All 39 tasks re-parented successfully (or already correct)
 *   1  One or more tasks failed to re-parent
 *
 * @task T1503
 * @epic T1499
 */

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Re-parent manifest (39 tasks across 5 groups)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ parentId: string, taskIds: string[], rationale: string }} ReparentGroup
 */

/** @type {ReparentGroup[]} */
const GROUPS = [
  {
    parentId: 'T1054',
    taskIds: ['T1057', 'T1058', 'T1059', 'T1060', 'T1061'],
    rationale: 'EP1 Nexus P0: Core Query Power — 5 named EP1-T* tasks',
  },
  {
    parentId: 'T1055',
    taskIds: ['T1062', 'T1063', 'T1064', 'T1065'],
    rationale: 'EP2 Nexus P1: Competitive Closure — 4 named EP2-T* tasks',
  },
  {
    parentId: 'T1056',
    taskIds: ['T1066', 'T1067', 'T1068', 'T1069', 'T1070', 'T1071', 'T1072', 'T1073'],
    rationale: 'EP3 Nexus P2: Living Brain Completion — 8 named EP3-T* tasks',
  },
  {
    parentId: 'T1232',
    taskIds: [
      'T897',
      'T898',
      'T899',
      'T900',
      'T901',
      'T902',
      'T903',
      'T904',
      'T905',
      'T906',
      'T907',
      'T908',
      'T909',
    ],
    rationale:
      'Agents Architecture Remediation — registry, persona resolution, CANT DSL, playbook DSL, seed-agents, skills, runtime enforcement, HITL gates, conduit topology',
  },
  {
    parentId: 'T911',
    taskIds: ['T923', 'T925', 'T1009'],
    rationale: 'Sandbox Harness Coverage — codex-cli, cursor, Tier3 container harness',
  },
  {
    parentId: 'T942',
    taskIds: ['T1010', 'T1011', 'T1012', 'T1029', 'T1030', 'T1032'],
    rationale:
      'Sentient Architecture Redesign — Tier3 merge-ritual, experiment-runner, kill-switch, abort protocol',
  },
];

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

  if (proc.error) return null;

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
  const result = callCleo(['show', taskId]);
  if (!result?.success) return undefined;
  const task = result.data?.task ?? result.data;
  return task?.parentId ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const totalTasks = GROUPS.reduce((sum, g) => sum + g.taskIds.length, 0);

  console.log(`T1503 / P0-7 orphan re-parent — ${isDryRun ? 'DRY RUN' : 'LIVE RUN'}`);
  console.log(`Groups: ${GROUPS.length} | Tasks: ${totalTasks}`);
  console.log('');

  let totalRepaired = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const group of GROUPS) {
    console.log(`--- Group → ${group.parentId} (${group.rationale}) ---`);

    for (const taskId of group.taskIds) {
      const currentParentId = getCurrentParentId(taskId);

      if (currentParentId === undefined) {
        console.error(`  [ERROR] ${taskId}: could not fetch current state — skipping`);
        totalFailed++;
        continue;
      }

      if (currentParentId === group.parentId) {
        if (isVerbose) {
          console.log(`  [SKIP]  ${taskId}: already parentId=${group.parentId}`);
        }
        totalSkipped++;
        continue;
      }

      if (isDryRun) {
        console.log(
          `  [DRY]   ${taskId}: would set parentId ${currentParentId ?? 'null'} → ${group.parentId}`,
        );
        totalRepaired++;
        continue;
      }

      const updateResult = callCleo(['update', taskId, '--parent', group.parentId]);

      if (updateResult?.success) {
        console.log(
          `  [OK]    ${taskId}: parentId ${currentParentId ?? 'null'} → ${group.parentId}`,
        );
        totalRepaired++;
      } else {
        const errMsg = updateResult?.error?.message ?? 'unknown error';
        console.error(`  [ERROR] ${taskId}: update failed — ${errMsg}`);
        totalFailed++;
      }
    }

    console.log('');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('--- Summary ---');
  console.log(`  Re-parented : ${totalRepaired}`);
  console.log(`  Skipped     : ${totalSkipped} (already correct)`);
  console.log(`  Failed      : ${totalFailed}`);
  console.log('');
  console.log('  EXCLUDED (pending owner T1106 decision):');
  console.log('    T1104 T1105 T1108 T1109 T1111 T1112 T1115 T1116 T1117 T1130 T1131 T1132');
  console.log('');

  if (totalFailed > 0) {
    console.error(`Re-parent INCOMPLETE — ${totalFailed} task(s) failed. Review errors above.`);
    process.exit(1);
  }

  if (isDryRun) {
    console.log('Dry run complete. Re-run without --dry-run to apply changes.');
  } else {
    console.log('Re-parent complete. Run cleo list --parent <epicId> to confirm child rollups.');
  }
}

main();
