/**
 * Spawn readiness validation.
 *
 * @task T4784
 * @task T894 Atomic task enforcement (worker role rejects >3 files or no file scope)
 * @task T1933 Universal-tier wired into spawn validator pre-flight (ADR-068 Decision 6)
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { AgentSpawnCapability, Task } from '@cleocode/contracts';
import { AgentNotFoundError, resolveAgent } from '../store/agent-resolver.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { ensureGlobalSignaldockDb, getGlobalSignaldockDbPath } from '../store/signaldock-sqlite.js';
import { MAX_WORKER_FILES } from './atomicity.js';
import { CLASSIFY_CONFIDENCE_FLOOR, CLASSIFY_FALLBACK_AGENT_ID, classifyTask } from './classify.js';

// ---------------------------------------------------------------------------
// node:sqlite interop (createRequire for ESM / Vitest compat)
// ---------------------------------------------------------------------------

const _validateSpawnRequire = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync: _DatabaseSyncCtor } = _validateSpawnRequire('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSyncType;
};

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

  /**
   * Override path for the `packagedSeedDir` option passed to the agent
   * resolver during the pre-flight agent-existence check (T1933). When
   * omitted, the resolver derives the default from `@cleocode/agents/templates/`.
   * Tests can pin this to an isolated fixture directory.
   */
  packagedSeedDir?: string;

  /**
   * Override path for the universal-base `.cant` file passed to the agent
   * resolver during the pre-flight agent-existence check (T1933). When
   * omitted, the resolver derives the default from `@cleocode/agents/cleo-subagent.cant`.
   * Tests can pin this to a fixture file; passing a path that does not exist
   * disables the universal tier (catastrophic-state simulation).
   */
  universalBasePath?: string;
}

/**
 * Open a short-lived signaldock.db handle for pre-flight agent resolution.
 *
 * Returns `null` when the DB cannot be opened (e.g. in unit tests that have
 * not initialised the global signaldock.db). Callers treat a `null` return as
 * "skip the agent-existence check" so the validator degrades gracefully
 * instead of blocking spawn for a missing global DB.
 */
async function openSignaldockDbForPreflight(): Promise<DatabaseSync | null> {
  try {
    await ensureGlobalSignaldockDb();
    const dbPath = getGlobalSignaldockDbPath();
    const db = new _DatabaseSyncCtor(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  } catch {
    return null;
  }
}

/**
 * Derive the agent ID the classifier would assign to this task.
 *
 * Mirrors the logic in `composeSpawnPayload`: run `classifyTask`, fall back
 * to `CLASSIFY_FALLBACK_AGENT_ID` when confidence is below the floor.
 *
 * @param task - Task record to classify.
 * @returns Business agent ID string.
 */
function deriveAgentIdForPreflight(task: Task): string {
  try {
    const result = classifyTask(task);
    if (result.confidence < CLASSIFY_CONFIDENCE_FLOOR) {
      return CLASSIFY_FALLBACK_AGENT_ID;
    }
    return result.agentId;
  } catch {
    // Classifier may throw ClassifierUnregisteredAgentError when the
    // registry is not yet initialised (e.g. pre-init state). Fall back
    // to the universal base ID so the agent-existence check is best-effort.
    return CLASSIFY_FALLBACK_AGENT_ID;
  }
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

  // ── T1933: Agent-existence pre-flight (ADR-068 Decision 6) ──────────────
  //
  // Classify the task to derive the agent ID, then walk the full 5-tier
  // resolver cascade — including the universal tier — before emitting
  // V_AGENT_NOT_FOUND. This replaces the prior behaviour where the spawn
  // path could surface AgentNotFoundError after all validation had passed,
  // producing a confusing late failure.
  //
  // V_AGENT_NOT_FOUND is ONLY emitted when `cleo-subagent.cant` itself is
  // unreachable (catastrophic state — corrupt or incomplete CLEO install).
  // In normal operation the universal tier synthesises a valid envelope and
  // the check passes silently.
  //
  // DB open is best-effort: if the global signaldock.db is not yet
  // initialised (e.g. pre-init unit tests) the check is skipped entirely
  // so the validator does not block spawn for a missing DB.
  {
    const db = await openSignaldockDbForPreflight();
    if (db !== null) {
      try {
        const agentId = deriveAgentIdForPreflight(task);
        resolveAgent(db, agentId, {
          projectRoot: cwd,
          packagedSeedDir: context?.packagedSeedDir,
          universalBasePath: context?.universalBasePath,
        });
        // Resolution succeeded — agent found at some tier (including universal).
        // No issue emitted; the spawn path will resolve the same envelope.
      } catch (err) {
        if (err instanceof AgentNotFoundError) {
          // Every tier — including the universal base — missed. This is a
          // catastrophic state (corrupt or incomplete CLEO installation).
          issues.push({
            code: 'V_AGENT_NOT_FOUND',
            message:
              `Agent resolution failed for task ${taskId}: no agent found in any tier ` +
              `(project, global, packaged, fallback, universal). ` +
              `CLEO installation may be incomplete. ` +
              `Run 'cleo init' to register standard agent templates or ` +
              `'cleo agent install <path>' to install a custom agent.`,
            severity: 'error',
          });
        }
        // Non-AgentNotFoundError (unexpected): swallow and allow spawn to
        // surface it at resolution time with full context.
      } finally {
        db.close();
      }
    }
  }

  return {
    taskId,
    title: task.title,
    ready: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}
