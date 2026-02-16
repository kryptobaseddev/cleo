/**
 * Core validation engine - ported from lib/validation/validation.sh
 *
 * Provides schema validation, task field validation, status transitions,
 * timestamp sanity checks, ID uniqueness, phase validation, circular
 * dependency detection, and comprehensive file validation.
 *
 * @task T4523
 * @epic T4454
 */

import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

// ============================================================================
// Constants
// ============================================================================

export const VALID_STATUSES = ['pending', 'active', 'done', 'blocked', 'cancelled'] as const;
export type TaskStatus = typeof VALID_STATUSES[number];

export const VALID_OPERATIONS = [
  'create', 'update', 'complete', 'archive', 'restore', 'delete', 'validate', 'backup',
] as const;

export const VALID_PHASE_STATUSES = ['pending', 'active', 'completed'] as const;

/** Field length limits matching the Bash implementation. */
export const FIELD_LIMITS = {
  MAX_TITLE_LENGTH: 120,
  MAX_DESCRIPTION_LENGTH: 2000,
  MAX_NOTE_LENGTH: 5000,
  MAX_BLOCKED_BY_LENGTH: 300,
  MAX_SESSION_NOTE_LENGTH: 2500,
  MIN_CANCEL_REASON_LENGTH: 5,
  MAX_CANCEL_REASON_LENGTH: 300,
} as const;

/** Validation result exit codes. */
export const VAL_SUCCESS = 0;
export const VAL_SCHEMA_ERROR = 1;
export const VAL_SEMANTIC_ERROR = 2;
export const VAL_BOTH_ERRORS = 3;

// ============================================================================
// Validation Result Types
// ============================================================================

export interface ValidationError {
  field?: string;
  message: string;
  severity: 'error' | 'warning';
  fix?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

// ============================================================================
// Path Security
// ============================================================================

/** Shell metacharacters that could enable injection. */
const SHELL_METACHARACTERS = new Set([
  '$', '`', ';', '|', '&', '<', '>', "'", '"',
  '(', ')', '{', '}', '[', ']', '!',
]);

/**
 * Sanitize a file path for safe shell usage.
 * Prevents command injection via malicious file names.
 * @task T4523
 */
export function sanitizeFilePath(path: string): string {
  if (!path) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Empty path provided');
  }

