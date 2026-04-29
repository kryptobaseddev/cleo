/**
 * Context-switch (pivot) primitive for the orchestrate domain.
 *
 * A `pivot` is a first-class, audited verb for switching the active task in a
 * session away from one task (the `from` task) to another (the `to` task).
 * It exists to replace silent reframes — situations where an agent quietly
 * abandons one line of work and starts another without recording why. Pivots
 * leave a forensic trail consisting of:
 *
 * 1. an audit JSONL line in `.cleo/audit/pivots.jsonl`
 * 2. a memory observation persisted via {@link memoryObserve}
 * 3. an optional dependency edge (`addDepends: [toTaskId]` on the from task)
 *    so the from task cannot complete until the to task resolves.
 *
 * Project-agnostic — pivots are a CLEO-level concept and do not depend on any
 * particular language, build system, or testing framework.
 *
 * @task T1596
 * @epic T-FOUNDATION-LOCKDOWN
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskWorkState } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { memoryObserve } from '../memory/engine-compat.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { resolveProjectRoot } from '../store/file-utils.js';
import { startTask, stopTask } from '../task-work/index.js';
import { logOperation } from '../tasks/add.js';
import { updateTask } from '../tasks/update.js';

/** Relative path to the pivot audit log inside a project root. */
export const PIVOT_AUDIT_FILE = '.cleo/audit/pivots.jsonl';

/**
 * Options accepted by {@link pivotTask}.
 */
export interface PivotOptions {
  /** Free-form, human-readable explanation of why the pivot is happening. REQUIRED. */
  reason: string;
  /**
   * When `true` (the default), `addDepends: [toTaskId]` is recorded on the
   * `from` task so it cannot be marked complete until the `to` task resolves.
   * Set to `false` for "advisory" pivots that leave the from task free to
   * complete independently.
   */
  blocksFrom?: boolean;
  /** Optional override for project root — defaults to {@link resolveProjectRoot}. */
  projectRoot?: string;
  /** Optional override for the data accessor (used by tests). */
  accessor?: DataAccessor;
}

/**
 * Result returned by {@link pivotTask}.
 */
export interface PivotResult {
  /** Stable, opaque id for this pivot — used to correlate audit + memory entries. */
  pivotId: string;
  /** Serialized JSON line written to {@link PIVOT_AUDIT_FILE}. */
  auditEntry: string;
  /** ID of the task that was paused. */
  fromTaskId: string;
  /** ID of the task that became active. */
  toTaskId: string;
  /** Free-form pivot rationale (echoed back for caller convenience). */
  reason: string;
  /** ISO 8601 timestamp of the pivot. */
  timestamp: string;
  /** Active session id at the time of pivot, or null when no session was active. */
  sessionId: string | null;
  /** Agent identifier resolved from `CLEO_AGENT_ID` (or `'local'`). */
  agentId: string;
  /** Whether `addDepends: [toTaskId]` was applied to the from task. */
  blockedFrom: boolean;
  /** Memory observation entry id (if a memory write succeeded). */
  memoryObservationId: string | null;
}

/** Shape of a single line written to {@link PIVOT_AUDIT_FILE}. */
interface PivotAuditRow {
  pivotId: string;
  from: string;
  to: string;
  reason: string;
  timestamp: string;
  sessionId: string | null;
  agentId: string;
  blockedFrom: boolean;
}

/**
 * Generate a stable, sortable pivot id.
 * Format: `PIV-<unix-ms>-<6-char-random>`.
 */
function generatePivotId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `PIV-${ts}-${rand}`;
}

/**
 * Append a pivot audit row to `.cleo/audit/pivots.jsonl`.
 *
 * Failures are intentionally non-fatal — pivots must succeed even when the
 * audit log cannot be written (matches the convention in
 * `archive-reason-invariant.ts`). The serialized line is returned so the
 * caller can surface it through {@link PivotResult.auditEntry}.
 */
function appendPivotAudit(repoRoot: string, row: PivotAuditRow): string {
  const line = `${JSON.stringify(row)}\n`;
  try {
    const filePath = join(repoRoot, PIVOT_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, line, { encoding: 'utf-8' });
  } catch {
    // best-effort — never block the pivot on audit write failure
  }
  return line.trimEnd();
}

