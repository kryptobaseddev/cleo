/**
 * Orchestrate Query Operations
 *
 * Status, analyze, ready, next, waves, context, and validate wrappers
 * migrated from packages/cleo/src/dispatch/engines/orchestrate-engine.ts.
 *
 * @task T1570
 * @task T4478
 * @task T1858
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { loadConfig } from '../config.js';
import { type EngineResult, engineError } from '../engine-result.js';
import { analyzeDependencies } from '../orchestration/analyze.js';
import { estimateContext } from '../orchestration/context.js';
import { analyzeEpic, getNextTask, getReadyTasks } from '../orchestration/index.js';
import { computeEpicStatus, computeOverallStatus } from '../orchestration/status.js';
import { validateSpawnReadiness } from '../orchestration/validate-spawn.js';
import { getEnrichedWaves } from '../orchestration/waves.js';
import { getAccessor } from '../store/data-accessor.js';
import { resolveProjectRoot } from '../store/file-utils.js';
import type { DepGraphIssue } from '../tasks/dep-graph-validator.js';
import { runValidation } from '../tasks/dep-graph-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Project-relative path for the orchestrate deps-validate bypass audit log.
 *
 * @task T1858
 */
export const ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE = '.cleo/audit/orchestrate-deps-bypass.jsonl';

// ---------------------------------------------------------------------------
// Audit entry type
// ---------------------------------------------------------------------------

/**
 * A single audit entry written to {@link ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE}
 * when `--ignore-deps-validate` is used on `cleo orchestrate ready`.
 *
 * @task T1858
 */
