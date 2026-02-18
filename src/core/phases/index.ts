/**
 * Phase lifecycle management - CRUD, transitions, and querying.
 * @task T4464
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { PhaseStatus, PhaseTransition, TodoFile } from '../../types/task.js';
import { getTodoPath, getBackupDir, getLogPath } from '../paths.js';
import { logOperation } from '../tasks/add.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Options for listing phases. */
export interface ListPhasesResult {
  currentPhase: string | null;
  phases: Array<{
    slug: string;
    name: string;
    order: number;
    status: PhaseStatus;
    startedAt: string | null;
    completedAt: string | null;
    isCurrent: boolean;
  }>;
  summary: {
    total: number;
    pending: number;
    active: number;
    completed: number;
  };
}

/** Options for setting current phase. */
export interface SetPhaseOptions {
  slug: string;
  rollback?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

/** Result of a phase set operation. */
export interface SetPhaseResult {
  previousPhase: string | null;
  currentPhase: string;
  isRollback: boolean;
  isSkip: boolean;
  skippedPhases?: number;
  warning?: string;
  dryRun?: boolean;
}

/** Phase show result. */
export interface ShowPhaseResult {
  slug: string;
  name: string;
  status: PhaseStatus;
  order: number;
  startedAt: string | null;
  completedAt: string | null;
  taskCount: number;
  completedTaskCount: number;
}

/** Phase advance result. */
export interface AdvancePhaseResult {
  previousPhase: string;
  currentPhase: string;
  forced: boolean;
}

/** Phase rename result. */
export interface RenamePhaseResult {
  oldName: string;
  newName: string;
  tasksUpdated: number;
  currentPhaseUpdated: boolean;
}

/** Phase delete result. */
export interface DeletePhaseResult {
  deletedPhase: string;
  tasksReassigned: number;
  reassignedTo: string | null;
}

/**
 * List all phases with status summaries.
 * @task T4464
 */
export async function listPhases(cwd?: string, accessor?: DataAccessor): Promise<ListPhasesResult> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const phases = data.project?.phases ?? {};
  const currentPhase = data.project?.currentPhase ?? null;

  const entries = Object.entries(phases)
    .map(([slug, phase]) => ({
      slug,
      name: phase.name,
      order: phase.order,
      status: phase.status,
      startedAt: phase.startedAt ?? null,
      completedAt: phase.completedAt ?? null,
      isCurrent: slug === currentPhase,
    }))
    .sort((a, b) => a.order - b.order);

  return {
    currentPhase,
    phases: entries,
    summary: {
      total: entries.length,
      pending: entries.filter(p => p.status === 'pending').length,
      active: entries.filter(p => p.status === 'active').length,
      completed: entries.filter(p => p.status === 'completed').length,
    },
  };
}

/**
 * Show the current phase details.
 * @task T4464
 */
export async function showPhase(slug?: string, cwd?: string, accessor?: DataAccessor): Promise<ShowPhaseResult> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const targetSlug = slug ?? data.project?.currentPhase ?? null;

  if (!targetSlug) {
    throw new CleoError(ExitCode.NOT_FOUND, 'No current phase set');
  }

  const phase = data.project?.phases?.[targetSlug];
  if (!phase) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${targetSlug}' not found`);
  }

  const phaseTasks = data.tasks.filter(t => t.phase === targetSlug);
  const completedTasks = phaseTasks.filter(t => t.status === 'done');

  return {
    slug: targetSlug,
    name: phase.name,
    status: phase.status,
    order: phase.order,
    startedAt: phase.startedAt ?? null,
    completedAt: phase.completedAt ?? null,
    taskCount: phaseTasks.length,
    completedTaskCount: completedTasks.length,
  };
}

/**
 * Set the current project phase.
 * @task T4464
 */
