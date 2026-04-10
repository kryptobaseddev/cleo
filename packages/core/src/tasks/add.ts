/**
 * Task creation logic.
 * @task T4460
 * @epic T4454
 */

import { randomBytes } from 'node:crypto';
import type {
  ProjectMeta,
  Task,
  TaskPriority,
  TaskSize,
  TaskStatus,
  TaskType,
  TaskVerification,
} from '@cleocode/contracts';
// setMetaValue now called via tx.setMetaValue inside transaction (T023)
import { ExitCode, TASK_STATUSES } from '@cleocode/contracts';
import { loadConfig } from '../config.js';
import { CleoError } from '../errors.js';
import { allocateNextTaskId } from '../sequence/index.js';
import { requireActiveSession } from '../sessions/session-enforcement.js';
import type { DataAccessor, TransactionAccessor } from '../store/data-accessor.js';
import { createAcceptanceEnforcement } from './enforcement.js';
import {
  findEpicAncestor,
  getLifecycleMode,
  validateChildStageCeiling,
  validateEpicCreation,
} from './epic-enforcement.js';
import { resolveHierarchyPolicy } from './hierarchy-policy.js';
import { resolveDefaultPipelineStage, validatePipelineStage } from './pipeline-stage.js';

/**
 * Options for creating a task.
 *
 * `description` is **required** per CLEO's anti-hallucination rules —
 * every task must have both a title and a description, and they must differ.
 */
export interface AddTaskOptions {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  parentId?: string | null;
  size?: TaskSize;
  phase?: string;
  labels?: string[];
  files?: string[];
  acceptance?: string[];
  depends?: string[];
  notes?: string;
  position?: number;
  addPhase?: boolean;
  dryRun?: boolean;
  /** RCASD-IVTR+C pipeline stage to assign. Auto-resolved if not provided. @task T060 */
  pipelineStage?: string;
}

/** Result of adding a task. */
export interface AddTaskResult {
  task: Task;
  duplicate?: boolean;
  dryRun?: boolean;
}

/**
 * Build the default verification metadata applied to every new task.
 * Gates are initialized to false (not yet passed). `passed` starts false
 * because no gates have been verified yet.
 * @task T061
 */
export function buildDefaultVerification(initializedAt: string): TaskVerification {
  return {
    passed: false,
    round: 1,
    gates: {
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    },
    lastAgent: null,
    lastUpdated: null,
    failureLog: [],
    initializedAt,
  };
}

/**
 * Validate a task title.
 * @task T4460
 */
export function validateTitle(title: string): void {
  if (!title || title.trim().length === 0) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task title is required', {
      fix: 'Provide a title: cleo add "<title>"',
      details: { field: 'title' },
    });
  }
  if (title.length > 200) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Task title must be 200 characters or less', {
      fix: 'Shorten title to 200 characters or fewer',
      details: { field: 'title', expected: 200, actual: title.length },
    });
  }
}

/**
 * Validate task status.
 * @task T4460
 */
