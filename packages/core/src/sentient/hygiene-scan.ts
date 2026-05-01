/**
 * Hygiene Scan — sentient background loop (T1636).
 *
 * Each dream/sleep cycle this module runs 4 hygiene checks and emits BRAIN
 * observations tagged with 'hygiene:*' so the system self-organises without
 * manual audits.
 *
 * Scan 1 — orphan tasks
 *   Tasks whose `parent_id` points to a done/cancelled/missing parent. These
 *   tasks are orphaned and may never be picked. Emits observation tagged
 *   'hygiene:orphan'.
 *
 * Scan 2 — top-level type=task
 *   Root-level tasks (no `parent_id`, type='task'). These should be promoted
 *   to an epic or re-parented. Emits observation tagged 'hygiene:top-level-orphan'.
 *
 * Scan 3 — content quality
 *   Tasks with missing acceptance criteria, missing files (for type=task), or
 *   acceptance criteria shorter than 20 chars. Emits observation tagged
 *   'hygiene:content-defect'.
 *
 * Scan 4 — premature-close leaks (defensive)
 *   Tasks whose status='done' but parent epic still has active/pending siblings.
 *   The T1632 invariant should prevent this; this scan is a safety net.
 *   Emits observation tagged 'hygiene:premature-close-leak' (CRITICAL severity).
 *
 * Cadence: configurable via {@link HygieneScanOptions.scanIntervalMs}.
 * Default: {@link HYGIENE_SCAN_INTERVAL_MS} (once per 4-hour dream cycle).
 *
 * Integration: called from `safeRunTick` in tick.ts (fire-and-forget).
 * Fully injectable: `db`, `observeMemory`, and `isKilled` can be overridden
 * by tests without touching the real DB.
 *
 * @task T1636
 * @see T1632 — premature-close prevention (Scan 4 is its defensive shadow)
 * @see T1635 — stage-drift detector (pattern this module follows)
 * @see ADR-054 — Sentient Loop Tier-1/Tier-2
 */

import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default cadence between hygiene scan passes (4 hours in milliseconds).
 * Longer than stage-drift (30 min) because hygiene issues evolve slowly.
 * Configurable via {@link HygieneScanOptions.scanIntervalMs}.
 */
export const HYGIENE_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Minimum acceptance criterion length (chars) below which a criterion is
 * classified as "vague" and triggers a content-defect observation.
 */
export const VAGUE_AC_CHAR_THRESHOLD = 20;

/**
 * Maximum number of task IDs to embed in a single observation text to keep
 * observations readable. Excess IDs are truncated with a count suffix.
 */
export const MAX_TASK_IDS_IN_OBSERVATION = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for {@link runHygieneScan}.
 */
export interface HygieneScanOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Override for the tasks.db handle. Injected by tests.
   * When omitted, `getNativeDb()` is called after ensuring the DB is open.
   */
  db?: DatabaseSync | null;
  /**
   * Override for the memory-observe function. Injected by tests to avoid
   * writing to a real brain.db during unit tests.
   *
   * Signature matches `memoryObserve` from `@cleocode/core/internal`.
   */
  observeMemory?: (
    params: {
      text: string;
      title: string;
      type?: string;
    },
    projectRoot: string,
  ) => Promise<unknown>;
  /**
   * Kill-switch check. Injected by tests.
   * When omitted, reads the state file via `readSentientState`.
   */
  isKilled?: () => Promise<boolean>;
}

/**
 * Per-check result within a {@link HygieneScanOutcome}.
 */
export interface HygieneScanCheckResult {
  /** Number of defective tasks found by this check. */
  found: number;
  /** Number of observations emitted. */
  observed: number;
  /** Human-readable detail line. */
  detail: string;
}

/**
 * Outcome of {@link runHygieneScan}.
 */