/**
 * Heuristic: determine whether a task is currently "active" enough to pivot
 * away from.
 *
 * A task is considered active iff EITHER of the following holds:
 *
 * - it is the current focus (`focus_state.currentTask === fromTaskId`), OR
 * - its `pipelineStage` is `implementation`, `verification`, or `test` (i.e.
 *   inside the IVTR loop).
 *
 * This keeps the rule project-agnostic — no harness-specific signal is
 * required.
 */
async function isTaskActive(
  acc: DataAccessor,
  fromTaskId: string,
): Promise<{ active: boolean; reason: string }> {
  const focus = await acc.getMetaValue<TaskWorkState>('focus_state');
  if (focus?.currentTask === fromTaskId) {
    return { active: true, reason: 'currentFocus' };
  }
  const task = await acc.loadSingleTask(fromTaskId);
  const stage = task?.pipelineStage ?? null;
  if (stage === 'implementation' || stage === 'verification' || stage === 'test') {
    return { active: true, reason: `pipelineStage:${stage}` };
  }
  return {
    active: false,
    reason: `from task '${fromTaskId}' is not the current focus and its pipelineStage is '${stage ?? 'null'}' (must be implementation|verification|test, or be the focus task)`,
  };
}

/**
 * Pivot from one task to another, recording a forensic trail.
 *
 * @param fromTaskId - The currently-active task ID being paused.
 * @param toTaskId   - The task ID becoming active in the current session.
 * @param opts       - Options bag (see {@link PivotOptions}).
 * @returns A {@link PivotResult} with the pivot id, audit line, and metadata.
 *
 * @throws {@link CleoError} when validation fails. Mapping:
 *  - missing/empty `reason` → `ExitCode.VALIDATION_ERROR` (E_VALIDATION)
 *  - missing/empty task ids → `ExitCode.INVALID_INPUT` (E_INVALID_INPUT)
 *  - either task does not exist → `ExitCode.NOT_FOUND` (E_NOT_FOUND)
 *  - from task is not active   → `ExitCode.ACTIVE_TASK_REQUIRED` (E_NOT_ACTIVE)
 *
 * @example
 * ```ts
 * await pivotTask('T1596', 'T1597', {
 *   reason: 'audit -> layering -> engine sidetrack discovered',
 * });
 * ```
 */