export function validateStatus(status: string): asserts status is TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid status: ${status} (must be ${TASK_STATUSES.join('|')})`,
      {
        fix: `cleo add ... --status <${TASK_STATUSES.join('|')}>`,
        details: { field: 'status', expected: TASK_STATUSES, actual: status },
      },
    );
  }
}

/**
 * Mapping from numeric priority (1-9) to string priority names.
 * 1-2 = critical, 3-4 = high, 5-6 = medium, 7-9 = low.
 * @task T4572
 */
const NUMERIC_PRIORITY_MAP: Record<number, TaskPriority> = {
  1: 'critical',
  2: 'critical',
  3: 'high',
  4: 'high',
  5: 'medium',
  6: 'medium',
  7: 'low',
  8: 'low',
  9: 'low',
};

/** Valid string priority values. */
export const VALID_PRIORITIES: readonly TaskPriority[] = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

/**
 * Normalize priority to canonical string format.
 * Accepts both string names ("critical","high","medium","low") and numeric (1-9).
 * Returns the canonical string format per todo.schema.json.
 * @task T4572
 */
export function normalizePriority(priority: string | number): TaskPriority {
  // Handle numeric input
  if (typeof priority === 'number') {
    const mapped = NUMERIC_PRIORITY_MAP[priority];
    if (!mapped) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Invalid numeric priority: ${priority} (must be 1-9)`,
        {
          fix: `Use a numeric priority 1-9 or one of: ${VALID_PRIORITIES.join('|')}`,
          details: { field: 'priority', expected: '1-9', actual: priority },
        },
      );
    }
    return mapped;
  }

  // Handle string input - check for numeric string first
  const asNumber = Number(priority);
  if (!Number.isNaN(asNumber) && Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 9) {
    return NUMERIC_PRIORITY_MAP[asNumber]!;
  }

  // Canonical string validation
  const lower = priority.toLowerCase().trim();
  if (VALID_PRIORITIES.includes(lower as TaskPriority)) {
    return lower as TaskPriority;
  }

  throw new CleoError(
    ExitCode.VALIDATION_ERROR,
    `Invalid priority: ${priority} (must be ${VALID_PRIORITIES.join('|')} or numeric 1-9)`,
    {
      fix: `cleo add ... --priority <${VALID_PRIORITIES.join('|')}>`,
      details: { field: 'priority', expected: VALID_PRIORITIES, actual: priority },
    },
  );
}

/**
 * Validate task priority.
 * @task T4460
 * @task T4572
 */
export function validatePriority(priority: string): asserts priority is TaskPriority {
  normalizePriority(priority);
}

/**
 * Validate task type.
 * @task T4460
 */
export function validateTaskType(type: string): asserts type is TaskType {
  const valid: TaskType[] = ['epic', 'task', 'subtask'];
  if (!valid.includes(type as TaskType)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid task type: ${type} (must be ${valid.join('|')})`,
      {
        fix: `cleo add ... --type <${valid.join('|')}>`,
        details: { field: 'type', expected: valid, actual: type },
      },
    );
  }
}

/**
 * Validate task size.
 * @task T4460
 */
export function validateSize(size: string): asserts size is TaskSize {
  const valid: TaskSize[] = ['small', 'medium', 'large'];
  if (!valid.includes(size as TaskSize)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid size: ${size} (must be ${valid.join('|')})`,
      {
        fix: `cleo add ... --size <${valid.join('|')}>`,
        details: { field: 'size', expected: valid, actual: size },
      },
    );
  }
}

/**
 * Validate label format.
 * @task T4460
 */
export function validateLabels(labels: string[]): void {
  for (const label of labels) {
    const trimmed = label.trim();
    if (!/^[a-z][a-z0-9.-]*$/.test(trimmed)) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Invalid label format: '${trimmed}' (must be lowercase alphanumeric with hyphens/periods)`,
        {
          fix: `Labels must match pattern ^[a-z][a-z0-9.-]*$ (e.g. my-label, v1.0)`,
          details: { field: 'labels', expected: '^[a-z][a-z0-9.-]*$', actual: trimmed },
        },
      );
    }
  }
}

/**
 * Validate phase slug format.
 * @task T4460
 */
export function validatePhaseFormat(phase: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(phase)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid phase format: ${phase} (must be lowercase alphanumeric with hyphens)`,
      {
        fix: `Phase slugs must match pattern ^[a-z][a-z0-9-]*$ (e.g. dev-phase-1)`,
        details: { field: 'phase', expected: '^[a-z][a-z0-9-]*$', actual: phase },
      },
    );
  }
}

/**
 * Validate dependency IDs exist.
 * @task T4460
 */
