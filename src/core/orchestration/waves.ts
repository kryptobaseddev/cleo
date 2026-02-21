/**
 * Wave computation and dependency graph operations.
 * @task T4784
 */

import { readJson } from '../../store/json.js';
import { getTodoPath } from '../paths.js';
import type { Task, TodoFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

export interface Wave {
  waveNumber: number;
  tasks: string[];
  status: 'pending' | 'in_progress' | 'completed';
}

export interface EnrichedWave {
  waveNumber: number;
  tasks: Array<{ id: string; title: string; status: string }>;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Build a dependency graph for tasks. */
function buildDependencyGraph(tasks: Task[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!graph.has(task.id)) {
      graph.set(task.id, new Set());
    }
    if (task.depends) {
      for (const dep of task.depends) {
        graph.get(task.id)!.add(dep);
      }
    }
  }
  return graph;
}

/** Compute execution waves using topological sort. */
export function computeWaves(tasks: Task[]): Wave[] {
  const graph = buildDependencyGraph(tasks);
  const waves: Wave[] = [];
  const completed = new Set<string>();

  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') {
      completed.add(task.id);
    }
  }

  let remaining = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
  let waveNumber = 1;
  const maxWaves = 50;

  while (remaining.length > 0 && waveNumber <= maxWaves) {
    const waveTasks = remaining.filter(t => {
      const deps = graph.get(t.id) || new Set();
      return Array.from(deps).every(d => completed.has(d));
    });

    if (waveTasks.length === 0) break;

    waves.push({
      waveNumber,
      tasks: waveTasks.map(t => t.id),
      status: waveTasks.every(t => completed.has(t.id))
        ? 'completed'
        : waveTasks.some(t => t.status === 'active')
          ? 'in_progress'
          : 'pending',
    });

    for (const t of waveTasks) {
      completed.add(t.id);
    }

    remaining = remaining.filter(t => !waveTasks.some(wt => wt.id === t.id));
    waveNumber++;
  }

  if (remaining.length > 0) {
    waves.push({
      waveNumber,
      tasks: remaining.map(t => t.id),
      status: 'pending',
    });
  }

  return waves;
}

/** Get enriched wave data for an epic. */
export async function getEnrichedWaves(
  epicId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{ epicId: string; waves: EnrichedWave[]; totalWaves: number; totalTasks: number }> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJson<TodoFile>(getTodoPath(cwd));

  const tasks = data?.tasks ?? [];
  const children = tasks.filter(t => t.parentId === epicId);
  const waves = computeWaves(children);
  const taskMap = new Map(children.map(t => [t.id, t]));

  const enrichedWaves: EnrichedWave[] = waves.map(w => ({
    ...w,
    tasks: w.tasks.map(id => ({
      id,
      title: taskMap.get(id)?.title || id,
      status: taskMap.get(id)?.status || 'unknown',
    })),
  }));

  return {
    epicId,
    waves: enrichedWaves,
    totalWaves: waves.length,
    totalTasks: children.length,
  };
}