export interface OrchestrateDepsAuditEntry {
  /** ISO-8601 timestamp of the bypass. */
  ts: string;
  /** The epic ID passed to `cleo orchestrate ready`. */
  epicId: string;
  /** Where the bypass originated: 'cli' (flag) or 'sentient' (programmatic). */
  source: 'cli' | 'sentient';
  /** Number of dep-graph issues that were bypassed. */
  issueCount: number;
  /** The actual issues that were bypassed (may be empty when valid). */
  issues: Pick<DepGraphIssue, 'code' | 'taskId' | 'epicA' | 'epicB'>[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Append one {@link OrchestrateDepsAuditEntry} to
 * `.cleo/audit/orchestrate-deps-bypass.jsonl`.
 *
 * Errors are swallowed: an audit-write failure MUST NOT change the ready-set
 * response (follows the same pattern as `appendContractViolation` /
 * `appendWorkerMismatchAudit`).
 *
 * @param projectRoot - Absolute project root path.
 * @param entry - Audit entry to append.
 *
 * @internal
 * @task T1858
 */
export function appendDepsValidateBypassAudit(
  projectRoot: string,
  entry: OrchestrateDepsAuditEntry,
): void {
  try {
    const filePath = join(projectRoot, ORCHESTRATE_DEPS_BYPASS_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch {
    // non-fatal — audit must not block the ready-set response
  }
}

export type { EngineResult };

/**
 * Load all tasks from task data.
 *
 * @param projectRoot - Optional project root path. Defaults to resolved root.
 * @returns Array of all tasks, empty on error.
 */
export async function loadTasks(projectRoot?: string): Promise<Task[]> {
  const root = projectRoot || resolveProjectRoot();
  try {
    const accessor = await getAccessor(root);
    const result = await accessor.queryTasks({});
    return result?.tasks ?? [];
  } catch {
    return [];
  }
}

/**
 * orchestrate.status - Get orchestrator status
 *
 * @param epicId - Optional epic id to scope status to a single epic.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with status data.
 * @task T4478
 */
export async function orchestrateStatus(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const tasks = await loadTasks(root);

    if (epicId) {
      const epic = tasks.find((t) => t.id === epicId);
      if (!epic) {
        return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
      }

      const children = tasks.filter((t) => t.parentId === epicId);
      const status = computeEpicStatus(epicId, epic.title, children);

      return { success: true, data: status };
    }

    // No epicId - return overall status
    const status = computeOverallStatus(tasks);
    return { success: true, data: status };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.analyze - Dependency analysis
 *
 * @param epicId - Epic to analyze (required unless mode is 'critical-path').
 * @param projectRoot - Optional project root path.
 * @param mode - Analysis mode. Use 'critical-path' to delegate to orchestrateCriticalPath.
 * @returns Engine result with analysis data.
 * @task T4478
 */
export async function orchestrateAnalyze(
  epicId?: string,
  projectRoot?: string,
  mode?: string,
): Promise<EngineResult> {
  // Mode: critical-path (delegates to critical path engine)
  if (mode === 'critical-path') {
    const { orchestrateCriticalPath } = await import('./lifecycle-ops.js');
    return orchestrateCriticalPath(projectRoot);
  }

  // Default mode: analysis (requires epicId)
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required for standard analysis');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await analyzeEpic(epicId, root, accessor);

    // Add dependency graph and circular dep detection via core analyze module
    const tasks = await loadTasks(root);
    const children = tasks.filter((t) => t.parentId === epicId);
    const depAnalysis = analyzeDependencies(children, tasks);

    return {
      success: true,
      data: {
        epicId: result.epicId,
        epicTitle: tasks.find((t) => t.id === epicId)?.title || epicId,
        totalTasks: result.totalTasks,
        waves: result.waves,
        circularDependencies: depAnalysis.circularDependencies,
        missingDependencies: depAnalysis.missingDependencies,
        dependencyGraph: depAnalysis.dependencyGraph,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * Options for {@link orchestrateReady}.
 *
 * @task T1858
 */
export interface OrchestrateReadyOptions {
  /**
   * When true, skip the dep-graph validation pre-check and proceed with
   * advertising the ready set regardless of graph health. The bypass is
   * audit-logged to `.cleo/audit/orchestrate-deps-bypass.jsonl`.
   *
   * CLI-only: programmatic callers (sentient tick, worktree-dispatch) MUST
   * NOT pass this flag. Bypass logic lives here so the sentinel is enforced
   * at the call-site closest to the source of truth.
   */
  ignoreDepsValidate?: boolean;
}

/**
 * orchestrate.ready - Get parallel-safe tasks (ready to execute)
 *
 * Before advertising the ready set, runs dep-graph validation over the epic's
 * children and respects `LifecycleConfig.mode`:
 *
 * - `strict`   — if `!valid`, refuse with `E_DEP_GRAPH_INVALID` + issues
 * - `advisory` — if `!valid`, warn in the response but proceed
 * - `off`      — skip validation entirely
 *
 * The `opts.ignoreDepsValidate` flag (CLI-only, audit-logged) bypasses the
 * check regardless of mode.
 *
 * @param epicId - Epic to find ready tasks for.
 * @param projectRoot - Optional project root path.
 * @param opts - Optional behaviour flags (see {@link OrchestrateReadyOptions}).
 * @returns Engine result with ready tasks data.
 * @task T4478
 * @task T1858
 */
export async function orchestrateReady(
  epicId: string,
  projectRoot?: string,
  opts?: OrchestrateReadyOptions,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    // T929: verify the epic exists before computing the ready-set so that a
    // nonexistent epicId returns E_NOT_FOUND (exit 4) instead of success:{total:0}.
    const tasks = await loadTasks(root);
    const epic = tasks.find((t) => t.id === epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
    }

    // ---------------------------------------------------------------------------
    // T1858: dep-graph validation pre-step
    // ---------------------------------------------------------------------------
    const config = await loadConfig(root);
    const lifecycleMode = config.lifecycle?.mode ?? 'strict';

    let depsWarning: string | undefined;

    // Helper: filter issues to only those that are actionable blockers for
    // the epic ready-set check. Excludes:
    //   - E_ORPHAN: project-level concern, not specific to the epic ready-check.
    //   - E_MISSING_REF where the referenced task EXISTS project-wide (cross-epic
    //     deps that are outside the scoped set are not truly missing).
    const projectTaskIds = new Set(tasks.map((t) => t.id));
    const toBlockerIssues = (issues: ReturnType<typeof runValidation>['issues']) =>
      issues.filter((i) => {
        if (i.code === 'E_ORPHAN') return false;
        if (i.code === 'E_MISSING_REF') {
          // relatedIds contains the dep ID that was reported missing in the scope.
          // If it actually exists project-wide, it's just a cross-epic dep — not a
          // true missing reference.
          return (i.relatedIds ?? []).some((depId) => !projectTaskIds.has(depId));
        }
        return true;
      });

    if (opts?.ignoreDepsValidate) {
      // Bypass requested — audit-log it regardless of mode, then skip check.
      const validation = runValidation(tasks, { epicId });
      const blockerIssues = toBlockerIssues(validation.issues);
      appendDepsValidateBypassAudit(root, {
        ts: new Date().toISOString(),
        epicId,
        source: 'cli',
        issueCount: blockerIssues.length,
        issues: blockerIssues.map(({ code, taskId, epicA, epicB }) => ({
          code,
          taskId,
          epicA,
          epicB,
        })),
      });
    } else if (lifecycleMode !== 'off') {
      const validation = runValidation(tasks, { epicId });
      const blockerIssues = toBlockerIssues(validation.issues);
      const isValid = blockerIssues.length === 0;

      if (!isValid) {
        const summary = `Dep graph has ${blockerIssues.length} issue(s): ${[...new Set(blockerIssues.map((i) => i.code))].join(', ')}`;

        if (lifecycleMode === 'strict') {
          return engineError('E_DEP_GRAPH_INVALID', summary, {
            details: { issueCount: blockerIssues.length, issues: blockerIssues },
          });
        }
        // advisory: warn + proceed
        depsWarning = summary;
      }
    }
    // mode === 'off': skip validation entirely
    // ---------------------------------------------------------------------------

    const accessor = await getAccessor(root);
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter((t) => t.ready);

    // T929: when no tasks are ready, include a diagnostic reason so callers
    // can distinguish "all done" from "all blocked" without a second query.
    let reason: string | undefined;
    if (ready.length === 0) {
      const all = readyTasks;
      const blockedCount = all.filter((t) => !t.ready && t.blockers.length > 0).length;
      if (all.length === 0) {
        reason = 'epic has no children';
      } else if (blockedCount === all.length) {
        reason = 'all children have unmet dependencies';
      } else {
        reason = 'no tasks with unmet dependencies found; check child task statuses';
      }
    }

    return {
      success: true,
      data: {
        epicId,
        readyTasks: ready.map((t) => ({
          id: t.taskId,
          title: t.title,
          priority: 'medium', // getReadyTasks doesn't return priority
          depends: t.blockers,
        })),
        total: ready.length,
        ...(reason !== undefined && { reason }),
        ...(depsWarning !== undefined && { depsWarning }),
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.next - Next task to spawn
 *
 * @param epicId - Epic to find the next task in.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with next task data.
 * @task T4478
 */
export async function orchestrateNext(epicId: string, projectRoot?: string): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const nextTask = await getNextTask(epicId, root, accessor);

    if (!nextTask) {
      return {
        success: true,
        data: {
          epicId,
          nextTask: null,
          message: 'No tasks ready to spawn. All pending tasks may have unmet dependencies.',
        },
      };
    }

    // Get all ready tasks for alternatives
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter((t) => t.ready);

    return {
      success: true,
      data: {
        epicId,
        nextTask: { id: nextTask.taskId, title: nextTask.title, priority: 'medium' },
        alternatives: ready
          .slice(1, 4)
          .map((t) => ({ id: t.taskId, title: t.title, priority: 'medium' })),
        totalReady: ready.length,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.waves - Compute dependency waves
 *
 * @param epicId - Epic to compute waves for.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with wave data.
 * @task T4478
 */
export async function orchestrateWaves(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getEnrichedWaves(epicId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.context - Context usage check
 *
 * @param epicId - Optional epic to scope context estimate to.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with context estimate data.
 * @task T4478
 */
export async function orchestrateContext(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const tasks = await loadTasks(root);

    let taskCount = tasks.length;
    if (epicId) {
      taskCount = tasks.filter((t) => t.parentId === epicId).length;
    }

    const contextData = estimateContext(taskCount, root, epicId);
    return { success: true, data: contextData };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.validate - Validate spawn readiness for a task
 *
 * @param taskId - Task to validate.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with validation data.
 * @task T4478
 */
export async function orchestrateValidate(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await validateSpawnReadiness(taskId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_VALIDATION', (err as Error).message);
  }
}