export function validateDepends(depends: string[], tasks: Task[]): void {
  const existingIds = new Set(tasks.map((t) => t.id));
  for (const depId of depends) {
    const trimmed = depId.trim();
    if (!/^T\d{3,}$/.test(trimmed)) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Invalid dependency ID format: '${trimmed}' (must be T### format)`,
        {
          fix: 'Dependency IDs must match T### format (e.g. T123, T4567)',
          details: { field: 'depends', expected: 'T###', actual: trimmed },
        },
      );
    }
    if (!existingIds.has(trimmed)) {
      throw new CleoError(ExitCode.NOT_FOUND, `Dependency task not found: ${trimmed}`, {
        fix: `cleo find "${trimmed}"`,
        details: { field: 'depends', actual: trimmed },
      });
    }
  }
}

/**
 * Validate parent hierarchy constraints.
 * @task T4460
 */
export function validateParent(
  parentId: string,
  tasks: Task[],
  maxDepth: number = 3,
  maxSiblings: number = 0,
): void {
  // Check parent exists
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) {
    throw new CleoError(ExitCode.PARENT_NOT_FOUND, `Parent task not found: ${parentId}`, {
      fix: `Use 'cleo show ${parentId}' to check or create as standalone task`,
    });
  }

  // Check parent type allows children
  if (parent.type === 'subtask') {
    throw new CleoError(
      ExitCode.INVALID_PARENT_TYPE,
      `Cannot add child to ${parentId}: subtasks cannot have children`,
      { fix: `Create as standalone task or add to parent's parent instead` },
    );
  }

  // Check depth
  const depth = getTaskDepth(parentId, tasks);
  if (depth >= maxDepth) {
    throw new CleoError(
      ExitCode.DEPTH_EXCEEDED,
      `Cannot add child to ${parentId}: max hierarchy depth (${maxDepth}) would be exceeded`,
      {
        fix: 'Reparent this task under a higher-level epic',
        details: { field: 'parentId', expected: `depth < ${maxDepth}`, actual: depth },
      },
    );
  }

  // Check sibling count
  if (maxSiblings > 0) {
    const siblingCount = tasks.filter((t) => t.parentId === parentId).length;
    if (siblingCount >= maxSiblings) {
      throw new CleoError(
        ExitCode.SIBLING_LIMIT,
        `Cannot add child to ${parentId}: max siblings (${maxSiblings}) exceeded`,
        { fix: `Create as standalone task or increase hierarchy.maxSiblings in config` },
      );
    }
  }
}

/**
 * Get the depth of a task in the hierarchy.
 * @task T4460
 */
export function getTaskDepth(taskId: string, tasks: Task[]): number {
  let depth = 0;
  let currentId: string | null | undefined = taskId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) break; // circular reference guard
    visited.add(currentId);
    const task = tasks.find((t) => t.id === currentId);
    if (!task?.parentId) break;
    depth++;
    currentId = task.parentId;
  }
  return depth;
}

/**
 * Infer task type from parent context.
 * @task T4460
 */
export function inferTaskType(parentId: string | null | undefined, tasks: Task[]): TaskType {
  if (!parentId) return 'task';
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) return 'task';
  if (parent.type === 'epic') return 'task';
  return 'subtask';
}

/**
 * Get the next position for a task within a parent scope.
 * @task T4460
 */
export function getNextPosition(parentId: string | null | undefined, tasks: Task[]): number {
  const siblings = tasks.filter((t) =>
    parentId ? t.parentId === parentId : !t.parentId || t.parentId === null,
  );
  let maxPos = 0;
  for (const s of siblings) {
    if (s.position !== undefined && s.position !== null && s.position > maxPos) {
      maxPos = s.position;
    }
  }
  return maxPos + 1;
}

/**
 * Log an operation to the audit log.
 * @task T4460
 */
export async function logOperation(
  operation: string,
  taskId: string,
  details: Record<string, unknown>,
  accessor?: import('../store/data-accessor.js').DataAccessor,
): Promise<void> {
  const logId = `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`;
  const entry = {
    id: logId,
    timestamp: new Date().toISOString(),
    action: operation,
    taskId,
    actor: 'system',
    details,
    before: null,
    after: details,
  };

  try {
    if (accessor) {
      await accessor.appendLog(entry);
    }
  } catch {
    // Log failure is non-fatal
  }
}

