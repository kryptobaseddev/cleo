/**
 * Backfill module: retroactively add AC and verification metadata to
 * existing tasks that were created before T058 (AC enforcement) and
 * T061 (verification gate auto-init).
 *
 * Usage:
 *   backfillTasks(root, { dryRun: true })   -- preview only
 *   backfillTasks(root, {})                  -- apply changes
 *   backfillTasks(root, { rollback: true })  -- revert backfill
 *
 * @epic T056
 * @task T066
 */

import type { Task, TaskVerification } from '@cleocode/contracts';
import { getAccessor } from '../store/data-accessor.js';
import { buildDefaultVerification } from '../tasks/add.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for backfillTasks(). */
export interface BackfillOptions {
  /** Preview changes only — do not modify the database. Default: false. */
  dryRun?: boolean;
  /** Revert a previous backfill (remove auto-generated AC + verification). Default: false. */
  rollback?: boolean;
  /** Restrict backfill to specific task IDs. Default: all tasks. */
  taskIds?: string[];
}

/** Summary of what was (or would be) changed for a single task. */
export interface BackfillTaskChange {
  taskId: string;
  title: string;
  addedAc: boolean;
  generatedAc: string[];
  addedVerification: boolean;
  addedNote: boolean;
  /** Populated during rollback: fields that were cleared. */
  rolledBack?: string[];
}

/** Overall result returned by backfillTasks(). */
export interface BackfillResult {
  dryRun: boolean;
  rollback: boolean;
  tasksScanned: number;
  tasksChanged: number;
  acAdded: number;
  verificationAdded: number;
  changes: BackfillTaskChange[];
}

// ---------------------------------------------------------------------------
// AC generation (heuristic — no LLM)
// ---------------------------------------------------------------------------

/**
 * Generate 3 baseline acceptance criteria from a task description.
 * Uses simple text analysis — no LLM required.
 */
export function generateAcFromDescription(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();

  // Extract action verbs from the task description to build specific criteria
  const actionPatterns: Array<{ pattern: RegExp; criterion: string }> = [
    {
      pattern: /\b(implement|create|build|add|write)\b/,
      criterion: 'Implementation is complete and matches the described requirements',
    },
    {
      pattern: /\b(test|spec|verify|check|validate)\b/,
      criterion: 'All tests pass and edge cases are covered',
    },
    {
      pattern: /\b(fix|repair|resolve|patch|correct)\b/,
      criterion: 'The defect is resolved and does not regress',
    },
    {
      pattern: /\b(refactor|clean|reorganize|restructure)\b/,
      criterion: 'Refactoring does not change observable behaviour',
    },
    {
      pattern: /\b(document|doc|spec|describe)\b/,
      criterion: 'Documentation is accurate and complete',
    },
    {
      pattern: /\b(migrate|move|transfer|convert)\b/,
      criterion: 'Migration is complete and data integrity is preserved',
    },
    {
      pattern: /\b(update|upgrade|bump|change)\b/,
      criterion: 'Update is applied correctly with no breaking changes',
    },
    {
      pattern: /\b(delete|remove|drop|clean)\b/,
      criterion: 'Removal is complete and no orphaned references remain',
    },
  ];

  const specific: string[] = [];
  for (const { pattern, criterion } of actionPatterns) {
    if (pattern.test(text) && !specific.includes(criterion)) {
      specific.push(criterion);
      if (specific.length >= 1) break; // use the first match for a specific criterion
    }
  }

  // Always include two generic safety criteria
  const generic = [
    'Implementation matches the task description with no unintended side effects',
    'No breaking changes introduced to dependent code or workflows',
    'Changes verified manually or via automated tests',
  ];

  // Merge: one specific (if found) + two generic, total 3
  if (specific.length > 0) {
    return [specific[0]!, generic[1]!, generic[2]!];
  }

  return generic;
}

// ---------------------------------------------------------------------------
// Rollback marker detection
// ---------------------------------------------------------------------------

const BACKFILL_NOTE_MARKER = '[T066-backfill]';

function isBackfilledNote(note: string): boolean {
  return note.includes(BACKFILL_NOTE_MARKER);
}

function isBackfilledTask(task: Task): boolean {
  return (task.notes ?? []).some(isBackfilledNote);
}

