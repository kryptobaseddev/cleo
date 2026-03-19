/**
 * Phase lifecycle management - CRUD, transitions, and querying.
 * @task T4464
 * @epic T4454
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { ExitCode } from '@cleocode/contracts';
import type { PhaseStatus, PhaseTransition, ProjectMeta, TaskWorkState } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { logOperation } from '../tasks/add.js';

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
export async function listPhases(
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<ListPhasesResult> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const phases = meta?.phases ?? {};
  const currentPhase = meta?.currentPhase ?? null;

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
      pending: entries.filter((p) => p.status === 'pending').length,
      active: entries.filter((p) => p.status === 'active').length,
      completed: entries.filter((p) => p.status === 'completed').length,
    },
  };
}

/**
 * Show the current phase details.
 * @task T4464
 */
export async function showPhase(
  slug?: string,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<ShowPhaseResult> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const targetSlug = slug ?? meta?.currentPhase ?? null;

  if (!targetSlug) {
    throw new CleoError(ExitCode.NOT_FOUND, 'No current phase set');
  }

  const phase = meta?.phases?.[targetSlug];
  if (!phase) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${targetSlug}' not found`);
  }

  const { tasks: phaseTasks } = await accessor!.queryTasks({ phase: targetSlug });
  const completedTasks = phaseTasks.filter((t) => t.status === 'done');

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
export async function setPhase(
  options: SetPhaseOptions,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<SetPhaseResult> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const phases = meta?.phases ?? {};

  // Validate phase exists
  if (!phases[options.slug]) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${options.slug}' does not exist`);
  }

  const oldPhase = meta?.currentPhase ?? null;
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

  // Update current phase in project metadata
  const updatedMeta: ProjectMeta = meta ?? { name: '', phases: {} };
  updatedMeta.currentPhase = options.slug;

  // Add phase history entry for rollback
  if (isRollback && oldPhase) {
    const taskCount = await accessor!.countTasks({ status: undefined });
    addPhaseHistoryEntryToMeta(updatedMeta, options.slug, 'rollback', oldPhase, `Rollback from ${oldPhase}`, taskCount);
  }

  await accessor!.setMetaValue('project_meta', updatedMeta);
  await logOperation(
    'phase_set',
    options.slug,
    {
      previousPhase: oldPhase,
      isRollback,
    },
    accessor,
  );

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
export async function startPhase(
  slug: string,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<{ phase: string; startedAt: string }> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const phase = meta?.phases?.[slug];

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

  const updatedMeta = meta!;
  const { tasks: phaseTasks } = await accessor!.queryTasks({ phase: slug });
  addPhaseHistoryEntryToMeta(updatedMeta, slug, 'started', null, 'Phase started', phaseTasks.length);

  await accessor!.setMetaValue('project_meta', updatedMeta);
  await logOperation('phase_started', slug, {}, accessor);

  return { phase: slug, startedAt: now };
}

/**
 * Complete a phase (active -> completed).
 * @task T4464
 */