  for (const char of path) {
    if (SHELL_METACHARACTERS.has(char)) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Path contains shell metacharacters - potential injection attempt: ${path}`,
      );
    }
  }

  if (path.endsWith('\\')) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'Path ends with backslash - potential injection attempt',
    );
  }

  if (path.includes('\n') || path.includes('\r')) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'Path contains newline/carriage return - potential injection attempt',
    );
  }

  return path;
}

// ============================================================================
// Title Validation
// ============================================================================

/** Zero-width and invisible Unicode codepoints. */
const INVISIBLE_CODEPOINTS = [
  0x200B, // Zero-width space
  0x200C, // Zero-width non-joiner
  0x200D, // Zero-width joiner
  0xFEFF, // BOM
  0x2060, // Word joiner
  0x00AD, // Soft hyphen
];

/**
 * Validate a task title.
 * Checks for emptiness, newlines, invisible characters, control chars, and length.
 * @task T4523
 */
export function validateTitle(title: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (!title) {
    errors.push({ field: 'title', message: 'Title cannot be empty', severity: 'error' });
    return { valid: false, errors, warnings };
  }

  if (title.includes('\n')) {
    errors.push({ field: 'title', message: 'Title cannot contain newlines', severity: 'error' });
  }

  if (title.includes('\\n')) {
    errors.push({ field: 'title', message: 'Title cannot contain newline sequences', severity: 'error' });
  }

  if (title.includes('\r')) {
    errors.push({ field: 'title', message: 'Title cannot contain carriage returns', severity: 'error' });
  }

  // Check for invisible/zero-width characters
  for (const cp of INVISIBLE_CODEPOINTS) {
    if (title.includes(String.fromCodePoint(cp))) {
      errors.push({
        field: 'title',
        message: 'Title contains invisible/zero-width characters',
        severity: 'error',
      });
      break;
    }
  }

  // Check for ASCII control characters (0x00-0x1F except \n \r \t, and 0x7F)
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i);
    if ((code >= 0 && code <= 0x08) || (code >= 0x0B && code <= 0x0C) ||
        (code >= 0x0E && code <= 0x1F) || code === 0x7F) {
      errors.push({ field: 'title', message: 'Title contains control characters', severity: 'error' });
      break;
    }
  }

  // Check for leading/trailing whitespace
  if (title !== title.trim()) {
    warnings.push({
      field: 'title',
      message: 'Title has leading/trailing whitespace (should be trimmed)',
      severity: 'warning',
    });
  }

  // Check length
  if (title.length > FIELD_LIMITS.MAX_TITLE_LENGTH) {
    errors.push({
      field: 'title',
      message: `Title too long (${title.length}/${FIELD_LIMITS.MAX_TITLE_LENGTH} characters)`,
      severity: 'error',
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// Field Length Validators
// ============================================================================

/** @task T4523 */
export function validateDescription(desc: string): ValidationResult {
  if (!desc) return { valid: true, errors: [], warnings: [] };
  if (desc.length > FIELD_LIMITS.MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      errors: [{
        field: 'description',
        message: `Description exceeds ${FIELD_LIMITS.MAX_DESCRIPTION_LENGTH} characters (${desc.length} provided)`,
        severity: 'error',
      }],
      warnings: [],
    };
  }
  return { valid: true, errors: [], warnings: [] };
}

/** @task T4523 */
export function validateNote(note: string): ValidationResult {
  if (!note) return { valid: true, errors: [], warnings: [] };
  if (note.length > FIELD_LIMITS.MAX_NOTE_LENGTH) {
    return {
      valid: false,
      errors: [{
        field: 'note',
        message: `Note exceeds ${FIELD_LIMITS.MAX_NOTE_LENGTH} characters (${note.length} provided)`,
        severity: 'error',
      }],
      warnings: [],
    };
  }
  return { valid: true, errors: [], warnings: [] };
}

/** @task T4523 */
export function validateBlockedBy(reason: string): ValidationResult {
  if (!reason) return { valid: true, errors: [], warnings: [] };
  if (reason.length > FIELD_LIMITS.MAX_BLOCKED_BY_LENGTH) {
    return {
      valid: false,
      errors: [{
        field: 'blockedBy',
        message: `Blocked-by reason exceeds ${FIELD_LIMITS.MAX_BLOCKED_BY_LENGTH} characters (${reason.length} provided)`,
        severity: 'error',
      }],
      warnings: [],
    };
  }
  return { valid: true, errors: [], warnings: [] };
}

/** @task T4523 */
export function validateSessionNote(note: string): ValidationResult {
  if (!note) return { valid: true, errors: [], warnings: [] };
  if (note.length > FIELD_LIMITS.MAX_SESSION_NOTE_LENGTH) {
    return {
      valid: false,
      errors: [{
        field: 'sessionNote',
        message: `Session note exceeds ${FIELD_LIMITS.MAX_SESSION_NOTE_LENGTH} characters (${note.length} provided)`,
        severity: 'error',
      }],
      warnings: [],
    };
  }
  return { valid: true, errors: [], warnings: [] };
}

// ============================================================================
// Cancellation Validation
// ============================================================================

/** Characters disallowed in cancellation reasons. */
const CANCEL_REASON_DISALLOWED = new Set([
  '|', ';', '&', '$', '`', '\\', '<', '>', '(', ')',
  '{', '}', '[', ']', '!', '"', "'",
]);

/**
 * Validate a cancellation reason.
 * @task T4523
 */