export async function setPhase(options: SetPhaseOptions, cwd?: string, accessor?: DataAccessor): Promise<SetPhaseResult> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);
  const phases = data.project?.phases ?? {};

  // Validate phase exists
  if (!phases[options.slug]) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${options.slug}' does not exist`);
  }

  const oldPhase = data.project?.currentPhase ?? null;
  let isRollback = false;
  let isSkip = false;
  let skippedPhases = 0;

  if (oldPhase && phases[oldPhase]) {
    const oldOrder = phases[oldPhase]!.order;
    const newOrder = phases[options.slug]!.order;

    if (newOrder < oldOrder) {
      isRollback = true;
      if (!options.rollback) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Rolling back from '${oldPhase}' (order ${oldOrder}) to '${options.slug}' (order ${newOrder}) requires --rollback flag`,
        );
      }
      if (!options.force) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          'Rollback requires --force flag in non-interactive mode',
        );
      }
    } else if (newOrder > oldOrder + 1) {
      isSkip = true;
      skippedPhases = newOrder - oldOrder - 1;
    }
  }

  if (options.dryRun) {
    return {
      previousPhase: oldPhase,
      currentPhase: options.slug,
      isRollback,
      isSkip,
      ...(isSkip && { skippedPhases }),
      dryRun: true,
    };
  }

  // Update current phase
  if (!data.project) {
    (data as unknown as Record<string, unknown>).project = { name: '', phases: {} };
  }
  data.project.currentPhase = options.slug;
  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);

  // Add phase history entry
  if (isRollback && oldPhase) {
    addPhaseHistoryEntry(data, options.slug, 'rollback', oldPhase, `Rollback from ${oldPhase}`);
  }

  if (accessor) {
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }
  await logOperation(getLogPath(cwd), 'phase_set', options.slug, {
    previousPhase: oldPhase,
    isRollback,
  }, accessor);

  return {
    previousPhase: oldPhase,
    currentPhase: options.slug,
    isRollback,
    isSkip,
    ...(isSkip && {
      skippedPhases,
      warning: `Skipped ${skippedPhases} intermediate phase(s)`,
    }),
  };
}

/**
 * Start a phase (pending -> active).
 * @task T4464
 */
export async function startPhase(slug: string, cwd?: string, accessor?: DataAccessor): Promise<{ phase: string; startedAt: string }> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);
  const phase = data.project?.phases?.[slug];

  if (!phase) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${slug}' does not exist`);
  }

  if (phase.status !== 'pending') {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Can only start pending phases. Phase '${slug}' has status '${phase.status}'`,
    );
  }

  const now = new Date().toISOString();
  phase.status = 'active';
  phase.startedAt = now;
  data.lastUpdated = now;
  data._meta.checksum = computeChecksum(data.tasks);

  addPhaseHistoryEntry(data, slug, 'started', null, 'Phase started');

  if (accessor) {
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }
  await logOperation(getLogPath(cwd), 'phase_started', slug, {}, accessor);

  return { phase: slug, startedAt: now };
}

/**
 * Complete a phase (active -> completed).
 * @task T4464
 */
export async function completePhase(slug: string, cwd?: string, accessor?: DataAccessor): Promise<{ phase: string; completedAt: string }> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);
  const phase = data.project?.phases?.[slug];

  if (!phase) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${slug}' does not exist`);
  }

  if (phase.status !== 'active') {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Can only complete active phases. Phase '${slug}' has status '${phase.status}'`,
    );
  }

  // Check for incomplete tasks
  const incompleteTasks = data.tasks.filter(t => t.phase === slug && t.status !== 'done');
  if (incompleteTasks.length > 0) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot complete phase '${slug}' - ${incompleteTasks.length} incomplete task(s) pending`,
    );
  }

  const now = new Date().toISOString();
  phase.status = 'completed';
  phase.completedAt = now;
  data.lastUpdated = now;
  data._meta.checksum = computeChecksum(data.tasks);

  addPhaseHistoryEntry(data, slug, 'completed', null, 'Phase completed');

  if (accessor) {
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }
  await logOperation(getLogPath(cwd), 'phase_completed', slug, {}, accessor);

  return { phase: slug, completedAt: now };
}

/**
 * Advance to the next phase.
 * @task T4464
 */
export async function advancePhase(force: boolean = false, cwd?: string, accessor?: DataAccessor): Promise<AdvancePhaseResult> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);
  const currentSlug = data.project?.currentPhase ?? null;

  if (!currentSlug) {
    throw new CleoError(ExitCode.NOT_FOUND, 'No current phase set');
  }

  const phases = data.project?.phases ?? {};
  const currentPhase = phases[currentSlug];
  if (!currentPhase) {
    throw new CleoError(ExitCode.NOT_FOUND, `Current phase '${currentSlug}' not found`);
  }

  // Find next phase by order
  const sortedEntries = Object.entries(phases)
    .sort(([, a], [, b]) => a.order - b.order);

  const currentIndex = sortedEntries.findIndex(([slug]) => slug === currentSlug);
  if (currentIndex === -1 || currentIndex >= sortedEntries.length - 1) {
    throw new CleoError(ExitCode.NO_DATA, `No more phases after '${currentSlug}'`);
  }

  const [nextSlug] = sortedEntries[currentIndex + 1]!;

  // Check incomplete tasks
  const incompleteTasks = data.tasks.filter(t => t.phase === currentSlug && t.status !== 'done');
  if (incompleteTasks.length > 0) {
    // Check critical tasks
    const criticalTasks = incompleteTasks.filter(t => t.priority === 'critical');
    if (criticalTasks.length > 0) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Cannot advance - ${criticalTasks.length} critical task(s) remain in phase '${currentSlug}'`,
      );
    }

    // Check completion threshold
    const totalTasks = data.tasks.filter(t => t.phase === currentSlug).length;
    const completionPercent = totalTasks > 0
      ? Math.floor((totalTasks - incompleteTasks.length) * 100 / totalTasks)
      : 0;
    const threshold = 90;

    if (completionPercent < threshold && !force) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Cannot advance - ${incompleteTasks.length} incomplete task(s) in phase '${currentSlug}' (${completionPercent}% complete, threshold: ${threshold}%)`,
        { fix: 'Use --force to override' },
      );
    }
  }

  // Complete current phase
  const now = new Date().toISOString();
  currentPhase.status = 'completed';
  currentPhase.completedAt = now;

  // Start next phase
  const nextPhase = phases[nextSlug]!;
  nextPhase.status = 'active';
  nextPhase.startedAt = now;

  // Update current phase pointer
  data.project.currentPhase = nextSlug;
  data.lastUpdated = now;
  data._meta.checksum = computeChecksum(data.tasks);

  addPhaseHistoryEntry(data, currentSlug, 'completed', null, 'Phase completed via advance');
  addPhaseHistoryEntry(data, nextSlug, 'started', currentSlug, `Phase started via advance from ${currentSlug}`);

  if (accessor) {
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }

  return {
    previousPhase: currentSlug,
    currentPhase: nextSlug,
    forced: force,
  };
}