export async function completePhase(
  slug: string,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<{ phase: string; completedAt: string }> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const phase = meta?.phases?.[slug];

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
  const { tasks: phaseTasks } = await accessor!.queryTasks({ phase: slug });
  const incompleteTasks = phaseTasks.filter((t) => t.status !== 'done');
  if (incompleteTasks.length > 0) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot complete phase '${slug}' - ${incompleteTasks.length} incomplete task(s) pending`,
    );
  }

  const now = new Date().toISOString();
  phase.status = 'completed';
  phase.completedAt = now;

  const updatedMeta = meta!;
  addPhaseHistoryEntryToMeta(updatedMeta, slug, 'completed', null, 'Phase completed', phaseTasks.length);

  await accessor!.setMetaValue('project_meta', updatedMeta);
  await logOperation('phase_completed', slug, {}, accessor);

  return { phase: slug, completedAt: now };
}

/**
 * Advance to the next phase.
 * @task T4464
 */
export async function advancePhase(
  force: boolean = false,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<AdvancePhaseResult> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const currentSlug = meta?.currentPhase ?? null;

  if (!currentSlug) {
    throw new CleoError(ExitCode.NOT_FOUND, 'No current phase set');
  }

  const phases = meta?.phases ?? {};
  const currentPhase = phases[currentSlug];
  if (!currentPhase) {
    throw new CleoError(ExitCode.NOT_FOUND, `Current phase '${currentSlug}' not found`);
  }

  // Find next phase by order
  const sortedEntries = Object.entries(phases).sort(([, a], [, b]) => a.order - b.order);

  const currentIndex = sortedEntries.findIndex(([slug]) => slug === currentSlug);
  if (currentIndex === -1 || currentIndex >= sortedEntries.length - 1) {
    throw new CleoError(ExitCode.NO_DATA, `No more phases after '${currentSlug}'`);
  }

  const [nextSlug] = sortedEntries[currentIndex + 1]!;

  // Check incomplete tasks
  const { tasks: phaseTasks } = await accessor!.queryTasks({ phase: currentSlug });
  const incompleteTasks = phaseTasks.filter((t) => t.status !== 'done');
  if (incompleteTasks.length > 0) {
    // Check critical tasks
    const criticalTasks = incompleteTasks.filter((t) => t.priority === 'critical');
    if (criticalTasks.length > 0) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Cannot advance - ${criticalTasks.length} critical task(s) remain in phase '${currentSlug}'`,
      );
    }

    // Check completion threshold
    const totalTasks = phaseTasks.length;
    const completionPercent =
      totalTasks > 0 ? Math.floor(((totalTasks - incompleteTasks.length) * 100) / totalTasks) : 0;
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
  const updatedMeta = meta!;
  updatedMeta.currentPhase = nextSlug;

  const currentPhaseTaskCount = phaseTasks.length;
  const { tasks: nextPhaseTasks } = await accessor!.queryTasks({ phase: nextSlug });
  const nextPhaseTaskCount = nextPhaseTasks.length;

  addPhaseHistoryEntryToMeta(updatedMeta, currentSlug, 'completed', null, 'Phase completed via advance', currentPhaseTaskCount);
  addPhaseHistoryEntryToMeta(
    updatedMeta,
    nextSlug,
    'started',
    currentSlug,
    `Phase started via advance from ${currentSlug}`,
    nextPhaseTaskCount,
  );

  await accessor!.setMetaValue('project_meta', updatedMeta);

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
export async function renamePhase(
  oldName: string,
  newName: string,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<RenamePhaseResult> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const phases = meta?.phases ?? {};

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
  const { tasks: oldPhaseTasks } = await accessor!.queryTasks({ phase: oldName });
  let tasksUpdated = 0;
  for (const task of oldPhaseTasks) {
    task.phase = newName;
    await accessor!.upsertSingleTask(task);
    tasksUpdated++;
  }

  // Update current phase reference
  const updatedMeta = meta!;
  let currentPhaseUpdated = false;
  if (updatedMeta.currentPhase === oldName) {
    updatedMeta.currentPhase = newName;
    currentPhaseUpdated = true;
  }

  await accessor!.setMetaValue('project_meta', updatedMeta);

  // Update focus if needed
  const focus = await accessor!.getMetaValue<TaskWorkState>('focus_state');
  if (focus?.currentPhase === oldName) {
    focus.currentPhase = newName;
    await accessor!.setMetaValue('focus_state', focus);
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
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<DeletePhaseResult> {
  const meta = await accessor!.getMetaValue<ProjectMeta>('project_meta');
  const phases = meta?.phases ?? {};

  if (!phases[slug]) {
    throw new CleoError(ExitCode.NOT_FOUND, `Phase '${slug}' does not exist`);
  }

  if (meta?.currentPhase === slug) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cannot delete current project phase '${slug}'. Use 'phase set' to change phase first`,
    );
  }

  const { tasks: phaseTasks } = await accessor!.queryTasks({ phase: slug });

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
      throw new CleoError(
        ExitCode.NOT_FOUND,
        `Reassignment target phase '${options.reassignTo}' does not exist`,
      );
    }
  }

  // Reassign tasks
  let tasksReassigned = 0;
  if (options.reassignTo) {
    for (const task of phaseTasks) {
      task.phase = options.reassignTo;
      await accessor!.upsertSingleTask(task);
      tasksReassigned++;
    }
  }

  // Delete phase
  delete phases[slug];
  await accessor!.setMetaValue('project_meta', meta!);

  return {
    deletedPhase: slug,
    tasksReassigned,
    reassignedTo: options.reassignTo ?? null,
  };
}

/**
 * Add a phase history entry to a ProjectMeta object (in-memory mutation).
 * @task T4464
 */
function addPhaseHistoryEntryToMeta(
  meta: ProjectMeta,
  phase: string,
  transitionType: PhaseTransition['transitionType'],
  fromPhase: string | null,
  reason: string,
  taskCount: number,
): void {
  if (!meta.phaseHistory) {
    meta.phaseHistory = [];
  }

  meta.phaseHistory.push({
    phase,
    transitionType,
    timestamp: new Date().toISOString(),
    taskCount,
    fromPhase,
    reason,
  });
}
