/**
 * Backfill audit columns (modified_by / session_id) for pre-ADR-051 completed tasks.
 *
 * 176 completed tasks shipped before ADR-051 have `modified_by=NULL` and
 * `session_id=NULL`. This module uses the T1322 `reconstructLineage` SDK
 * to mine git history for Co-Authored-By trailers, infers the modifying agent,
 * and writes the result back via `accessor.updateTaskFields`.
 *
 * **Inference strategy (in order)**:
 * 1. Get direct commits via `reconstructLineage(taskId, repoRoot)`.
 * 2. For each direct commit SHA, fetch the full commit body and parse
 *    `Co-Authored-By:` trailers → agent name.
 * 3. Use the earliest Co-Authored-By agent as `modified_by`.
 * 4. Match `completedAt` against known sessions (±60 min window).
 * 5. Fall back to `"unknown-pre-adr-051"` when no evidence is found.
 *
 * Security: git subprocess uses `execFileSync` with strict `argv` arrays —
 * no shell interpolation or user-controlled string concatenation in the
 * command string.
 *
 * **Idempotency**: tasks already having a non-null `modified_by` are skipped.
 *
 * @task T1321
 * @epic T1415
 */

import { execFileSync } from 'node:child_process';
import type { Session, Task } from '@cleocode/contracts';
import { getAccessor, reconstructLineage } from '@cleocode/core/internal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome record for a single task. */
export interface AuditColumnBackfillEntry {
  /** Task ID. */
  taskId: string;
  /** Task title (for human-readable reports). */
  title: string;
  /** Inferred agent name, or null on no-evidence gap. */
  modifiedBy: string | null;
  /** Inferred session ID, or null. */
  sessionId: string | null;
  /** True if git evidence was found (at least one direct commit). */
  hasGitEvidence: boolean;
  /** Number of direct commits found. */
  directCommitCount: number;
  /** The Co-Authored-By value extracted from git, if any. */
  coAuthoredBy: string | null;
  /** True when this task was skipped because modified_by was already set. */
  alreadySet: boolean;
  /** True when changes were written (not dry-run, not already-set). */
  written: boolean;
  /** Error message if something went wrong. */
  error?: string;
}

/** Summary returned by `backfillAuditColumns`. */
export interface AuditColumnBackfillResult {
  /** True when run in preview mode (no writes). */
  dryRun: boolean;
  /** Total tasks in scope (done + archived with null modified_by). */
  tasksInScope: number;
  /** Tasks already having modified_by — skipped. */
  alreadySet: number;
  /** Tasks where git evidence was found and modified_by was inferred. */
  inferred: number;
  /** Tasks where no git evidence existed — fell back to unknown marker. */
  gapCount: number;
  /** IDs of gap tasks (no inference possible). */
  gapTaskIds: string[];
  /** Full per-task results. */
  entries: AuditColumnBackfillEntry[];
}