export interface HygieneScanOutcome {
  /** How the scan ended. */
  kind: 'killed' | 'no-db' | 'scanned' | 'error';
  /** Results per scan (orphan, top-level, content, premature-close). */
  checks: {
    orphan: HygieneScanCheckResult;
    topLevelOrphan: HygieneScanCheckResult;
    contentDefect: HygieneScanCheckResult;
    prematureCloseLeak: HygieneScanCheckResult;
  };
  /** Total observations emitted across all checks. */
  totalObserved: number;
  /** Human-readable summary line. */
  detail: string;
}

// ---------------------------------------------------------------------------
// DB row types (local — not exported to avoid polluting contracts)
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  parent_id: string | null;
  type: string | null;
  status: string;
  acceptance_json: string | null;
  files_json: string | null;
  labels_json: string | null;
}

interface ParentStatusRow {
  id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a formatted list of task IDs for embedding in observation text.
 * Caps at {@link MAX_TASK_IDS_IN_OBSERVATION} with a trailing count for excess.
 */
function formatTaskIds(ids: string[]): string {
  if (ids.length === 0) return '(none)';
  const shown = ids.slice(0, MAX_TASK_IDS_IN_OBSERVATION);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+ ${rest} more)` : shown.join(', ');
}

/**
 * Parse a JSON-encoded acceptance criteria column into an array of strings.
 * Returns an empty array on invalid JSON or null input.
 */
function parseAcceptanceJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Acceptance items can be strings or AcceptanceGate objects — extract text.
    return parsed.map((item: unknown) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'criteria' in item) {
        return String((item as { criteria: unknown }).criteria);
      }
      return '';
    });
  } catch {
    return [];
  }
}

/**
 * Parse a JSON-encoded files column into an array of strings.
 * Returns an empty array on invalid JSON or null input.
 */
function parseFilesJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Query all tasks (non-epic, non-proposed, non-terminal) in batch from tasks.db.
 * Returns null when the DB is unavailable.
 */
function queryWorkingTasks(db: DatabaseSync): TaskRow[] {
  const sql = `
    SELECT id, parent_id, type, status, acceptance_json, files_json, labels_json
    FROM tasks
    WHERE type != 'epic'
      AND status NOT IN ('done', 'cancelled')
      AND status != 'proposed'
    ORDER BY id ASC
  `;
  try {
    return db.prepare(sql).all() as unknown as TaskRow[];
  } catch {
    return [];
  }
}

/**
 * Query tasks with done/cancelled status (needed for Scan 4 leak detection).
 * We need the recently-done ones to check if their parent epic still has siblings.
 */
function queryRecentlyDoneTasks(db: DatabaseSync): TaskRow[] {
  const sql = `
    SELECT id, parent_id, type, status, acceptance_json, files_json, labels_json
    FROM tasks
    WHERE type != 'epic'
      AND status = 'done'
      AND parent_id IS NOT NULL
      AND updated_at >= datetime('now', '-7 days')
    ORDER BY id ASC
    LIMIT 500
  `;
  try {
    return db.prepare(sql).all() as unknown as TaskRow[];
  } catch {
    return [];
  }
}

/**
 * Look up the status of a parent task. Returns null if not found.
 */
function queryParentStatus(db: DatabaseSync, parentId: string): string | null {
  const sql = `SELECT id, status FROM tasks WHERE id = :id LIMIT 1`;
  try {
    const row = db.prepare(sql).get({ id: parentId }) as ParentStatusRow | undefined;
    return row ? row.status : null;
  } catch {
    return null;
  }
}

/**
 * Count pending/active sibling tasks under a parent epic.
 */
function countActiveSiblings(db: DatabaseSync, parentId: string, excludeTaskId: string): number {
  const sql = `
    SELECT COUNT(*) as cnt
    FROM tasks
    WHERE parent_id = :parentId
      AND id != :excludeId
      AND status IN ('pending', 'active', 'blocked')
  `;
  try {
    const row = db.prepare(sql).get({ parentId, excludeId: excludeTaskId }) as
      | { cnt: number }
      | undefined;
    return row ? row.cnt : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Scan implementations
// ---------------------------------------------------------------------------

/**
 * Scan 1: orphan tasks — tasks whose `parent_id` references a done/cancelled
 * or missing parent. These tasks are effectively invisible to the scheduler.
 */
async function scanOrphanTasks(
  db: DatabaseSync,
  tasks: TaskRow[],
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
): Promise<HygieneScanCheckResult> {
  const tasksWithParent = tasks.filter((t) => t.parent_id !== null);
  const orphanIds: string[] = [];

  for (const task of tasksWithParent) {
    // parentId is non-null here due to filter above
    const parentStatus = queryParentStatus(db, task.parent_id as string);
    if (parentStatus === null || parentStatus === 'done' || parentStatus === 'cancelled') {
      orphanIds.push(task.id);
    }
  }

  if (orphanIds.length === 0) {
    return { found: 0, observed: 0, detail: 'no orphan tasks found' };
  }

  const text =
    `hygiene:orphan — ${orphanIds.length} task(s) have a done/cancelled/missing parent and ` +
    `will never be picked by the scheduler. Consider re-parenting or cancelling them. ` +
    `Task IDs: ${formatTaskIds(orphanIds)}`;

  const title = `hygiene:orphan — ${orphanIds.length} orphaned task(s) detected`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'discovery' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort — never crash the scan.
    }
  }

  return {
    found: orphanIds.length,
    observed,
    detail: `${orphanIds.length} orphan task(s): ${formatTaskIds(orphanIds)}`,
  };
}

/**
 * Scan 2: top-level type=task — root-level tasks (no parent_id, type='task').
 * These tasks are not under any epic and may be lost. Recommend re-parenting
 * under an epic or promoting to an epic.
 */
async function scanTopLevelOrphanTasks(
  db: DatabaseSync,
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
): Promise<HygieneScanCheckResult> {
  const sql = `
    SELECT id, parent_id, type, status, acceptance_json, files_json, labels_json
    FROM tasks
    WHERE parent_id IS NULL
      AND type = 'task'
      AND status NOT IN ('done', 'cancelled', 'proposed')
    ORDER BY id ASC
    LIMIT 200
  `;
  let rows: TaskRow[];
  try {
    rows = db.prepare(sql).all() as unknown as TaskRow[];
  } catch {
    return { found: 0, observed: 0, detail: 'db error in top-level scan' };
  }

  if (rows.length === 0) {
    return { found: 0, observed: 0, detail: 'no top-level orphan tasks found' };
  }

  const ids = rows.map((r) => r.id);
  const text =
    `hygiene:top-level-orphan — ${ids.length} task(s) are root-level (no parent epic). ` +
    `Action required: re-parent under an existing epic (\`cleo update <id> --parent <epicId>\`) ` +
    `or promote to an epic (\`cleo update <id> --type epic\`). ` +
    `Task IDs: ${formatTaskIds(ids)}`;

  const title = `hygiene:top-level-orphan — ${ids.length} top-level task(s) need epic parent`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'discovery' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort.
    }
  }

  return {
    found: ids.length,
    observed,
    detail: `${ids.length} top-level task(s): ${formatTaskIds(ids)}`,
  };
}