export function validateCancelReason(reason: string): ValidationResult {
  const errors: ValidationError[] = [];

  if (!reason) {
    errors.push({
      field: 'cancellationReason',
      message: 'Cancellation reason cannot be empty',
      severity: 'error',
    });
    return { valid: false, errors, warnings: [] };
  }

  if (reason.length < FIELD_LIMITS.MIN_CANCEL_REASON_LENGTH) {
    errors.push({
      field: 'cancellationReason',
      message: `Cancellation reason too short (${reason.length}/${FIELD_LIMITS.MIN_CANCEL_REASON_LENGTH} minimum characters)`,
      severity: 'error',
    });
  }

  if (reason.length > FIELD_LIMITS.MAX_CANCEL_REASON_LENGTH) {
    errors.push({
      field: 'cancellationReason',
      message: `Cancellation reason too long (${reason.length}/${FIELD_LIMITS.MAX_CANCEL_REASON_LENGTH} maximum characters)`,
      severity: 'error',
    });
  }

  if (reason.includes('\n') || reason.includes('\r')) {
    errors.push({
      field: 'cancellationReason',
      message: 'Cancellation reason cannot contain newlines or carriage returns',
      severity: 'error',
    });
  }

  for (const char of reason) {
    if (CANCEL_REASON_DISALLOWED.has(char)) {
      errors.push({
        field: 'cancellationReason',
        message: 'Cancellation reason contains disallowed characters',
        severity: 'error',
      });
      break;
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

// ============================================================================
// Status Validation
// ============================================================================

/** Valid status transitions map. */
const STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['active', 'blocked', 'cancelled'],
  active: ['done', 'blocked', 'pending', 'cancelled'],
  done: ['pending'],
  blocked: ['pending', 'active', 'cancelled'],
  cancelled: ['pending'],
};

/**
 * Validate that a status transition is allowed.
 * @task T4523
 */
export function validateStatusTransition(oldStatus: TaskStatus, newStatus: TaskStatus): ValidationResult {
  if (oldStatus === newStatus) {
    return { valid: true, errors: [], warnings: [] };
  }

  const allowed = STATUS_TRANSITIONS[oldStatus];
  if (allowed?.includes(newStatus)) {
    return { valid: true, errors: [], warnings: [] };
  }

  return {
    valid: false,
    errors: [{
      field: 'status',
      message: `Invalid status transition: '${oldStatus}' -> '${newStatus}'`,
      severity: 'error',
      fix: `Valid transitions from '${oldStatus}': ${allowed?.join(', ') ?? 'none'}`,
    }],
    warnings: [],
  };
}

/**
 * Check if a status string is valid.
 * @task T4523
 */
export function isValidStatus(status: string): status is TaskStatus {
  return (VALID_STATUSES as readonly string[]).includes(status);
}

// ============================================================================
// Timestamp Validation
// ============================================================================

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Check timestamp format and sanity.
 * @task T4523
 */
export function checkTimestampSanity(
  createdAt: string,
  completedAt?: string,
): ValidationResult {
  const errors: ValidationError[] = [];

  if (!ISO_TIMESTAMP_REGEX.test(createdAt)) {
    errors.push({
      field: 'created_at',
      message: `Invalid timestamp format: '${createdAt}'`,
      severity: 'error',
      fix: 'Use ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ',
    });
    return { valid: false, errors, warnings: [] };
  }

  const createdEpoch = new Date(createdAt).getTime();
  const now = Date.now();

  if (createdEpoch > now) {
    errors.push({
      field: 'created_at',
      message: `created_at is in the future: ${createdAt}`,
      severity: 'error',
      fix: 'Use current or past timestamp',
    });
  }

  if (completedAt) {
    if (!ISO_TIMESTAMP_REGEX.test(completedAt)) {
      errors.push({
        field: 'completed_at',
        message: `Invalid completed_at format: '${completedAt}'`,
        severity: 'error',
        fix: 'Use ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ',
      });
    } else {
      const completedEpoch = new Date(completedAt).getTime();

      if (completedEpoch < createdEpoch) {
        errors.push({
          field: 'completed_at',
          message: `completed_at (${completedAt}) is before created_at (${createdAt})`,
          severity: 'error',
          fix: 'Ensure completed_at is after created_at',
        });
      }

      if (completedEpoch > now) {
        errors.push({
          field: 'completed_at',
          message: `completed_at is in the future: ${completedAt}`,
          severity: 'error',
          fix: 'Use current or past timestamp',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

// ============================================================================
// Update Classification
// ============================================================================

const METADATA_FIELDS = new Set(['type', 'parentId', 'labels', 'size']);

/**
 * Check if an update contains only metadata fields (safe for done tasks).
 * @task T4523
 */
export function isMetadataOnlyUpdate(fields: string[]): boolean {
  return fields.every(f => METADATA_FIELDS.has(f));
}

// ============================================================================
// Label Normalization
// ============================================================================

/**
 * Deduplicate and normalize labels.
 * @task T4523
 */
export function normalizeLabels(labels: string): string {
  if (!labels) return '';
  return [...new Set(
    labels.split(',')
      .map(l => l.trim())
      .filter(Boolean)
  )].sort().join(',');
}

// ============================================================================
// ID Uniqueness
// ============================================================================

export interface Task {
  id?: string;
  content?: string;
  title?: string;
  status?: string;
  activeForm?: string;
  created_at?: string;
  completed_at?: string;
  parentId?: string | null;
  type?: string;
  depends?: string[];
  cancelledAt?: string;
  cancellationReason?: string;
  [key: string]: unknown;
}

export interface TodoFile {
  tasks: Task[];
  project?: {
    currentPhase?: string;
    phases?: Record<string, {
      status?: string;
      startedAt?: string;
      completedAt?: string;
    }>;
  };
  [key: string]: unknown;
}

export interface ArchiveFile {
  archived_tasks: Task[];
  [key: string]: unknown;
}

/**
 * Check ID uniqueness within and across files.
 * @task T4523
 */
export function checkIdUniqueness(
  todoFile: TodoFile,
  archiveFile?: ArchiveFile,
): ValidationResult {
  const errors: ValidationError[] = [];

  const todoIds = todoFile.tasks
    .map(t => t.id)
    .filter((id): id is string => !!id);

  // Check for duplicates within todo
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of todoIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }

  if (duplicates.size > 0) {
    errors.push({
      message: `Duplicate task IDs found: ${[...duplicates].join(', ')}`,
      severity: 'error',
      fix: 'Regenerate unique IDs for duplicate tasks',
    });
  }

  // Check against archive
  if (archiveFile) {
    const archiveIds = new Set(
      archiveFile.archived_tasks
        .map(t => t.id)
        .filter((id): id is string => !!id),
    );

    const crossDuplicates = todoIds.filter(id => archiveIds.has(id));
    if (crossDuplicates.length > 0) {
      errors.push({
        message: `Task IDs exist in both todo and archive: ${crossDuplicates.join(', ')}`,
        severity: 'error',
        fix: 'Remove duplicate from one of the files',
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

// ============================================================================
// Task Validation
// ============================================================================

/**
 * Validate a single task object.
 * @task T4523
 */
export function validateTask(task: Task): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // Required fields
  if (!task.content) {
    errors.push({ field: 'content', message: 'Missing content field', severity: 'error', fix: 'Add content field with task description' });
  }

  if (!task.status) {
    errors.push({ field: 'status', message: 'Missing status field', severity: 'error', fix: 'Add status field (pending|active|done|blocked|cancelled)' });
  }

  if (!task.activeForm) {
    errors.push({ field: 'activeForm', message: 'Missing activeForm field', severity: 'error', fix: 'Add activeForm field with present continuous form' });
  }

  // Status enum
  if (task.status && !isValidStatus(task.status)) {
    errors.push({
      field: 'status',
      message: `Invalid status: '${task.status}'`,
      severity: 'error',
      fix: `Status must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  // Content/activeForm pairing
  if (task.content && task.activeForm && task.content === task.activeForm) {
    warnings.push({
      field: 'activeForm',
      message: 'Identical content and activeForm',
      severity: 'warning',
      fix: "activeForm should be present continuous (e.g., 'Implementing auth')",
    });
  }

  // Timestamp checks
  if (task.created_at) {
    const tsResult = checkTimestampSanity(task.created_at, task.completed_at);
    errors.push(...tsResult.errors);
  }

  // ID format
  if (task.id && !/^[a-zA-Z0-9_-]+$/.test(task.id)) {
    errors.push({
      field: 'id',
      message: `Invalid ID format: '${task.id}'`,
      severity: 'error',
      fix: 'ID should contain only alphanumeric, dash, and underscore',
    });
  }

  // Cancelled fields consistency
  if (task.status === 'cancelled') {
    if (!task.cancelledAt) {
      errors.push({
        field: 'cancelledAt',
        message: 'Cancelled status requires cancelledAt timestamp',
        severity: 'error',
      });
    }
    if (!task.cancellationReason) {
      errors.push({
        field: 'cancellationReason',
        message: 'Cancelled status requires cancellationReason',
        severity: 'error',
      });
    } else {
      const reasonResult = validateCancelReason(task.cancellationReason);
      errors.push(...reasonResult.errors);
    }

    if (task.cancelledAt && !ISO_TIMESTAMP_REGEX.test(task.cancelledAt)) {
      errors.push({
        field: 'cancelledAt',
        message: `Invalid cancelledAt timestamp format: ${task.cancelledAt}`,
        severity: 'error',
      });
    }
  } else {
    if (task.cancelledAt) {
      warnings.push({
        field: 'cancelledAt',
        message: `cancelledAt present but status is '${task.status}'`,
        severity: 'warning',
      });
    }
    if (task.cancellationReason) {
      warnings.push({
        field: 'cancellationReason',
        message: `cancellationReason present but status is '${task.status}'`,
        severity: 'warning',
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// Circular Dependency Detection
// ============================================================================

/**
 * Check for circular dependencies using DFS.
 * @task T4523
 */
export function validateNoCircularDeps(
  tasks: Task[],
  taskId: string,
  newDeps: string[],
): ValidationResult {
  if (newDeps.length === 0) {
    return { valid: true, errors: [], warnings: [] };
  }

  // Build dependency map including proposed changes
  const depMap = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.id) {
      if (task.id === taskId) {
        const existing = (task.depends ?? []) as string[];
        depMap.set(task.id, [...new Set([...existing, ...newDeps])]);
      } else {
        depMap.set(task.id, (task.depends ?? []) as string[]);
      }
    }
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(current: string): boolean {
    if (recStack.has(current)) return true; // cycle found
    if (visited.has(current)) return false;

    visited.add(current);
    recStack.add(current);

    const deps = depMap.get(current) ?? [];
    for (const dep of deps) {
      if (dfs(dep)) return true;
    }

    recStack.delete(current);
    return false;
  }

  if (dfs(taskId)) {
    return {
      valid: false,
      errors: [{
        message: `Circular dependency detected involving: ${taskId}`,
        severity: 'error',
        fix: 'Remove dependency that creates the cycle',
      }],
      warnings: [],
    };
  }

  return { valid: true, errors: [], warnings: [] };
}

// ============================================================================
// Phase Validation
// ============================================================================

/**
 * Validate only one phase is active.
 * @task T4523
 */
export function validateSingleActivePhase(todoFile: TodoFile): ValidationResult {
  const phases = todoFile.project?.phases;
  if (!phases) return { valid: true, errors: [], warnings: [] };

  const activeCount = Object.values(phases).filter(p => p.status === 'active').length;

  if (activeCount > 1) {
    return {
      valid: false,
      errors: [{
        message: `Multiple phases marked as active (${activeCount} found, only 1 allowed)`,
        severity: 'error',
        fix: "Use 'cleo phase set <slug>' to set a single active phase",
      }],
      warnings: [],
    };
  }

  return { valid: true, errors: [], warnings: [] };
}

/**
 * Validate currentPhase matches an active phase.
 * @task T4523
 */
export function validateCurrentPhaseConsistency(todoFile: TodoFile): ValidationResult {
  const currentPhase = todoFile.project?.currentPhase;
  if (!currentPhase) return { valid: true, errors: [], warnings: [] };

  const phases = todoFile.project?.phases;
  if (!phases) return { valid: true, errors: [], warnings: [] };

  const phase = phases[currentPhase];
  if (!phase) {
    return {
      valid: false,
      errors: [{
        message: `Current phase '${currentPhase}' does not exist in phases definition`,
        severity: 'error',
        fix: 'Set currentPhase to an existing phase slug',
      }],
      warnings: [],
    };
  }

  if (phase.status !== 'active') {
    return {
      valid: false,
      errors: [{
        message: `Current phase '${currentPhase}' has status '${phase.status}', expected 'active'`,
        severity: 'error',
        fix: "Either change phase status to 'active' or set a different currentPhase",
      }],
      warnings: [],
    };
  }

  return { valid: true, errors: [], warnings: [] };
}

/**
 * Validate phase timestamp ordering.
 * @task T4523
 */
export function validatePhaseTimestamps(todoFile: TodoFile): ValidationResult {
  const phases = todoFile.project?.phases;
  if (!phases) return { valid: true, errors: [], warnings: [] };

  const errors: ValidationError[] = [];

  for (const [slug, phase] of Object.entries(phases)) {
    if (phase.startedAt && phase.completedAt) {
      if (phase.startedAt > phase.completedAt) {
        errors.push({
          message: `Phase '${slug}': startedAt (${phase.startedAt}) is after completedAt (${phase.completedAt})`,
          severity: 'error',
          fix: 'Correct timestamp ordering in phase definitions',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

/**
 * Validate phase status requirements (e.g., active phases must have startedAt).
 * @task T4523
 */
export function validatePhaseStatusRequirements(todoFile: TodoFile): ValidationResult {
  const phases = todoFile.project?.phases;
  if (!phases) return { valid: true, errors: [], warnings: [] };

  const errors: ValidationError[] = [];

  for (const [slug, phase] of Object.entries(phases)) {
    if ((phase.status === 'active' || phase.status === 'completed') && !phase.startedAt) {
      errors.push({
        message: `Phase '${slug}' with status '${phase.status}' requires startedAt timestamp`,
        severity: 'error',
      });
    }

    if (phase.status === 'completed' && !phase.completedAt) {
      errors.push({
        message: `Phase '${slug}' with status 'completed' requires completedAt timestamp`,
        severity: 'error',
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

// ============================================================================
// Comprehensive Validation
// ============================================================================

export interface ComprehensiveValidationResult {
  schemaErrors: number;
  semanticErrors: number;
  exitCode: number;
  checks: Array<{
    name: string;
    passed: boolean;
    message: string;
  }>;
}

/**
 * Run all validation checks on a TodoFile.
 * @task T4523
 */
export function validateAll(
  todoFile: TodoFile,
  archiveFile?: ArchiveFile,
): ComprehensiveValidationResult {
  let schemaErrors = 0;
  let semanticErrors = 0;
  const checks: ComprehensiveValidationResult['checks'] = [];

  // 1. Check tasks array exists
  if (!Array.isArray(todoFile.tasks)) {
    schemaErrors++;
    checks.push({ name: 'tasks_array', passed: false, message: 'Missing or invalid tasks array' });
    return { schemaErrors, semanticErrors, exitCode: VAL_SCHEMA_ERROR, checks };
  }
  checks.push({ name: 'tasks_array', passed: true, message: 'Tasks array valid' });

  // 2. ID Uniqueness
  const idResult = checkIdUniqueness(todoFile, archiveFile);
  if (!idResult.valid) {
    semanticErrors++;
    checks.push({ name: 'id_uniqueness', passed: false, message: idResult.errors[0]?.message ?? 'Duplicate IDs found' });
  } else {
    checks.push({ name: 'id_uniqueness', passed: true, message: 'All IDs unique' });
  }

  // 3. Individual task validation
  let taskErrors = 0;
  for (const task of todoFile.tasks) {
    const result = validateTask(task);
    if (!result.valid) taskErrors++;
  }
  if (taskErrors > 0) {
    semanticErrors++;
    checks.push({ name: 'task_validation', passed: false, message: `${taskErrors} task(s) have validation errors` });
  } else {
    checks.push({ name: 'task_validation', passed: true, message: `All tasks valid (${todoFile.tasks.length} tasks)` });
  }

  // 4. Content duplicate check
  const contents = todoFile.tasks.map(t => t.content).filter(Boolean);
  const contentDuplicates = contents.filter((c, i) => contents.indexOf(c) !== i);
  if (contentDuplicates.length > 0) {
    checks.push({ name: 'content_duplicates', passed: true, message: `Warning: duplicate content found` });
  } else {
    checks.push({ name: 'content_duplicates', passed: true, message: 'No duplicate content' });
  }

  // 5. Phase validation
  if (todoFile.project?.phases) {
    let phaseErrors = 0;
    if (!validateSingleActivePhase(todoFile).valid) phaseErrors++;
    if (!validateCurrentPhaseConsistency(todoFile).valid) phaseErrors++;
    if (!validatePhaseTimestamps(todoFile).valid) phaseErrors++;
    if (!validatePhaseStatusRequirements(todoFile).valid) phaseErrors++;

    if (phaseErrors > 0) {
      semanticErrors++;
      checks.push({ name: 'phase_validation', passed: false, message: `Phase validation failed (${phaseErrors} issues)` });
    } else {
      checks.push({ name: 'phase_validation', passed: true, message: 'Phase configuration valid' });
    }
  }

  // 6. Circular dependency check
  let cycleErrors = 0;
  for (const task of todoFile.tasks) {
    if (task.id && task.depends && task.depends.length > 0) {
      const result = validateNoCircularDeps(todoFile.tasks, task.id, task.depends);
      if (!result.valid) cycleErrors++;
    }
  }
  if (cycleErrors > 0) {
    semanticErrors++;
    checks.push({ name: 'circular_deps', passed: false, message: `Circular dependencies detected (${cycleErrors} cycles)` });
  } else {
    checks.push({ name: 'circular_deps', passed: true, message: 'No circular dependencies' });
  }

  // 7. Done status consistency
  const invalidDone = todoFile.tasks.filter(
    t => t.status === 'done' && !t.completed_at,
  );
  if (invalidDone.length > 0) {
    semanticErrors++;
    checks.push({ name: 'done_consistency', passed: false, message: 'Done tasks missing completed_at timestamp' });
  } else {
    checks.push({ name: 'done_consistency', passed: true, message: 'Done status consistent' });
  }

  // Determine exit code
  let exitCode = VAL_SUCCESS;
  if (schemaErrors > 0 && semanticErrors > 0) exitCode = VAL_BOTH_ERRORS;
  else if (schemaErrors > 0) exitCode = VAL_SCHEMA_ERROR;
  else if (semanticErrors > 0) exitCode = VAL_SEMANTIC_ERROR;

  return { schemaErrors, semanticErrors, exitCode, checks };
}