/** Options for `backfillAuditColumns`. */
export interface AuditColumnBackfillOptions {
  /** Preview mode: compute inference but do not write. Default: false. */
  dryRun?: boolean;
  /** Restrict processing to these task IDs (default: all eligible tasks). */
  taskIds?: string[];
  /** Absolute path to the git repo root. Defaults to projectRoot. */
  repoRoot?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers — git subprocess (strict argv, no shell interpolation)
// ---------------------------------------------------------------------------

/**
 * Run a git command with strict argv (no shell interpolation).
 *
 * @param cwd - Working directory.
 * @param args - Argument list passed directly to git.
 * @returns stdout as a trimmed UTF-8 string, or `""` on error.
 */
function runGit(cwd: string, args: readonly string[]): string {
  try {
    const output = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
    return output.trim();
  } catch {
    return '';
  }
}

/**
 * Fetch the full commit body for a SHA and extract `Co-Authored-By:` trailers.
 *
 * Returns the first Co-Authored-By name found (e.g. `"Claude Sonnet 4.6"`),
 * or `null` when none is present.
 *
 * @param repoRoot - Absolute path to the git repository.
 * @param sha - Full commit SHA.
 */
function extractCoAuthoredBy(repoRoot: string, sha: string): string | null {
  const body = runGit(repoRoot, ['log', '-1', '--format=%B', sha]);
  if (!body) return null;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Match both "Co-Authored-By:" and "Co-authored-by:" (case-insensitive)
    const match = trimmed.match(/^Co-Authored-By:\s*(.+?)\s*<[^>]+>\s*$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find a session whose `endedAt` or `startedAt` window overlaps the given
 * task `completedAt` timestamp (±60 minutes tolerance).
 *
 * Returns the session ID string, or `null` when no match is found.
 *
 * @param sessions - All sessions loaded from the accessor.
 * @param completedAt - ISO-8601 timestamp of when the task was completed.
 */
function findSessionForCompletedAt(sessions: Session[], completedAt: string | null): string | null {
  if (!completedAt) return null;

  const completedMs = Date.parse(completedAt);
  if (Number.isNaN(completedMs)) return null;

  const WINDOW_MS = 60 * 60 * 1000; // 60 minutes

  for (const session of sessions) {
    const startMs = Date.parse(session.startedAt);
    const endMs = session.endedAt ? Date.parse(session.endedAt) : null;

    // Task was completed inside or near this session's time range
    if (!Number.isNaN(startMs)) {
      const sessionEnd = endMs ?? startMs + 24 * 60 * 60 * 1000; // 24h fallback
      if (completedMs >= startMs - WINDOW_MS && completedMs <= sessionEnd + WINDOW_MS) {
        return session.id;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Backfill `modified_by` and `session_id` for pre-ADR-051 completed tasks.
 *
 * Processes all tasks whose `status` is `done` or `archived` and whose
 * `provenance.modifiedBy` is null. For each, calls `reconstructLineage` to
 * mine git commit history, extracts the `Co-Authored-By` agent, and writes
 * the inferred values via `accessor.updateTaskFields`.
 *
 * Tasks with no git evidence receive the fallback marker
 * `"unknown-pre-adr-051"` as `modified_by` so they are no longer in the
 * null cohort (and the gap is documented).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param options - Backfill options (dryRun, taskIds, repoRoot).
 * @returns Full summary including per-task entries and gap list.
 *
 * @example
 * ```ts
 * // Dry run — preview only
 * const result = await backfillAuditColumns('/my/project', { dryRun: true });
 * console.log(`Would backfill ${result.inferred} tasks, ${result.gapCount} gaps`);
 *
 * // Apply
 * await backfillAuditColumns('/my/project');
 * ```
 *
 * @task T1321
 * @epic T1415
 */
export async function backfillAuditColumns(
  projectRoot: string,
  options: AuditColumnBackfillOptions = {},
): Promise<AuditColumnBackfillResult> {
  const { dryRun = false, taskIds, repoRoot = projectRoot } = options;

  const accessor = await getAccessor(projectRoot);

  // --- Load sessions for window-based session_id lookup ---
  const sessions = await accessor.loadSessions();

  // --- Collect eligible tasks: done + archived, NULL modified_by ---
  // Query done tasks
  const { tasks: doneTasks } = await accessor.queryTasks({ status: 'done' });
  // Query archived tasks (need to include archived in status)
  const { tasks: archivedTasks } = await accessor.queryTasks({ status: 'archived' });

  const allCompletedTasks: Task[] = [...doneTasks, ...archivedTasks];

  // Filter: null or missing modifiedBy only
  const eligible = allCompletedTasks.filter((t) => !t.provenance?.modifiedBy);

  // Optionally restrict to provided task IDs
  const inScope = taskIds ? eligible.filter((t) => taskIds.includes(t.id)) : eligible;

  const entries: AuditColumnBackfillEntry[] = [];
  let alreadySetCount = 0;
  let inferredCount = 0;
  let gapCount = 0;
  const gapTaskIds: string[] = [];

  const now = new Date().toISOString();

  for (const task of inScope) {
    // Double-check: skip if already set (idempotent guard)
    if (task.provenance?.modifiedBy) {
      entries.push({
        taskId: task.id,
        title: task.title,
        modifiedBy: task.provenance.modifiedBy,
        sessionId: task.provenance.sessionId ?? null,
        hasGitEvidence: false,
        directCommitCount: 0,
        coAuthoredBy: null,
        alreadySet: true,
        written: false,
      });
      alreadySetCount++;
      continue;
    }

    let coAuthoredBy: string | null = null;
    let hasGitEvidence = false;
    let directCommitCount = 0;
    let errorMsg: string | undefined;

    try {
      // Mine git history via T1322 reconstructLineage SDK
      const lineage = await reconstructLineage(task.id, repoRoot);
      directCommitCount = lineage.directCommits.length;
      hasGitEvidence = directCommitCount > 0;

      // Extract Co-Authored-By from earliest direct commit
      if (hasGitEvidence) {
        // Sort by authorDate ascending to get the earliest commit first
        const sorted = [...lineage.directCommits].sort((a, b) =>
          a.authorDate < b.authorDate ? -1 : a.authorDate > b.authorDate ? 1 : 0,
        );
        for (const commit of sorted) {
          const coAuthor = extractCoAuthoredBy(repoRoot, commit.sha);
          if (coAuthor) {
            coAuthoredBy = coAuthor;
            break;
          }
        }
        // If no Co-Authored-By trailer found, use the commit author as fallback
        if (!coAuthoredBy && sorted[0]) {
          coAuthoredBy = sorted[0].author;
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    // Determine final modifiedBy value
    const modifiedBy: string = coAuthoredBy ?? 'unknown-pre-adr-051';
    const isGap = !hasGitEvidence || !coAuthoredBy;
    if (isGap) {
      gapCount++;
      gapTaskIds.push(task.id);
    } else {
      inferredCount++;
    }

    // Session ID: window-based lookup against task completedAt
    const sessionId = findSessionForCompletedAt(sessions, task.completedAt ?? null);

    const entry: AuditColumnBackfillEntry = {
      taskId: task.id,
      title: task.title,
      modifiedBy,
      sessionId,
      hasGitEvidence,
      directCommitCount,
      coAuthoredBy,
      alreadySet: false,
      written: false,
      error: errorMsg,
    };

    // Write unless dry-run
    if (!dryRun) {
      try {
        await accessor.updateTaskFields(task.id, {
          modifiedBy,
          sessionId: sessionId ?? null,
          updatedAt: now,
        });
        entry.written = true;
      } catch (writeErr) {
        entry.error =
          (entry.error ? `${entry.error}; ` : '') +
          `write failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`;
      }
    }

    entries.push(entry);
  }

  return {
    dryRun,
    tasksInScope: inScope.length,
    alreadySet: alreadySetCount,
    inferred: inferredCount,
    gapCount,
    gapTaskIds,
    entries,
  };
}
