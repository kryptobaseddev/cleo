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
import type { Task, TaskStatus } from '@cleocode/contracts';
import { TASK_STATUSES } from '@cleocode/contracts';
import { loadConfig } from '../config.js';
import { type EngineResult, engineError } from '../engine-result.js';
import { analyzeDependencies } from '../orchestration/analyze.js';
import { estimateContext } from '../orchestration/context.js';
import { analyzeEpic, getNextTask, getReadyTasks } from '../orchestration/index.js';
import { computeEpicStatus, computeOverallStatus } from '../orchestration/status.js';
import { validateSpawnReadiness } from '../orchestration/validate-spawn.js';
import type { EnrichedWave } from '../orchestration/waves.js';
import { getEnrichedWaves } from '../orchestration/waves.js';
import { getProjectRoot } from '../paths.js';
import { SAGA_GROUPS_RELATION, SAGA_LABEL } from '../sagas/constants.js';
import { isSagaShape } from '../sagas/enforcement.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import type { DepGraphIssue } from '../tasks/dep-graph-validator.js';
import { runValidation } from '../tasks/dep-graph-validator.js';
import type {
  OrchestrateReportEntry,
  OrchestrateReportGroup,
  OrchestrateReportParams,
} from '@cleocode/contracts';

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

// ---------------------------------------------------------------------------
// Saga traversal (gh-390 / ADR-073)
// ---------------------------------------------------------------------------

/**
 * Traversal mode for {@link orchestrateReady} and {@link orchestrateWaves}.
 *
 * Sagas (tasks with `type='saga'`) hold their member Epics via
 * `task_relations.type='groups'` edges instead of the `parentId` column
 * (ADR-073). The query-ops historically walked only `parentId`, so sagas
 * appeared childless.
 *
 * - `'parent'` — legacy behaviour: walk `parentId` only (sagas return empty).
 * - `'saga'`   — walk `relates[type='groups']` only (regular epics return empty).
 * - `'both'`   — auto-detect: walk groups when the target is saga-labeled,
 *                otherwise walk `parentId`. Default for callers that don't
 *                care which storage shape the epic uses.
 *
 * @bug gh-390
 * @adr ADR-073
 * @task T9839
 */
export type OrchestrateTraversal = 'parent' | 'saga' | 'both';

/**
 * Single source of truth for the saga-shaped-epic check (ADR-073).
 *
 * Dual-shape acceptance (T10331, Saga T10326 W2.B):
 *   - Canonical post-migration shape: `type === 'saga'` — first-class
 *     {@link TaskType} value introduced by W1.A T10328 (ADR-083 §2.5).
 *   - Legacy label-encoded shape: `type === 'epic' && labels.includes('saga')`
 *     — still produced by fixtures and not-yet-migrated rows during the
 *     deprecation window. Removed in W3.C cutover (T10334).
 *
 * Sagas are top-level grouping nodes whose members are linked via
 * `task_relations.type='groups'` rather than `parentId`.
 *
 * @param task - The task to inspect. Pass either a fully-loaded {@link Task}
 *               (with `labels` populated by `loadSingleTask` / `queryTasks`)
 *               or `null`/`undefined` (returns `false`).
 * @returns `true` when `task` is a saga under either shape.
 *
 * @deprecated Prefer {@link isSagaShape} (`packages/core/src/sagas/enforcement.ts`)
 *   when the caller holds a fully-typed {@link Task} — it returns a
 *   compile-time type-narrowing predicate (`task is SagaTask`) instead of a
 *   plain `boolean`. `isSagaEpic` remains for the in-file query-ops callers
 *   that hold `Pick<Task,'type'|'labels'>` rows.
 *
 * @bug gh-390
 * @adr ADR-073
 * @adr ADR-083 — Saga as first-class TaskType
 * @task T9839
 * @task T10331
 */
export function isSagaEpic(task: Pick<Task, 'type' | 'labels'> | null | undefined): boolean {
  if (!task) return false;
  // New shape — first-class 'saga' TaskType (T10277 cutover).
  if (task.type === 'saga') return true;
  // Old shape — labelled epic (deprecation-window dual acceptance, T10334 drops).
  if (task.type !== 'epic') return false;
  return (task.labels ?? []).includes(SAGA_LABEL);
}

/**
 * Extract member-Epic IDs from a saga's `relates` array.
 *
 * Walks {@link Task.relates} and returns the `taskId` of every entry whose
 * `type === 'groups'`. Order is preserved (insertion order from the
 * data-accessor) and duplicates are removed. Non-saga tasks return an empty
 * array — callers MUST gate on {@link isSagaEpic} first.
 *
 * @param sagaTask - A saga-labeled epic with `relates` populated.
 * @returns Deduplicated list of member Epic IDs in stable order.
 *
 * @bug gh-390
 * @adr ADR-073
 * @task T9839
 */
