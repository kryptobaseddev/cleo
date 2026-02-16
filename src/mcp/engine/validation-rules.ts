/**
 * Anti-Hallucination Validation Rules
 *
 * Implements CLEO's anti-hallucination requirements:
 * - Title and description both required and different
 * - No future timestamps
 * - No duplicate task descriptions
 * - Unique IDs across todo.json AND todo-archive.json
 * - Valid status transitions
 * - Hierarchy constraints (max depth 3, max 7 siblings)
 */

/**
 * Validation error from anti-hallucination checks
 */
export interface RuleViolation {
  rule: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Task-like object for validation (doesn't need full Task type)
 */
interface TaskLike {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  parentId?: string | null;
  type?: string;
}

/**
 * Validate that title and description are both present and different.
 * This is a critical anti-hallucination check.
 */
export function validateTitleDescription(
  title?: string,
  description?: string
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  if (!title || title.trim().length === 0) {
    violations.push({
      rule: 'title-required',
      field: 'title',
      message: 'Title is required and cannot be empty',
      severity: 'error',
    });
  }

  if (!description || description.trim().length === 0) {
    violations.push({
      rule: 'description-required',
      field: 'description',
      message: 'Description is required and cannot be empty',
      severity: 'error',
    });
  }

  if (
    title &&
    description &&
    title.trim().toLowerCase() === description.trim().toLowerCase()
  ) {
    violations.push({
      rule: 'title-description-different',
      field: 'description',
      message: 'Title and description must be different',
      severity: 'error',
    });
  }

  return violations;
}

/**
 * Validate that timestamps are not in the future
 */
export function validateTimestamps(task: TaskLike): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const now = new Date();
  // Allow 5 minutes of clock skew
  const threshold = new Date(now.getTime() + 5 * 60 * 1000);

  const timestampFields: Array<[string, string | undefined]> = [
    ['createdAt', task.createdAt],
    ['updatedAt', task.updatedAt],
    ['completedAt', task.completedAt],
    ['cancelledAt', task.cancelledAt],
  ];

  for (const [field, value] of timestampFields) {
    if (value) {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        violations.push({
          rule: 'valid-timestamp',
          field,
          message: `Invalid timestamp format: ${value}`,
          severity: 'error',
        });
      } else if (date > threshold) {
        violations.push({
          rule: 'no-future-timestamps',
          field,
          message: `Timestamp ${value} is in the future`,
          severity: 'error',
        });
      }
    }
  }

  return violations;
}

/**
 * Validate ID uniqueness across all tasks (todo + archive)
 */
export function validateIdUniqueness(
  taskId: string,
  existingIds: Set<string>
): RuleViolation[] {
  if (existingIds.has(taskId)) {
    return [{
      rule: 'unique-id',
      field: 'id',
      message: `Task ID '${taskId}' already exists`,
      severity: 'error',
    }];
  }
  return [];
}

/**
 * Validate no duplicate task descriptions
 */
export function validateNoDuplicateDescription(
  description: string,
  existingDescriptions: string[],
  _excludeTaskId?: string
): RuleViolation[] {
  const normalizedNew = description.trim().toLowerCase();

  for (const existing of existingDescriptions) {
    if (existing.trim().toLowerCase() === normalizedNew) {
      return [{
        rule: 'no-duplicate-description',
        field: 'description',
        message: 'A task with this exact description already exists',
        severity: 'warning',
      }];
    }
  }

  return [];
}

/**
 * Validate hierarchy constraints.
 * Accepts optional limits to override defaults (from config).
 */
export function validateHierarchy(
  parentId: string | null | undefined,
  tasks: Array<{ id: string; parentId?: string | null; type?: string }>,
  _taskType?: string,
  limits?: { maxDepth?: number; maxSiblings?: number }
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  if (!parentId) {
    return violations;
  }

  const maxDepth = limits?.maxDepth ?? 3;
  const maxSiblings = limits?.maxSiblings ?? 7;

  // Find parent
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) {
    violations.push({
      rule: 'parent-exists',
      field: 'parentId',
      message: `Parent task '${parentId}' not found`,
      severity: 'error',
    });
    return violations;
  }

  // Check depth (default max 3: epic -> task -> subtask)
  let depth = 1;
  let current = parent;
  while (current.parentId) {
    depth++;
    const nextParent = tasks.find((t) => t.id === current.parentId);
    if (!nextParent) break;
    current = nextParent;
  }

  if (depth > maxDepth - 1) {
    violations.push({
      rule: 'max-depth',
      field: 'parentId',
      message: `Maximum hierarchy depth of ${maxDepth} exceeded (epic -> task -> subtask)`,
      severity: 'error',
    });
  }

  // Check sibling count
  const siblingCount = tasks.filter((t) => t.parentId === parentId).length;
  if (siblingCount >= maxSiblings) {
    violations.push({
      rule: 'max-siblings',
      field: 'parentId',
      message: `Parent '${parentId}' already has ${siblingCount} children (max ${maxSiblings})`,
      severity: 'error',
    });
  }

  return violations;
}

/**
 * Validate status transition
 */
export function validateStatusTransition(
  currentStatus: string,
  newStatus: string
): RuleViolation[] {
  const validTransitions: Record<string, string[]> = {
    pending: ['active', 'blocked', 'done', 'cancelled'],
    active: ['pending', 'blocked', 'done', 'cancelled'],
    blocked: ['pending', 'active', 'done', 'cancelled'],
    done: ['pending', 'active'], // reopen
    cancelled: ['pending'], // uncancel
  };

  const allowed = validTransitions[currentStatus];
  if (!allowed) {
    return [{
      rule: 'valid-status-transition',
      field: 'status',
      message: `Unknown current status: '${currentStatus}'`,
      severity: 'error',
    }];
  }

  if (!allowed.includes(newStatus)) {
    return [{
      rule: 'valid-status-transition',
      field: 'status',
      message: `Cannot transition from '${currentStatus}' to '${newStatus}'. Valid: ${allowed.join(', ')}`,
      severity: 'error',
    }];
  }

  return [];
}

/**
 * Run all validation rules on a task being created
 */
export function validateNewTask(
  task: TaskLike,
  existingIds: Set<string>,
  existingDescriptions: string[],
  existingTasks: Array<{ id: string; parentId?: string | null; type?: string }>,
  limits?: { maxDepth?: number; maxSiblings?: number }
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  violations.push(...validateTitleDescription(task.title, task.description));
  violations.push(...validateTimestamps(task));

  if (task.id) {
    violations.push(...validateIdUniqueness(task.id, existingIds));
  }

  if (task.description) {
    violations.push(
      ...validateNoDuplicateDescription(task.description, existingDescriptions)
    );
  }

  if (task.parentId) {
    violations.push(
      ...validateHierarchy(task.parentId, existingTasks, task.type, limits)
    );
  }

  return violations;
}

/**
 * Check if violations contain any errors (not just warnings)
 */
export function hasErrors(violations: RuleViolation[]): boolean {
  return violations.some((v) => v.severity === 'error');
}