/**
 * Rename a phase and update all task references.
 * @task T4464
 */
export async function renamePhase(oldName: string, newName: string, cwd?: string, accessor?: DataAccessor): Promise<RenamePhaseResult> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);
  const phases = data.project?.phases ?? {};

  if (!phases[oldName]) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${oldName}' does not exist`);
  }
  if (phases[newName]) {
    throw new CleoError(ExitCode.ALREADY_EXISTS, `Phase '${newName}' already exists`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(newName)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid phase name '${newName}'`);
  }

  // Copy phase definition
  phases[newName] = phases[oldName]!;
  delete phases[oldName];

  // Update task references
  let tasksUpdated = 0;
  for (const task of data.tasks) {
    if (task.phase === oldName) {
      task.phase = newName;
      tasksUpdated++;
    }
  }

  // Update current phase reference
  let currentPhaseUpdated = false;
  if (data.project.currentPhase === oldName) {
    data.project.currentPhase = newName;
    currentPhaseUpdated = true;
  }

  // Update focus
  if (data.focus?.currentPhase === oldName) {
    data.focus.currentPhase = newName;
  }

  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);

  if (accessor) {
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }

  return { oldName, newName, tasksUpdated, currentPhaseUpdated };
}

/**
 * Delete a phase with optional task reassignment.
 * @task T4464
 */
export async function deletePhase(
  slug: string,
  options: { reassignTo?: string; force?: boolean } = {},
  cwd?: string,
  accessor?: DataAccessor,
): Promise<DeletePhaseResult> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);
  const phases = data.project?.phases ?? {};

  if (!phases[slug]) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${slug}' does not exist`);
  }

  if (data.project?.currentPhase === slug) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot delete current project phase '${slug}'. Use 'phase set' to change phase first`,
    );
  }

  const phaseTasks = data.tasks.filter(t => t.phase === slug);

  if (phaseTasks.length > 0 && !options.reassignTo) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot delete '${slug}': ${phaseTasks.length} tasks would be orphaned. Use --reassign-to <phase>`,
    );
  }

  if (!options.force) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Phase deletion requires --force flag for safety');
  }

  // Validate reassignment target
  if (options.reassignTo) {
    if (!phases[options.reassignTo]) {
      throw new CleoError(ExitCode.NOT_FOUND, `Reassignment target phase '${options.reassignTo}' does not exist`);
    }
  }

  // Reassign tasks
  let tasksReassigned = 0;
  if (options.reassignTo) {
    for (const task of data.tasks) {
      if (task.phase === slug) {
        task.phase = options.reassignTo;
        tasksReassigned++;
      }
    }
  }

  // Delete phase
  delete phases[slug];
  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);

  if (accessor) {
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }

  return {
    deletedPhase: slug,
    tasksReassigned,
    reassignedTo: options.reassignTo ?? null,
  };
}

/**
 * Add a phase history entry.
 * @task T4464
 */
function addPhaseHistoryEntry(
  data: TodoFile,
  phase: string,
  transitionType: PhaseTransition['transitionType'],
  fromPhase: string | null,
  reason: string,
): void {
  if (!data.project.phaseHistory) {
    data.project.phaseHistory = [];
  }

  const taskCount = data.tasks.filter(t => t.phase === phase).length;

  data.project.phaseHistory.push({
    phase,
    transitionType,
    timestamp: new Date().toISOString(),
    taskCount,
    fromPhase,
    reason,
  });
}