export function resolveSagaMembers(sagaTask: Pick<Task, 'relates'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const relation of sagaTask.relates ?? []) {
    if (relation.type !== SAGA_GROUPS_RELATION) continue;
    if (seen.has(relation.taskId)) continue;
    seen.add(relation.taskId);
    out.push(relation.taskId);
  }
  return out;
}

/**
 * Load all tasks from task data.
 *
 * @param projectRoot - Optional project root path. Defaults to resolved root.
 * @returns Array of all tasks, empty on error.
 */
export async function loadTasks(projectRoot?: string): Promise<Task[]> {
  const root = getProjectRoot(projectRoot);
  try {
    const accessor = await getTaskAccessor(root);
    const result = await accessor.queryTasks({
      status: [...TASK_STATUSES] as TaskStatus[],
    });
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
    const root = getProjectRoot(projectRoot);
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
    const root = getProjectRoot(projectRoot);
    const accessor = await getTaskAccessor(root);
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

  /**
   * Traversal mode for resolving the epic's children (ADR-073 / gh-390).
   *
   * - `'parent'` — walk only the `parentId` column (legacy behaviour).
   * - `'saga'`   — walk only `task_relations.type='groups'` edges.
   * - `'both'`   — auto-detect saga-labeled epics and walk the groups edge,
   *                otherwise fall back to the `parentId` walk. Default.
   *
   * Saga members (themselves Epics) are recursed into per-member; the result
   * is the deduplicated union of ready tasks across all members. A guard
   * prevents infinite recursion if a member is itself saga-labeled.
   *
   * @bug gh-390
   * @adr ADR-073
   * @task T9839
   */
  via?: OrchestrateTraversal;
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
    const root = getProjectRoot(projectRoot);
    // T929: verify the epic exists before computing the ready-set so that a
    // nonexistent epicId returns E_NOT_FOUND (exit 4) instead of success:{total:0}.
    const tasks = await loadTasks(root);
    const epic = tasks.find((t) => t.id === epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
    }

    // ---------------------------------------------------------------------------
    // T1858: dep-graph validation pre-step (shared between parent + saga modes)
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

    // -------------------------------------------------------------------------
    // gh-390 / ADR-073: saga-aware traversal
    //
    // A saga (Epic with labels='saga') holds its members via
    // task_relations.type='groups', NOT via parentId. The legacy ready-walk
    // only inspected getChildren(parentId), so sagas returned empty. We now
    // detect the saga shape and aggregate ready-sets across member epics.
    // -------------------------------------------------------------------------
    const via: OrchestrateTraversal = opts?.via ?? 'both';
    // T10331 (Saga T10326 W2.B): dual-shape saga detection via isSagaShape.
    const sagaShaped = isSagaShape(epic);
    const useSagaWalk = via === 'saga' || (via === 'both' && sagaShaped);

    const accessor = await getTaskAccessor(root);

    type ReadyTaskOut = {
      id: string;
      title: string;
      priority: string;
      depends: string[];
    };

    if (useSagaWalk) {
      // We need the saga's `relates` populated. `tasks` from queryTasks does
      // not include relations by default — pull the saga via loadSingleTask.
      const sagaWithRelates = await accessor.loadSingleTask(epicId);
      const members = sagaWithRelates ? resolveSagaMembers(sagaWithRelates) : [];

      const seenIds = new Set<string>();
      const aggregated: ReadyTaskOut[] = [];
      let aggregatedAllCount = 0;
      let aggregatedBlockedCount = 0;
      const skippedNested: string[] = [];

      for (const memberId of members) {
        // Recursion safety: sagas SHOULD NOT nest (ADR-073). If a member is
        // itself saga-labeled, skip it and surface the anomaly in meta rather
        // than recursing — preserves O(N) aggregation.
        const memberTask = tasks.find((t) => t.id === memberId);
        // T10331 (Saga T10326 W2.B): dual-shape saga detection via isSagaShape.
        if (memberTask && isSagaShape(memberTask)) {
          skippedNested.push(memberId);
          continue;
        }

        const memberReady = await getReadyTasks(memberId, root, accessor);
        aggregatedAllCount += memberReady.length;
        aggregatedBlockedCount += memberReady.filter(
          (t) => !t.ready && t.blockers.length > 0,
        ).length;

        for (const t of memberReady) {
          if (!t.ready) continue;
          if (seenIds.has(t.taskId)) continue;
          seenIds.add(t.taskId);
          aggregated.push({
            id: t.taskId,
            title: t.title,
            priority: t.priority,
            depends: t.depends,
          });
        }
      }

      // Preserve priority ordering (critical → high → medium → low) then ID.
      const priorityWeight: Record<string, number> = {
        critical: 4,
        high: 3,
        medium: 2,
        low: 1,
      };
      aggregated.sort((a, b) => {
        const wa = priorityWeight[a.priority] ?? 0;
        const wb = priorityWeight[b.priority] ?? 0;
        if (wa !== wb) return wb - wa;
        return a.id.localeCompare(b.id);
      });

      let reason: string | undefined;
      if (aggregated.length === 0) {
        if (members.length === 0) {
          reason = 'saga has no member epics';
        } else if (aggregatedAllCount === 0) {
          reason = 'saga members have no children';
        } else if (aggregatedBlockedCount === aggregatedAllCount) {
          reason = 'all saga-member tasks have unmet dependencies';
        } else {
          reason = 'no saga-member tasks with unmet dependencies found';
        }
      }

      return {
        success: true,
        data: {
          epicId,
          readyTasks: aggregated,
          total: aggregated.length,
          via: 'saga',
          sagaMembers: members,
          ...(skippedNested.length > 0 && { sagaNestedSkipped: skippedNested }),
          ...(reason !== undefined && { reason }),
          ...(depsWarning !== undefined && { depsWarning }),
        },
      };
    }

    // Default / via='parent': legacy parentId-walk.
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
          priority: t.priority,
          depends: t.depends,
        })),
        total: ready.length,
        via: 'parent' as const,
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
    const root = getProjectRoot(projectRoot);
    const accessor = await getTaskAccessor(root);
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
        nextTask: { id: nextTask.taskId, title: nextTask.title, priority: nextTask.priority },
        alternatives: ready
          .slice(1, 4)
          .map((t) => ({ id: t.taskId, title: t.title, priority: t.priority })),
        totalReady: ready.length,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * Options for {@link orchestrateWaves}.
 *
 * @bug gh-390
 * @adr ADR-073
 * @task T9839
 */