// ---------------------------------------------------------------------------
// Core backfill logic
// ---------------------------------------------------------------------------

/**
 * Retroactively populate AC and verification metadata for tasks that lack them.
 *
 * @param projectRoot - Project root directory (cwd for CLEO operations)
 * @param options     - Backfill options (dryRun, rollback, taskIds)
 */
export async function backfillTasks(
  projectRoot: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const { dryRun = false, rollback = false, taskIds } = options;
  const now = new Date().toISOString();

  const accessor = await getAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});

  // Filter to requested task IDs (if supplied)
  const candidates = taskIds ? tasks.filter((t) => taskIds.includes(t.id)) : tasks;

  const changes: BackfillTaskChange[] = [];
  let acAdded = 0;
  let verificationAdded = 0;

  for (const task of candidates) {
    if (rollback) {
      // --- Rollback mode: undo what backfill added ---
      if (!isBackfilledTask(task)) continue;

      const rolledBack: string[] = [];
      const updates: import('@cleocode/contracts').TaskFieldUpdates & {
        notesJson?: string;
        acceptanceJson?: string;
        verificationJson?: string | null;
      } = { updatedAt: now };

      // Remove backfill notes
      const cleanedNotes = (task.notes ?? []).filter((n) => !isBackfilledNote(n));
      if (cleanedNotes.length !== (task.notes ?? []).length) {
        updates.notesJson = JSON.stringify(cleanedNotes);
        rolledBack.push('note');
      }

      // If task has the backfill-generated AC marker in notes, we can infer the
      // AC was auto-generated. We clear it back to empty to revert.
      // NOTE: We only clear AC if it was added by backfill (the note marker is present).
      if ((task.acceptance ?? []).length > 0) {
        updates.acceptanceJson = JSON.stringify([]);
        rolledBack.push('ac');
      }

      // Clear verification if it was set by backfill
      if (task.verification) {
        updates.verificationJson = null;
        rolledBack.push('verification');
      }

      if (rolledBack.length > 0) {
        changes.push({
          taskId: task.id,
          title: task.title,
          addedAc: false,
          generatedAc: [],
          addedVerification: false,
          addedNote: false,
          rolledBack,
        });

        if (!dryRun) {
          await accessor.updateTaskFields(task.id, updates);
        }
      }

      continue;
    }

    // --- Forward mode: fill missing AC and verification ---
    const needsAc = !task.acceptance || task.acceptance.length === 0;
    const needsVerification = !task.verification;

    if (!needsAc && !needsVerification) continue;

    const change: BackfillTaskChange = {
      taskId: task.id,
      title: task.title,
      addedAc: false,
      generatedAc: [],
      addedVerification: false,
      addedNote: false,
    };

    const updates: import('@cleocode/contracts').TaskFieldUpdates & {
      notesJson?: string;
      acceptanceJson?: string;
      verificationJson?: string | null;
    } = { updatedAt: now };

    if (needsAc) {
      const generated = generateAcFromDescription(task.title, task.description ?? '');
      updates.acceptanceJson = JSON.stringify(generated);
      change.addedAc = true;
      change.generatedAc = generated;
      acAdded++;
    }

    if (needsVerification) {
      const verification: TaskVerification = buildDefaultVerification(now);
      updates.verificationJson = JSON.stringify(verification);
      change.addedVerification = true;
      verificationAdded++;
    }

    // Add a backfill note so rollback can identify what was changed
    const existingNotes = task.notes ?? [];
    const backfillNote = `${BACKFILL_NOTE_MARKER} auto-backfilled at ${now}: ${[
      needsAc ? 'ac' : null,
      needsVerification ? 'verification' : null,
    ]
      .filter(Boolean)
      .join(', ')}`;
    updates.notesJson = JSON.stringify([...existingNotes, backfillNote]);
    change.addedNote = true;

    changes.push(change);

    if (!dryRun) {
      await accessor.updateTaskFields(task.id, updates);
    }
  }

  return {
    dryRun,
    rollback,
    tasksScanned: candidates.length,
    tasksChanged: changes.length,
    acAdded: rollback ? 0 : acAdded,
    verificationAdded: rollback ? 0 : verificationAdded,
    changes,
  };
}