/**
 * Check for recent duplicate task.
 * @task T4460
 */
export function findRecentDuplicate(
  title: string,
  phase: string | undefined,
  tasks: Task[],
  windowSeconds: number = 60,
): Task | null {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;

  for (const task of tasks) {
    if (task.title !== title) continue;
    if (phase) {
      if (task.phase !== phase) continue;
    } else {
      if (task.phase && task.phase !== '') continue;
    }
    const created = new Date(task.createdAt).getTime();
    if (created > cutoff) return task;
  }
  return null;
}

/**
 * Add a new task to the todo file.
 * @task T4460
 */
export async function addTask(
  options: AddTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<AddTaskResult> {
  // Validate title
  validateTitle(options.title);

  // Anti-hallucination: title and description must be different (T5698)
  if (
    options.description &&
    options.title.trim().toLowerCase() === options.description.trim().toLowerCase()
  ) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'Title and description must be different (anti-hallucination rule)',
      {
        fix: 'Provide --desc with a description different from the title',
        details: { field: 'description' },
      },
    );
  }

  // Skip session enforcement for dry-run — no data is written
  if (!options.dryRun) {
    await requireActiveSession('tasks.add', cwd);
  }

  // Orphan prevention (T101): non-epic tasks must have a parent in strict mode.
  // Epics are root containers and are exempt. Only enforced in strict lifecycle mode.
  // Skip for dry-run — no data is written.
  const parentId = options.parentId ?? null;
  if (!options.dryRun && !parentId && options.type !== 'epic') {
    const lifecycleMode = await getLifecycleMode(cwd);
    if (lifecycleMode === 'strict') {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        'Tasks must have a parent (epic or task) in strict mode. Use --parent <epicId>, --type epic for a root-level epic, or set lifecycle.mode to "advisory".',
        {
          fix: 'cleo add "Task title" --parent T### --acceptance "AC1|AC2|AC3"',
          alternatives: [
            'cleo add "Epic title" --type epic --priority high',
          ],
        },
      );
    }
  }

  // Always use accessor (SQLite canonical storage per ADR-006)
  const dataAccessor =
    accessor ?? (await (await import('../store/data-accessor.js')).getAccessor(cwd));

  // Resolve defaults
  const status = options.status ?? 'pending';
  const priority = normalizePriority(options.priority ?? 'medium');
  const size = options.size ?? 'medium';
  let taskType = options.type;

  // Validate inputs
  validateStatus(status);
  // priority is already normalized above
  validateSize(size);
  if (options.labels?.length) validateLabels(options.labels);

  // Skip enforcement checks for dry-run — no data is written
  if (!options.dryRun) {
    // Enforce Acceptance Criteria (general rule: min 3 for all task types)
    const enforcement = await createAcceptanceEnforcement(cwd);
    const acValidation = enforcement.validateCreation({
      acceptance: options.acceptance,
      priority: priority,
    });
    if (!acValidation.valid) {
      throw new CleoError(acValidation.exitCode ?? ExitCode.VALIDATION_ERROR, acValidation.error!, {
        fix: acValidation.fix,
      });
    }

    // Epic-specific creation enforcement (T062): min 5 AC + non-empty description.
    if (options.type === 'epic') {
      await validateEpicCreation(
        { acceptance: options.acceptance, description: options.description },
        cwd,
      );
    }
  }

  // Validate dependency IDs exist using targeted queries
  if (options.depends?.length) {
    for (const depId of options.depends) {
      const trimmed = depId.trim();
      if (!/^T\d{3,}$/.test(trimmed)) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid dependency ID format: '${trimmed}' (must be T### format)`,
          {
            fix: 'Dependency IDs must match T### format (e.g. T123, T4567)',
            details: { field: 'depends', expected: 'T###', actual: trimmed },
          },
        );
      }
      const exists = await dataAccessor.taskExists(trimmed);
      if (!exists) {
        throw new CleoError(ExitCode.NOT_FOUND, `Dependency task not found: ${trimmed}`, {
          fix: `cleo find "${trimmed}"`,
          details: { field: 'depends', actual: trimmed },
        });
      }
    }
  }

  // Phase validation using targeted metadata queries
  let phase = options.phase;
  const projectMeta = await dataAccessor.getMetaValue<ProjectMeta>('project_meta');
  let updatedProjectMeta: ProjectMeta | null = null;

  if (phase) {
    validatePhaseFormat(phase);
    // Check if phase exists in project
    const phases = projectMeta?.phases ?? {};
    if (!phases[phase]) {
      if (!options.addPhase) {
        const validPhases = Object.keys(phases).join(', ');
        throw new CleoError(
          ExitCode.NOT_FOUND,
          `Phase '${phase}' not found. Valid phases: ${validPhases || 'none'}. Use --add-phase to create new.`,
          {
            fix: `cleo add ... --add-phase to create '${phase}', or use one of: ${validPhases || 'none'}`,
            details: { field: 'phase', expected: Object.keys(phases), actual: phase },
          },
        );
      }
      // Create phase
      const order = Object.keys(phases).length + 1;
      const name = phase
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      updatedProjectMeta = projectMeta ?? { name: '', phases: {} };
      if (!updatedProjectMeta.phases) updatedProjectMeta.phases = {};
      updatedProjectMeta.phases[phase] = { order, name, status: 'pending' as const };
    }
  } else {
    // Inherit from project.currentPhase
    if (projectMeta?.currentPhase) {
      phase = projectMeta.currentPhase;
    }
  }

  // Parent hierarchy validation using targeted queries
  if (parentId) {
    if (!/^T\d{3,}$/.test(parentId)) {
      throw new CleoError(ExitCode.INVALID_INPUT, `Invalid parent ID format: ${parentId}`, {
        fix: 'Parent IDs must match T### format (e.g. T123)',
        details: { field: 'parentId', expected: 'T###', actual: parentId },
      });
    }
    // Validate parent exists
    const parentTask = await dataAccessor.loadSingleTask(parentId);
    if (!parentTask) {
      throw new CleoError(ExitCode.PARENT_NOT_FOUND, `Parent task ${parentId} not found`, {
        fix: `Use 'cleo find "${parentId}"' to search or create as standalone task`,
        details: { field: 'parentId', actual: parentId },
      });
    }

    // Read hierarchy limits from config via policy module
    const config = await loadConfig(cwd);
    const policy = resolveHierarchyPolicy(config);

    // Depth check using ancestor chain
    const ancestors = await dataAccessor.getAncestorChain(parentId);
    const parentDepth = ancestors.length;
    if (parentDepth + 1 >= policy.maxDepth) {
      throw new CleoError(
        ExitCode.DEPTH_EXCEEDED,
        `Maximum nesting depth ${policy.maxDepth} would be exceeded`,
        {
          fix: 'Reparent this task under a higher-level epic',
          details: {
            field: 'parentId',
            expected: `depth < ${policy.maxDepth}`,
            actual: parentDepth + 1,
          },
        },
      );
    }

    // Sibling limit (0 = unlimited)
    if (policy.maxSiblings > 0) {
      const children = await dataAccessor.getChildren(parentId);
      const counted = policy.countDoneInLimit
        ? children.length
        : children.filter((t) => t.status !== 'done').length;
      if (counted >= policy.maxSiblings) {
        throw new CleoError(
          ExitCode.SIBLING_LIMIT,
          `Parent ${parentId} already has ${counted} children (limit: ${policy.maxSiblings})`,
          {
            fix: 'Create as standalone task or increase hierarchy.maxSiblings in config',
            details: {
              field: 'parentId',
              expected: `<= ${policy.maxSiblings} siblings`,
              actual: counted,
            },
          },
        );
      }
    }

    // Active siblings cap
    const activeCount = await dataAccessor.countActiveChildren(parentId);
    if (policy.maxActiveSiblings > 0 && activeCount >= policy.maxActiveSiblings) {
      throw new CleoError(
        ExitCode.SIBLING_LIMIT,
        `Parent ${parentId} already has ${activeCount} active children (maxActiveSiblings=${policy.maxActiveSiblings})`,
        {
          fix: 'Complete or cancel an active sibling before adding a new task here',
          details: {
            field: 'parentId',
            expected: `<= ${policy.maxActiveSiblings} active siblings`,
            actual: activeCount,
          },
        },
      );
    }

    // Validate type constraints
    if (taskType === 'epic') {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        'Epic tasks cannot have a parent - they must be root-level',
        { fix: 'Remove --parent flag or change --type to task|subtask' },
      );
    }
  }

  if (taskType === 'subtask' && !parentId) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'Subtask tasks require a parent - specify with --parent',
      { fix: 'Add --parent T### flag or change --type to task|epic' },
    );
  }

  if (taskType) {
    validateTaskType(taskType);
  } else {
    // Infer type from parent using targeted query
    if (!parentId) {
      taskType = 'task';
    } else {
      const parent = await dataAccessor.loadSingleTask(parentId);
      if (!parent) {
        taskType = 'task';
      } else if (parent.type === 'epic') {
        taskType = 'task';
      } else {
        taskType = 'subtask';
      }
    }
  }

  // Validate explicit pipelineStage if provided (T060)
  if (options.pipelineStage) {
    validatePipelineStage(options.pipelineStage);
  }

  // Duplicate detection using targeted query
  const { tasks: candidateDupes } = await dataAccessor.queryTasks({
    search: options.title,
    limit: 50,
  });
  const duplicate = findRecentDuplicate(options.title, phase, candidateDupes);
  if (duplicate) {
    return { task: duplicate, duplicate: true };
  }

  // Dry run: build a preview task without allocating a sequence ID or writing to the DB.
  // Must be checked before allocateNextTaskId to avoid advancing the counter on no-op runs.
  if (options.dryRun) {
    const previewNow = new Date().toISOString();

    // Resolve pipeline stage for the preview without any DB writes
    let previewParentForStage: import('./pipeline-stage.js').ResolvedParent | null = null;
    if (parentId) {
      const previewParentTask = await dataAccessor.loadSingleTask(parentId);
      previewParentForStage = previewParentTask
        ? { pipelineStage: previewParentTask.pipelineStage, type: previewParentTask.type }
        : null;
    }
    const previewPipelineStage = resolveDefaultPipelineStage({
      explicitStage: options.pipelineStage,
      taskType: taskType ?? null,
      parentTask: previewParentForStage,
    });
    const previewPosition =
      options.position !== undefined
        ? options.position
        : await dataAccessor.getNextPosition(parentId);

    const previewTask: Task = {
      id: 'T???',
      title: options.title,
      description: options.description ?? '',
      status,
      priority,
      type: taskType,
      parentId: parentId || null,
      position: previewPosition,
      positionVersion: 0,
      size,
      pipelineStage: previewPipelineStage,
      createdAt: previewNow,
      updatedAt: previewNow,
    };
    if (phase) previewTask.phase = phase;
    if (options.labels?.length) previewTask.labels = options.labels.map((l) => l.trim());
    if (options.files?.length) previewTask.files = options.files.map((f) => f.trim());
    if (options.acceptance?.length)
      previewTask.acceptance = options.acceptance.map((a) => a.trim());
    if (options.depends?.length) previewTask.depends = options.depends.map((d) => d.trim());
    if (options.notes) {
      const previewNote = `${new Date()
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
      previewTask.notes = [previewNote];
    }
    if (status === 'blocked' && options.description) {
      previewTask.blockedBy = options.description;
    }
    if (status === 'done') {
      previewTask.completedAt = previewNow;
    }
    if (taskType !== 'epic') {
      const pCfg = await loadConfig(cwd);
      if (pCfg.verification?.enabled) {
        previewTask.verification = buildDefaultVerification(previewNow);
      }
    }
    return { task: previewTask, dryRun: true };
  }

  const taskId = await allocateNextTaskId(cwd);

  const now = new Date().toISOString();

  // Resolve pipeline stage: explicit > parent inheritance > type default (T060)
  let resolvedParentForStage: import('./pipeline-stage.js').ResolvedParent | null = null;
  if (parentId) {
    // Re-use the already-validated parent task (loaded above)
    const parentForStage = await dataAccessor.loadSingleTask(parentId);
    resolvedParentForStage = parentForStage
      ? { pipelineStage: parentForStage.pipelineStage, type: parentForStage.type }
      : null;
  }
  const resolvedPipelineStage = resolveDefaultPipelineStage({
    explicitStage: options.pipelineStage,
    taskType: taskType ?? null,
    parentTask: resolvedParentForStage,
  });

  // Child stage ceiling check (T062): child stage must not exceed parent epic's stage.
  // If the direct parent is an epic, check against it; otherwise walk ancestors.
  if (parentId && taskType !== 'epic') {
    let epicToCheck: import('@cleocode/contracts').Task | null = null;
    if (resolvedParentForStage?.type === 'epic') {
      // Direct parent is an epic — load its full record to pass to validateChildStageCeiling
      epicToCheck = await dataAccessor.loadSingleTask(parentId);
    } else {
      // Walk up from the parent to find the nearest epic ancestor
      epicToCheck = await findEpicAncestor(parentId, dataAccessor);
    }
    if (epicToCheck) {
      await validateChildStageCeiling(
        { childStage: resolvedPipelineStage, epicId: epicToCheck.id },
        dataAccessor,
        cwd,
      );
    }
  }

  // Compute next position using SQL-level allocation (race-safe, T024)
  let position: number;
  if (options.position !== undefined) {
    position = options.position;
  } else {
    position = await dataAccessor.getNextPosition(parentId);
  }

  // Build task object
  const task: Task = {
    id: taskId,
    title: options.title,
    description: options.description ?? '',
    status,
    priority,
    type: taskType,
    parentId: parentId || null,
    position,
    positionVersion: 0,
    size,
    createdAt: now,
    updatedAt: now,
  };

  // Assign pipeline stage (always set — auto-assigned if not explicit) (T060)
  task.pipelineStage = resolvedPipelineStage;

  // Add optional fields
  if (phase) task.phase = phase;
  if (options.labels?.length) task.labels = options.labels.map((l) => l.trim());
  if (options.files?.length) task.files = options.files.map((f) => f.trim());
  if (options.acceptance?.length) task.acceptance = options.acceptance.map((a) => a.trim());
  if (options.depends?.length) task.depends = options.depends.map((d) => d.trim());
  if (options.notes) {
    const timestampedNote = `${new Date()
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
    task.notes = [timestampedNote];
  }
  if (status === 'blocked' && options.description) {
    task.blockedBy = options.description;
  }
  if (status === 'done') {
    task.completedAt = now;
  }

  // Auto-initialize verification metadata on task creation (T061).
  // Only for non-epic tasks when verification is enabled in config.
  // Epics are containers and do not go through verification gates themselves.
  if (taskType !== 'epic') {
    const aCfg = await loadConfig(cwd);
    if (aCfg.verification?.enabled) {
      task.verification = buildDefaultVerification(now);
    }
  }

  // Wrap all writes in a transaction for TOCTOU safety (T023)
  await dataAccessor.transaction(async (tx: TransactionAccessor) => {
    // Position shuffling via bulk SQL update (T025)
    if (options.position !== undefined) {
      await dataAccessor.shiftPositions(parentId, options.position, 1);
    }

    // Insert the new task
    await tx.upsertSingleTask(task);

    // Update project metadata if a new phase was created
    if (options.addPhase && phase && updatedProjectMeta?.phases?.[phase]) {
      await tx.setMetaValue('project_meta', updatedProjectMeta);
    }

    // Audit log
    await tx.appendLog({
      id: `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_created',
      taskId,
      actor: 'system',
      details: { title: options.title, status, priority },
      before: null,
      after: { title: options.title, status, priority },
    });
  });

  return { task };
}
