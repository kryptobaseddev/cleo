/**
 * Tests for phase tracking operations.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  getCurrentPhase,
  getTasksByPhase,
  calculatePhaseProgress,
  getAllPhaseProgress,
  validatePhaseTransition,
  createPhaseTransition,
  applyPhaseTransition,
  getNextPhase,
  allPhasesComplete,
} from '../phase-tracking.js';
import type { Task, Phase, ProjectMeta } from '../../../types/task.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makePhases(): Record<string, Phase> {
  return {
    planning: { order: 0, status: 'completed', name: 'planning' },
    development: { order: 1, status: 'active', name: 'development' },
    testing: { order: 2, status: 'pending', name: 'testing' },
  };
}

function makeProject(overrides?: Partial<ProjectMeta>): ProjectMeta {
  return {
    name: 'test-project',
    phases: makePhases(),
    currentPhase: 'development',
    ...overrides,
  } as ProjectMeta;
}

describe('getCurrentPhase', () => {
  it('returns current active phase', () => {
    const project = makeProject();
    const phase = getCurrentPhase(project);
    expect(phase).not.toBeNull();
    expect(phase?.status).toBe('active');
  });

  it('returns null when no current phase', () => {
    const project = makeProject({ currentPhase: undefined });
    expect(getCurrentPhase(project)).toBeNull();
  });

  it('returns null when current phase name does not exist', () => {
    const project = makeProject({ currentPhase: 'nonexistent' });
    expect(getCurrentPhase(project)).toBeNull();
  });
});

describe('getTasksByPhase', () => {
  it('returns tasks matching phase', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 'development' }),
      makeTask({ id: 'T002', phase: 'testing' }),
      makeTask({ id: 'T003', phase: 'development' }),
    ];
    const result = getTasksByPhase('development', tasks);
    expect(result).toHaveLength(2);
    expect(result.map(t => t.id).sort()).toEqual(['T001', 'T003']);
  });

  it('returns empty for phase with no tasks', () => {
    const tasks = [makeTask({ id: 'T001', phase: 'development' })];
    expect(getTasksByPhase('testing', tasks)).toHaveLength(0);
  });
});

describe('calculatePhaseProgress', () => {
  it('calculates progress correctly', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 'dev', status: 'done' }),
      makeTask({ id: 'T002', phase: 'dev', status: 'active' }),
      makeTask({ id: 'T003', phase: 'dev', status: 'pending' }),
      makeTask({ id: 'T004', phase: 'dev', status: 'blocked' }),
    ];
    const progress = calculatePhaseProgress('dev', tasks);
    expect(progress.name).toBe('dev');
    expect(progress.total).toBe(4);
    expect(progress.done).toBe(1);
    expect(progress.active).toBe(1);
    expect(progress.pending).toBe(1);
    expect(progress.blocked).toBe(1);
    expect(progress.percentComplete).toBe(25);
  });

  it('reports completed status when all done', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 'dev', status: 'done' }),
      makeTask({ id: 'T002', phase: 'dev', status: 'done' }),
    ];
    const progress = calculatePhaseProgress('dev', tasks);
    expect(progress.status).toBe('completed');
    expect(progress.percentComplete).toBe(100);
  });

  it('reports pending status for empty phase', () => {
    const progress = calculatePhaseProgress('empty', []);
    expect(progress.status).toBe('pending');
    expect(progress.total).toBe(0);
    expect(progress.percentComplete).toBe(0);
  });

  it('reports active status when tasks are active', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 'dev', status: 'active' }),
    ];
    const progress = calculatePhaseProgress('dev', tasks);
    expect(progress.status).toBe('active');
  });
});

describe('getAllPhaseProgress', () => {
  it('returns progress for all phases sorted by order', () => {
    const phases = makePhases();
    const tasks = [
      makeTask({ id: 'T001', phase: 'planning', status: 'done' }),
      makeTask({ id: 'T002', phase: 'development', status: 'active' }),
      makeTask({ id: 'T003', phase: 'testing', status: 'pending' }),
    ];
    const progress = getAllPhaseProgress(phases, tasks);
    expect(progress).toHaveLength(3);
    expect(progress[0].name).toBe('planning');
    expect(progress[1].name).toBe('development');
    expect(progress[2].name).toBe('testing');
  });
});

describe('validatePhaseTransition', () => {
  const phases = makePhases();

  it('allows transition to existing phase', () => {
    const result = validatePhaseTransition('development', 'testing', phases);
    expect(result.valid).toBe(true);
  });

  it('rejects transition to nonexistent phase', () => {
    const result = validatePhaseTransition('development', 'nonexistent', phases);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('allows transition from null (no current phase)', () => {
    const result = validatePhaseTransition(null, 'planning', phases);
    expect(result.valid).toBe(true);
  });

  it('rejects when from phase does not exist', () => {
    const result = validatePhaseTransition('nonexistent', 'testing', phases);
    expect(result.valid).toBe(false);
  });

  it('allows backward transition (rollback)', () => {
    const result = validatePhaseTransition('development', 'planning', phases);
    expect(result.valid).toBe(true);
  });
});

describe('createPhaseTransition', () => {
  it('creates a transition record', () => {
    const transition = createPhaseTransition('testing', 'started', 5, 'development', 'Ready for QA');
    expect(transition.phase).toBe('testing');
    expect(transition.transitionType).toBe('started');
    expect(transition.taskCount).toBe(5);
    expect(transition.fromPhase).toBe('development');
    expect(transition.reason).toBe('Ready for QA');
    expect(transition.timestamp).toBeDefined();
  });

  it('handles null fromPhase', () => {
    const transition = createPhaseTransition('planning', 'started', 0, null);
    expect(transition.fromPhase).toBeNull();
  });
});

describe('applyPhaseTransition', () => {
  it('updates current phase on start', () => {
    const project = makeProject();
    const updated = applyPhaseTransition(project, 'testing', 'started', 3);
    expect(updated.currentPhase).toBe('testing');
    expect(updated.phases['testing'].status).toBe('active');
    expect(updated.phases['development'].status).toBe('completed');
    expect(updated.phaseHistory).toHaveLength(1);
  });

  it('clears current phase on completion', () => {
    const project = makeProject();
    const updated = applyPhaseTransition(project, 'development', 'completed', 5);
    expect(updated.currentPhase).toBeNull();
    expect(updated.phases['development'].status).toBe('completed');
  });

  it('sets startedAt on first activation', () => {
    const project = makeProject();
    const updated = applyPhaseTransition(project, 'testing', 'started', 2);
    expect(updated.phases['testing'].startedAt).toBeDefined();
  });
});

describe('getNextPhase', () => {
  const phases = makePhases();

  it('returns first phase when no current', () => {
    const next = getNextPhase(null, phases);
    expect(next).toBe('planning');
  });

  it('returns next phase in order', () => {
    expect(getNextPhase('planning', phases)).toBe('development');
    expect(getNextPhase('development', phases)).toBe('testing');
  });

  it('returns null for last phase', () => {
    expect(getNextPhase('testing', phases)).toBeNull();
  });

  it('returns null for nonexistent current phase', () => {
    expect(getNextPhase('nonexistent', phases)).toBeNull();
  });
});

describe('allPhasesComplete', () => {
  it('returns true when all completed', () => {
    const phases: Record<string, Phase> = {
      a: { order: 0, status: 'completed', name: 'a' },
      b: { order: 1, status: 'completed', name: 'b' },
    };
    expect(allPhasesComplete(phases)).toBe(true);
  });

  it('returns false when some not completed', () => {
    expect(allPhasesComplete(makePhases())).toBe(false);
  });

  it('returns true for empty phases', () => {
    expect(allPhasesComplete({})).toBe(true);
  });
});
