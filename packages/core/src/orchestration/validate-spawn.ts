/**
 * Spawn readiness validation.
 *
 * @task T4784
 * @task T894 Atomic task enforcement (worker role rejects >3 files or no file scope)
 */

import type { AgentSpawnCapability } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { MAX_WORKER_FILES } from './atomicity.js';

export interface ValidationIssue {
  code: string;
  message: string;
  severity: string;
}

export interface SpawnValidationResult {
  taskId: string;
  title: string;
  ready: boolean;
  issues: ValidationIssue[];
}

/**
 * Optional context for spawn validation.
 *
 * Supplying `role` enables the T894 atomicity checks (V_ATOMIC_SCOPE_MISSING
 * and V_ATOMIC_SCOPE_TOO_LARGE). When omitted those checks are skipped so
 * existing call-sites that do not yet know the spawned role remain unaffected.
 */
export interface SpawnValidationContext {
  /**
   * The role the task will be spawned as.
   *
   * When `'worker'` (tier 0), the validator enforces:
   *  - `files` field is present and non-empty → `V_ATOMIC_SCOPE_MISSING`
   *  - `files` count ≤ {@link MAX_WORKER_FILES} → `V_ATOMIC_SCOPE_TOO_LARGE`
   *
   * Orchestrator and lead roles bypass the file-scope gate — they are
   * permitted inherently broader scope. Epic-type tasks are also exempt
   * regardless of role.
   */
  role?: AgentSpawnCapability;
}

/** Validate spawn readiness for a task. */
export async function validateSpawnReadiness(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
  context?: SpawnValidationContext,
): Promise<SpawnValidationResult> {
  const acc = accessor ?? (await getAccessor(cwd));
  const task = await acc.loadSingleTask(taskId);

  if (!task) {
    return {
      taskId,
      title: '',
      ready: false,
      issues: [{ code: 'V_NOT_FOUND', message: `Task ${taskId} not found`, severity: 'error' }],
    };
  }

  const issues: ValidationIssue[] = [];

  if (task.status === 'done') {
    issues.push({
      code: 'V_ALREADY_DONE',
      message: 'Task is already completed',
      severity: 'error',
    });
  }
  if (task.status === 'cancelled') {
    issues.push({ code: 'V_CANCELLED', message: 'Task is cancelled', severity: 'error' });
  }

  if (task.depends) {
    const depTasks = await acc.loadTasks(task.depends);
    const depMap = new Map(depTasks.map((t) => [t.id, t]));
    for (const dep of task.depends) {
      const depTask = depMap.get(dep);
      if (!depTask) {
        issues.push({
          code: 'V_MISSING_DEP',
          message: `Dependency ${dep} not found`,
          severity: 'error',
        });
      } else if (depTask.status !== 'done') {
        issues.push({
          code: 'V_UNMET_DEP',
          message: `Dependency ${dep} (${depTask.title}) is not complete (status: ${depTask.status})`,
          severity: 'error',
        });
      }
    }
  }

  if (!task.title) {
    issues.push({ code: 'V_MISSING_TITLE', message: 'Task title is missing', severity: 'error' });
  }
  if (!task.description) {
    issues.push({
      code: 'V_MISSING_DESC',
      message: 'Task description is missing',
      severity: 'error',
    });
  }

  // ── T894: Atomic scope enforcement ──────────────────────────────────────
  //
  // Only applies when the caller supplies a `role` AND the task is NOT an epic
  // (epics coordinate many files by design). Orchestrator and lead roles are
  // also exempt — only worker role tasks must declare a bounded file scope.
  const role = context?.role;
  const isExemptType = task.type === 'epic';
  const isExemptRole = role === 'orchestrator' || role === 'lead';

  if (role === 'worker' && !isExemptType && !isExemptRole) {
    const files = task.files ?? [];

    if (files.length === 0) {
      // Worker role with no declared files — scope is undefined.
      issues.push({
        code: 'V_ATOMIC_SCOPE_MISSING',
        message:
          `Worker-role task ${taskId} has no declared files (task.files is empty). ` +
          'Workers MUST declare their file scope. ' +
          `Fix: cleo update ${taskId} --files "path/a.ts,path/b.ts"`,
        severity: 'error',
      });
    } else if (files.length > MAX_WORKER_FILES) {
      // Worker role with too many files — split or promote to lead.
      const splitCount = Math.ceil(files.length / MAX_WORKER_FILES);
      issues.push({
        code: 'V_ATOMIC_SCOPE_TOO_LARGE',
        message:
          `Worker-role task ${taskId} declares ${files.length} files (max ${MAX_WORKER_FILES}). ` +
          `Split into ~${splitCount} subtasks or promote role to 'lead'.`,
        severity: 'error',
      });
    }
  }

  return {
    taskId,
    title: task.title,
    ready: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}
