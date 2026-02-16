/**
 * Phase tracking - manage project phases and task-phase relationships.
 * Ported from lib/tasks/phase-tracking.sh
 *
 * @epic T4454
 * @task T4529
 */

import type {
  Task,
  Phase,
  PhaseStatus,
  PhaseTransition,
  ProjectMeta,
} from '../../types/task.js';

/** Phase progress information. */
export interface PhaseProgress {
  name: string;
  status: PhaseStatus;
  total: number;
  done: number;
  active: number;
  pending: number;
  blocked: number;
  percentComplete: number;
}

/**
 * Get the current active phase from project metadata.
 */
export function getCurrentPhase(project: ProjectMeta): Phase | null {
  if (!project.currentPhase) return null;
  return project.phases[project.currentPhase] ?? null;
}

/**
 * Get tasks belonging to a specific phase.
 */
export function getTasksByPhase(phaseName: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.phase === phaseName);
}

/**
 * Calculate progress for a phase.
 */
export function calculatePhaseProgress(
  phaseName: string,
  tasks: Task[],
): PhaseProgress {
  const phaseTasks = getTasksByPhase(phaseName, tasks);

  const done = phaseTasks.filter((t) => t.status === 'done').length;
  const active = phaseTasks.filter((t) => t.status === 'active').length;
  const pending = phaseTasks.filter((t) => t.status === 'pending').length;
  const blocked = phaseTasks.filter((t) => t.status === 'blocked').length;
  const total = phaseTasks.length;

  return {
    name: phaseName,
    status: total === 0 ? 'pending' : done === total ? 'completed' : active > 0 ? 'active' : 'pending',
    total,
    done,
    active,
    pending,
    blocked,
    percentComplete: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/**
 * Get progress for all phases.
 */
export function getAllPhaseProgress(
  phases: Record<string, Phase>,
  tasks: Task[],
): PhaseProgress[] {
  return Object.keys(phases)
    .sort((a, b) => (phases[a].order ?? 0) - (phases[b].order ?? 0))
    .map((name) => calculatePhaseProgress(name, tasks));
}

/**
 * Validate a phase transition.
 */
export interface PhaseTransitionValidation {
  valid: boolean;
  error?: string;
}

export function validatePhaseTransition(
  fromPhase: string | null,
  toPhase: string,
  phases: Record<string, Phase>,
): PhaseTransitionValidation {
  // Target phase must exist
  if (!phases[toPhase]) {
    return { valid: false, error: `Phase "${toPhase}" does not exist` };
  }

  // If no current phase, any phase is valid
  if (!fromPhase) return { valid: true };

  const from = phases[fromPhase];
  const to = phases[toPhase];

  if (!from) {
    return { valid: false, error: `Current phase "${fromPhase}" does not exist` };
  }

  // Allow forward progression or same phase
  if (to.order >= from.order) return { valid: true };

  // Allow rollback (but with warning via return value, caller decides)
  return { valid: true };
}

/**
 * Create a phase transition record.
 */
export function createPhaseTransition(
  phase: string,
  transitionType: PhaseTransition['transitionType'],
  taskCount: number,
  fromPhase?: string | null,
  reason?: string,
): PhaseTransition {
  return {
    phase,
    transitionType,
    timestamp: new Date().toISOString(),
    taskCount,
    fromPhase: fromPhase ?? null,
    reason,
  };
}

/**
 * Apply a phase transition to project metadata.
 * Returns updated project data.
 */
export function applyPhaseTransition(
  project: ProjectMeta,
  toPhase: string,
  transitionType: PhaseTransition['transitionType'],
  taskCount: number,
  reason?: string,
): ProjectMeta {
  const fromPhase = project.currentPhase ?? null;
  const timestamp = new Date().toISOString();

  const updatedPhases = { ...project.phases };

  // Mark previous phase as completed if moving forward
  if (fromPhase && transitionType === 'started') {
    updatedPhases[fromPhase] = {
      ...updatedPhases[fromPhase],
      status: 'completed',
      completedAt: timestamp,
    };
  }

  // Update target phase
  updatedPhases[toPhase] = {
    ...updatedPhases[toPhase],
    status: transitionType === 'completed' ? 'completed' : 'active',
    startedAt: updatedPhases[toPhase].startedAt ?? timestamp,
    ...(transitionType === 'completed' ? { completedAt: timestamp } : {}),
  };

  const transition = createPhaseTransition(
    toPhase,
    transitionType,
    taskCount,
    fromPhase,
    reason,
  );

  return {
    ...project,
    currentPhase: transitionType === 'completed' ? null : toPhase,
    phases: updatedPhases,
    phaseHistory: [...(project.phaseHistory ?? []), transition],
  };
}

/**
 * Get the next phase in order.
 */
export function getNextPhase(
  currentPhaseName: string | null,
  phases: Record<string, Phase>,
): string | null {
  const sorted = Object.entries(phases).sort(([, a], [, b]) => a.order - b.order);

  if (!currentPhaseName) {
    return sorted[0]?.[0] ?? null;
  }

  const currentIdx = sorted.findIndex(([name]) => name === currentPhaseName);
  if (currentIdx < 0 || currentIdx >= sorted.length - 1) return null;
  return sorted[currentIdx + 1][0];
}

/**
 * Check if all phases are complete.
 */
export function allPhasesComplete(phases: Record<string, Phase>): boolean {
  return Object.values(phases).every((p) => p.status === 'completed');
}