/**
 * Scan 3: content quality defects.
 *
 * Checks for:
 *   - Missing acceptance criteria (empty or null `acceptance_json` array)
 *   - Missing files for type=task tasks (files_json is empty/null)
 *   - Vague acceptance criteria (any item shorter than VAGUE_AC_CHAR_THRESHOLD chars)
 */
async function scanContentDefects(
  tasks: TaskRow[],
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
): Promise<HygieneScanCheckResult> {
  interface ContentDefect {
    taskId: string;
    reason: string;
  }

  const defects: ContentDefect[] = [];

  for (const task of tasks) {
    const ac = parseAcceptanceJson(task.acceptance_json);
    const files = parseFilesJson(task.files_json);

    // Missing AC entirely.
    if (ac.length === 0) {
      defects.push({ taskId: task.id, reason: 'missing acceptance criteria' });
      continue;
    }

    // Vague AC items.
    const vagueItems = ac.filter((item) => item.length < VAGUE_AC_CHAR_THRESHOLD);
    if (vagueItems.length > 0) {
      defects.push({
        taskId: task.id,
        reason: `vague acceptance criteria (${vagueItems.length} item(s) < ${VAGUE_AC_CHAR_THRESHOLD} chars)`,
      });
      continue;
    }

    // Missing files for type=task.
    if (task.type === 'task' && files.length === 0) {
      defects.push({ taskId: task.id, reason: 'type=task with no files listed' });
    }
  }

  if (defects.length === 0) {
    return { found: 0, observed: 0, detail: 'no content defects found' };
  }

  const taskIdList = defects.map((d) => d.taskId);
  // Group reasons for concise output.
  const reasonSummary = defects
    .slice(0, 5)
    .map((d) => `${d.taskId}: ${d.reason}`)
    .join('; ');
  const suffix = defects.length > 5 ? ` (+ ${defects.length - 5} more)` : '';

  const text =
    `hygiene:content-defect — ${defects.length} task(s) have content quality issues. ` +
    `Examples: ${reasonSummary}${suffix}. ` +
    `All affected IDs: ${formatTaskIds(taskIdList)}`;

  const title = `hygiene:content-defect — ${defects.length} task(s) need content improvement`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'discovery' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort.
    }
  }

  return {
    found: defects.length,
    observed,
    detail: `${defects.length} content defect(s): ${formatTaskIds(taskIdList)}`,
  };
}