export interface OrchestrateWavesOptions {
  /**
   * Traversal mode for resolving the epic's children — see
   * {@link OrchestrateTraversal}. Default `'both'`.
   *
   * @bug gh-390
   * @adr ADR-073
   * @task T9839
   */
  via?: OrchestrateTraversal;
}

/**
 * orchestrate.waves - Compute dependency waves
 *
 * For regular epics the wave plan is `getEnrichedWaves(epicId)`. For sagas
 * (Epics labeled `'saga'`, ADR-073), per-member wave plans are computed and
 * merged by wave index: wave N across all members becomes one unified wave N.
 * Members of unequal depth contribute to the trailing waves (longest tail
 * wins). Task IDs are deduplicated; per-wave order preserves the per-member
 * sort.
 *
 * @param epicId - Epic to compute waves for.
 * @param projectRoot - Optional project root path.
 * @param opts - Optional traversal flag ({@link OrchestrateWavesOptions}).
 * @returns Engine result with wave data.
 * @task T4478
 * @bug gh-390
 * @adr ADR-073
 */
export async function orchestrateWaves(
  epicId: string,
  projectRoot?: string,
  opts?: OrchestrateWavesOptions,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = getProjectRoot(projectRoot);
    const accessor = await getTaskAccessor(root);

    // gh-390 / ADR-073: detect saga shape so we walk the groups relation.
    const epic = await accessor.loadSingleTask(epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
    }

    const via: OrchestrateTraversal = opts?.via ?? 'both';
    // T10331 (Saga T10326 W2.B): dual-shape saga detection via isSagaShape.
    const sagaShaped = isSagaShape(epic);
    const useSagaWalk = via === 'saga' || (via === 'both' && sagaShaped);

    if (!useSagaWalk) {
      const result = await getEnrichedWaves(epicId, root, accessor);
      return {
        success: true,
        data: { ...result, via: 'parent' as const },
      };
    }

    // Saga walk: compute per-member waves and merge by index.
    const members = resolveSagaMembers(epic);
    const skippedNested: string[] = [];
    const perMemberWaves: EnrichedWave[][] = [];
    let totalChildren = 0;

    for (const memberId of members) {
      const memberTask = await accessor.loadSingleTask(memberId);
      // T10331 (Saga T10326 W2.B): dual-shape saga detection via isSagaShape.
      if (memberTask && isSagaShape(memberTask)) {
        skippedNested.push(memberId);
        continue;
      }
      const memberResult = await getEnrichedWaves(memberId, root, accessor);
      perMemberWaves.push(memberResult.waves);
      totalChildren += memberResult.totalTasks;
    }

    const maxWaves = perMemberWaves.reduce((m, w) => Math.max(m, w.length), 0);
    const mergedWaves: EnrichedWave[] = [];

    for (let i = 0; i < maxWaves; i++) {
      const seen = new Set<string>();
      const mergedTasks: EnrichedWave['tasks'] = [];
      let anyInProgress = false;
      let allCompleted = true;
      let latestCompletedAt: string | undefined;

      for (const memberWaves of perMemberWaves) {
        const wave = memberWaves[i];
        if (!wave) continue;
        if (wave.status === 'in_progress') anyInProgress = true;
        if (wave.status !== 'completed') allCompleted = false;
        if (wave.completedAt && (!latestCompletedAt || wave.completedAt > latestCompletedAt)) {
          latestCompletedAt = wave.completedAt;
        }
        for (const t of wave.tasks) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          mergedTasks.push(t);
        }
      }

      const mergedStatus: EnrichedWave['status'] = allCompleted
        ? 'completed'
        : anyInProgress
          ? 'in_progress'
          : 'pending';

      const merged: EnrichedWave = {
        waveNumber: i + 1,
        status: mergedStatus,
        tasks: mergedTasks,
        taskIds: mergedTasks.map((t) => t.id),
      };
      if (mergedStatus === 'completed' && latestCompletedAt) {
        merged.completedAt = latestCompletedAt;
      }
      mergedWaves.push(merged);
    }

    return {
      success: true,
      data: {
        epicId,
        waves: mergedWaves,
        totalWaves: mergedWaves.length,
        totalTasks: totalChildren,
        via: 'saga' as const,
        sagaMembers: members,
        ...(skippedNested.length > 0 && { sagaNestedSkipped: skippedNested }),
      },
    };
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
    const root = getProjectRoot(projectRoot);
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
    const root = getProjectRoot(projectRoot);
    const accessor = await getTaskAccessor(root);
    const result = await validateSpawnReadiness(taskId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_VALIDATION', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// orchestrate.report — grouped readiness report
// ---------------------------------------------------------------------------

/** @task T10631 */
const DEFAULT_REPORT_PAGE_SIZE = 50;
/** @task T10631 */
const MAX_REPORT_PAGE_SIZE = 200;

/**
 * orchestrate.report — Grouped readiness report
 *
 * Classifies every non-done, non-cancelled child task of an epic into one of
 * five readiness groups: ready, blocked (has unmet deps), blockedBy (lists
 * specific blocker IDs), gateBlocked (gates like implemented/testsPassed/
 * qaPassed not satisfied), or invalid (structural issues like missing
 * dependencies or circular chains).
 *
 * Supports pagination via `page` and `pageSize`. Aligns its ready-group
 * frontier with `orchestrate.ready` / `orchestrate.next`.
 *
 * @param epicId - Epic to compute the report for.
 * @param projectRoot - Optional project root path.
 * @param params - Pagination options.
 * @returns Engine result with grouped readiness report.
 * @task T10631
 */
export async function orchestrateReport(
  epicId: string,
  projectRoot?: string,
  params?: OrchestrateReportParams,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = getProjectRoot(projectRoot);
    const accessor = await getTaskAccessor(root);
    const tasks = await loadTasks(root);

    const epic = tasks.find((t) => t.id === epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
    }

    const children = tasks.filter((t) => t.parentId === epicId);
    const completedIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));

    // Classification buckets
    const ready: OrchestrateReportEntry[] = [];
    const blocked: OrchestrateReportEntry[] = [];
    const blockedBy: OrchestrateReportEntry[] = [];
    const gateBlocked: OrchestrateReportEntry[] = [];
    const invalid: OrchestrateReportEntry[] = [];

    // Dependency analysis for invalid detection
    const depAnalysis = analyzeDependencies(children, tasks);
    const missingDepIds = new Set(depAnalysis.missingDependencies);
    const circularInvolved = new Set<string>();
    for (const chain of depAnalysis.circularDependencies) {
      for (const id of chain) circularInvolved.add(id);
    }

    for (const task of children) {
      // Skip terminal states
      if (task.status === 'done' || task.status === 'cancelled') continue;

      const deps = task.depends ?? [];
      const unmetDeps = deps.filter((d) => !completedIds.has(d));
      const gates = task.gates ?? {};
      const gateKeys = Object.keys(gates) as Array<keyof typeof gates>;

      // --- Invalid classification ---
      const hasMissingDeps = deps.some((d) => missingDepIds.has(d));
      const isCircular = circularInvolved.has(task.id);

      if (hasMissingDeps || isCircular) {
        const reasons: string[] = [];
        if (hasMissingDeps) reasons.push('missing-dep');
        if (isCircular) reasons.push('circular-dep');
        invalid.push({
          id: task.id,
          title: task.title,
          priority: task.priority ?? 'medium',
          status: task.status,
          reason: reasons.join(', '),
        });
        continue;
      }

      // --- Gate-blocked classification ---
      const requiredGates = ['implemented', 'testsPassed', 'qaPassed'];
      const failedGates = requiredGates.filter((g) => gates[g] === false);
      const hasPendingGates = requiredGates.some(
        (g) => gates[g] === undefined || gates[g] === null,
      );
      // A task is gate-blocked if any required gate is explicitly false,
      // or if gates are absent/undefined AND the task is pending (not yet started)
      if (
        failedGates.length > 0 ||
        (hasPendingGates && task.status === 'pending' && !(gates as Record<string, unknown>)['implemented'])
      ) {
        const gateSummary: Record<string, boolean> = {};
        for (const g of requiredGates) {
          gateSummary[g] = gates[g] === true;
        }
        gateBlocked.push({
          id: task.id,
          title: task.title,
          priority: task.priority ?? 'medium',
          status: task.status,
          reason: failedGates.length > 0
            ? `gates-failed: ${failedGates.join(',')}`
            : 'gates-incomplete',
          gates: gateSummary,
        });
        continue;
      }

      // --- Blocked-by classification ---
      if (unmetDeps.length > 0) {
        blockedBy.push({
          id: task.id,
          title: task.title,
          priority: task.priority ?? 'medium',
          status: task.status,
          reason: unmetDeps.join(', '),
        });
        // Also add to plain "blocked" for the broader blocked group
        blocked.push({
          id: task.id,
          title: task.title,
          priority: task.priority ?? 'medium',
          status: task.status,
          reason: `${unmetDeps.length} unmet dep(s)`,
        });
        continue;
      }

      // --- Ready classification ---
      ready.push({
        id: task.id,
        title: task.title,
        priority: task.priority ?? 'medium',
        status: task.status,
        reason: 'ready',
      });
    }

    // Build groups
    const groups: OrchestrateReportGroup[] = [
      {
        group: 'ready',
        label: 'Ready — parallel-safe, actionable now',
        count: ready.length,
        tasks: ready,
      },
      {
        group: 'blocked',
        label: 'Blocked — has unmet dependency counts',
        count: blocked.length,
        tasks: blocked,
      },
      {
        group: 'blockedBy',
        label: 'Blocked-by — lists specific blocker task IDs',
        count: blockedBy.length,
        tasks: blockedBy,
      },
      {
        group: 'gateBlocked',
        label: 'Gate-blocked — gates (implemented/testsPassed/qaPassed) not satisfied',
        count: gateBlocked.length,
        tasks: gateBlocked,
      },
      {
        group: 'invalid',
        label: 'Invalid — missing or circular dependencies',
        count: invalid.length,
        tasks: invalid,
      },
    ];

    // Pagination
    const pageSize = Math.min(params?.pageSize ?? DEFAULT_REPORT_PAGE_SIZE, MAX_REPORT_PAGE_SIZE);
    const page = Math.max(params?.page ?? 1, 1);
    const totalEntries = groups.reduce((sum, g) => sum + g.count, 0);
    const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));

    // Apply pagination — slice tasks across all groups
    if (totalEntries > pageSize) {
      const startIdx = (page - 1) * pageSize;
      const endIdx = startIdx + pageSize;
      let globalIdx = 0;

      for (const group of groups) {
        const groupStart = globalIdx;
        const groupEnd = globalIdx + group.tasks.length;

        if (groupEnd <= startIdx || groupStart >= endIdx) {
          // Group entirely outside the current page
          group.tasks = [];
        } else {
          const sliceStart = Math.max(0, startIdx - groupStart);
          const sliceEnd = Math.min(group.tasks.length, endIdx - groupStart);
          group.tasks = group.tasks.slice(sliceStart, sliceEnd);
        }

        globalIdx = groupEnd;
      }
    }

    return {
      success: true,
      data: {
        epicId,
        epicTitle: epic.title,
        totalTasks: children.length,
        groups,
        pagination: {
          page,
          pageSize,
          totalPages,
          totalEntries,
        },
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}