export async function pivotTask(
  fromTaskId: string,
  toTaskId: string,
  opts: PivotOptions,
): Promise<PivotResult> {
  // ---------------------------------------------------------------------------
  // Validate inputs (cheap checks first)
  // ---------------------------------------------------------------------------
  if (!fromTaskId || typeof fromTaskId !== 'string') {
    throw new CleoError(ExitCode.INVALID_INPUT, 'fromTaskId is required');
  }
  if (!toTaskId || typeof toTaskId !== 'string') {
    throw new CleoError(ExitCode.INVALID_INPUT, 'toTaskId is required');
  }
  if (fromTaskId === toTaskId) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `fromTaskId and toTaskId must differ (both are '${fromTaskId}')`,
    );
  }
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason.length === 0) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'pivot requires a non-empty --reason; silent context switches are not allowed',
      {
        fix: 'Re-run with --reason "<why are you pivoting>"',
      },
    );
  }

  const root = opts.projectRoot ?? resolveProjectRoot();
  const acc = opts.accessor ?? (await getAccessor(root));

  // ---------------------------------------------------------------------------
  // Validate both tasks exist (cleo exists semantics)
  // ---------------------------------------------------------------------------
  const fromTask = await acc.loadSingleTask(fromTaskId);
  if (!fromTask) {
    throw new CleoError(ExitCode.NOT_FOUND, `from task not found: ${fromTaskId}`, {
      fix: `Use 'cleo find "${fromTaskId}"' to verify the ID`,
    });
  }
  const toTask = await acc.loadSingleTask(toTaskId);
  if (!toTask) {
    throw new CleoError(ExitCode.NOT_FOUND, `to task not found: ${toTaskId}`, {
      fix: `Use 'cleo find "${toTaskId}"' to verify the ID`,
    });
  }

  // ---------------------------------------------------------------------------
  // Validate from task is active
  // ---------------------------------------------------------------------------
  const activeCheck = await isTaskActive(acc, fromTaskId);
  if (!activeCheck.active) {
    throw new CleoError(ExitCode.ACTIVE_TASK_REQUIRED, `pivot rejected: ${activeCheck.reason}`, {
      fix: `Run 'cleo start ${fromTaskId}' before pivoting away from it, or pick a different fromTaskId`,
    });
  }

  // ---------------------------------------------------------------------------
  // Pause from + activate to (focus_state mutation)
  // ---------------------------------------------------------------------------
  // Stop only if from is the current focus. If from is "active by stage"
  // we leave focus_state alone (there is no focus to clear) before starting to.
  const focus = await acc.getMetaValue<TaskWorkState>('focus_state');
  if (focus?.currentTask === fromTaskId) {
    await stopTask(root, acc);
  }
  await startTask(toTaskId, root, acc);

  // ---------------------------------------------------------------------------
  // Optionally add the dependency edge so from cannot complete before to
  // ---------------------------------------------------------------------------
  const blockedFrom = opts.blocksFrom !== false; // default: true
  if (blockedFrom) {
    try {
      await updateTask({ taskId: fromTaskId, addDepends: [toTaskId] }, root, acc);
    } catch (err) {
      // If updateTask rejects (e.g. session enforcement), the pivot still
      // succeeds — the dependency is best-effort. Log a structured note via
      // the operations log so the omission is recoverable.
      await logOperation(
        'pivot_dep_skipped',
        fromTaskId,
        {
          toTaskId,
          reason: err instanceof Error ? err.message : String(err),
        },
        acc,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Resolve session + agent identity for the audit row
  // ---------------------------------------------------------------------------
  const session = await acc.getActiveSession();
  const sessionId = session?.id ?? null;
  const agentId = process.env['CLEO_AGENT_ID'] ?? 'local';
  const timestamp = new Date().toISOString();
  const pivotId = generatePivotId();

  // ---------------------------------------------------------------------------
  // Append audit log line
  // ---------------------------------------------------------------------------
  const row: PivotAuditRow = {
    pivotId,
    from: fromTaskId,
    to: toTaskId,
    reason,
    timestamp,
    sessionId,
    agentId,
    blockedFrom,
  };
  const auditEntry = appendPivotAudit(root, row);

  // ---------------------------------------------------------------------------
  // Record memory observation (best-effort; never blocks the pivot result)
  // ---------------------------------------------------------------------------
  let memoryObservationId: string | null = null;
  try {
    const memResult = await memoryObserve(
      {
        // BRAIN_OBSERVATION_TYPES does not include 'pivot'; use 'decision'
        // and lead the title with [PIVOT] so retrieval still surfaces it.
        type: 'decision',
        title: `[PIVOT] ${fromTaskId} → ${toTaskId}`,
        text: `Pivoted from ${fromTaskId} to ${toTaskId}: ${reason}`,
        sourceSessionId: sessionId ?? undefined,
        agent: agentId,
      },
      root,
    );
    if (memResult.success) {
      const data = memResult.data as { id?: string; entryId?: string } | undefined;
      memoryObservationId = data?.id ?? data?.entryId ?? null;
    }
  } catch {
    // best-effort; memory failures must not surface to the pivot caller
  }

  // ---------------------------------------------------------------------------
  // Operation log (mirrors task_start / task_stop conventions)
  // ---------------------------------------------------------------------------
  await logOperation(
    'task_pivot',
    fromTaskId,
    {
      pivotId,
      toTaskId,
      reason,
      sessionId,
      agentId,
      blockedFrom,
      memoryObservationId,
    },
    acc,
  );

  return {
    pivotId,
    auditEntry,
    fromTaskId,
    toTaskId,
    reason,
    timestamp,
    sessionId,
    agentId,
    blockedFrom,
    memoryObservationId,
  };
}