/**
 * Scan 4: premature-close leaks (defensive shadow of T1632 invariant).
 *
 * Looks for recently-done tasks whose parent epic is still active/pending
 * AND whose done sibling count matches or exceeds all children (implying the
 * epic should have auto-closed but didn't). This catches any slip past the
 * T1632 gating invariant.
 *
 * Emits CRITICAL observations tagged 'hygiene:premature-close-leak'.
 */
async function scanPrematureCloseLeaks(
  db: DatabaseSync,
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
): Promise<HygieneScanCheckResult> {
  const recentDone = queryRecentlyDoneTasks(db);
  const leakIds: string[] = [];

  for (const task of recentDone) {
    if (!task.parent_id) continue;
    const parentStatus = queryParentStatus(db, task.parent_id);
    if (!parentStatus || !['pending', 'active', 'blocked'].includes(parentStatus)) continue;

    // Parent is still active — check if there are any active siblings.
    // If there are none, the parent should have auto-closed (potential leak).
    const activeSiblings = countActiveSiblings(db, task.parent_id, task.id);
    if (activeSiblings === 0) {
      leakIds.push(task.id);
    }
  }

  if (leakIds.length === 0) {
    return { found: 0, observed: 0, detail: 'no premature-close leaks detected' };
  }

  const text =
    `hygiene:premature-close-leak [CRITICAL] — ${leakIds.length} task(s) are done but ` +
    `their parent epic has no remaining active/pending siblings and is NOT closed. ` +
    `This may indicate a slip past the T1632 premature-close invariant. ` +
    `Manual review required: ${formatTaskIds(leakIds)}. ` +
    `Run \`cleo show <epicId>\` to inspect and \`cleo complete <epicId>\` to close.`;

  const title = `hygiene:premature-close-leak [CRITICAL] — ${leakIds.length} potential unclosed epic(s)`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'decision' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort.
    }
  }

  return {
    found: leakIds.length,
    observed,
    detail: `${leakIds.length} premature-close leak(s): ${formatTaskIds(leakIds)}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all 4 hygiene scans in a single pass.
 *
 * Steps:
 *   1. Kill-switch check → abort if active.
 *   2. Resolve tasks.db (injected or real).
 *   3. Run Scan 1 (orphan), Scan 2 (top-level), Scan 3 (content), Scan 4 (premature-close).
 *   4. Emit BRAIN observations for each check that found defects.
 *
 * @param options - Scan options (see {@link HygieneScanOptions})
 * @returns {@link HygieneScanOutcome}
 *
 * @task T1636
 */
export async function runHygieneScan(options: HygieneScanOptions): Promise<HygieneScanOutcome> {
  const { projectRoot, statePath } = options;

  const emptyChecks = {
    orphan: { found: 0, observed: 0, detail: '' },
    topLevelOrphan: { found: 0, observed: 0, detail: '' },
    contentDefect: { found: 0, observed: 0, detail: '' },
    prematureCloseLeak: { found: 0, observed: 0, detail: '' },
  };

  // Step 1: kill-switch check.
  const killed = await (options.isKilled
    ? options.isKilled()
    : (async () => {
        const { readSentientState } = await import('./state.js');
        const state = await readSentientState(statePath);
        return state.killSwitch === true;
      })());

  if (killed) {
    return {
      kind: 'killed',
      checks: emptyChecks,
      totalObserved: 0,
      detail: 'killSwitch active — hygiene scan skipped',
    };
  }

  // Step 2: resolve DB.
  let db: DatabaseSync | null;
  if (options.db !== undefined) {
    db = options.db;
  } else {
    try {
      const { getNativeDb, getDb } = await import('../store/sqlite.js');
      await getDb(projectRoot);
      db = getNativeDb();
    } catch {
      db = null;
    }
  }

  if (!db) {
    return {
      kind: 'no-db',
      checks: emptyChecks,
      totalObserved: 0,
      detail: 'tasks.db not available — hygiene scan skipped',
    };
  }

  // Resolve the observe function once.
  const observe: HygieneScanOptions['observeMemory'] =
    options.observeMemory ??
    (async (params, root) => {
      const { memoryObserve } = await import('@cleocode/core/internal');
      return memoryObserve(params, root);
    });

  // Step 3: batch-query working tasks (for Scans 1 + 3).
  const workingTasks = queryWorkingTasks(db);

  // Step 4: run all 4 scans.
  const [orphan, topLevelOrphan, contentDefect, prematureCloseLeak] = await Promise.all([
    scanOrphanTasks(db, workingTasks, observe, projectRoot),
    scanTopLevelOrphanTasks(db, observe, projectRoot),
    scanContentDefects(workingTasks, observe, projectRoot),
    scanPrematureCloseLeaks(db, observe, projectRoot),
  ]);

  const totalObserved =
    orphan.observed +
    topLevelOrphan.observed +
    contentDefect.observed +
    prematureCloseLeak.observed;

  const totalFound =
    orphan.found + topLevelOrphan.found + contentDefect.found + prematureCloseLeak.found;

  return {
    kind: 'scanned',
    checks: { orphan, topLevelOrphan, contentDefect, prematureCloseLeak },
    totalObserved,
    detail:
      `scanned ${workingTasks.length} working task(s); ` +
      `${totalFound} issue(s) found across 4 checks; ` +
      `${totalObserved} observation(s) emitted`,
  };
}

/**
 * Safe wrapper for {@link runHygieneScan} — swallows unexpected exceptions.
 *
 * Used from `safeRunTick` in tick.ts as a fire-and-forget best-effort call.
 * Errors never propagate to the tick caller.
 *
 * @param options - Scan options
 * @returns Scan outcome or an error outcome on unexpected throw.
 *
 * @task T1636
 */
export async function safeRunHygieneScan(options: HygieneScanOptions): Promise<HygieneScanOutcome> {
  try {
    return await runHygieneScan(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      checks: {
        orphan: { found: 0, observed: 0, detail: '' },
        topLevelOrphan: { found: 0, observed: 0, detail: '' },
        contentDefect: { found: 0, observed: 0, detail: '' },
        prematureCloseLeak: { found: 0, observed: 0, detail: '' },
      },
      totalObserved: 0,
      detail: `hygiene scan threw: ${message}`,
    };
  }
}
