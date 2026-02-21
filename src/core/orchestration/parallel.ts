/**
 * Parallel execution state management.
 * @task T4784
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { computeWaves } from './waves.js';
import { readJson } from '../../store/json.js';
import { getTodoPath } from '../paths.js';
import type { TodoFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

interface ParallelState {
  active: boolean;
  epicId?: string;
  wave?: number;
  startedAt?: string;
  tasks?: string[];
}

function getParallelStatePath(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'parallel-state.json');
}

function readParallelState(projectRoot: string): ParallelState {
  const statePath = getParallelStatePath(projectRoot);
  if (!existsSync(statePath)) return { active: false };
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { active: false };
  }
}

function writeParallelState(state: ParallelState, projectRoot: string): void {
  const statePath = getParallelStatePath(projectRoot);
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/** Start parallel execution for a wave. */
export async function startParallelExecution(
  epicId: string,
  wave: number,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{
  epicId: string;
  wave: number;
  tasks: string[];
  taskCount: number;
  startedAt: string;
}> {
  const projectRoot = cwd ?? process.cwd();

  const currentState = readParallelState(projectRoot);
  if (currentState.active) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `Parallel execution already active for epic ${currentState.epicId}, wave ${currentState.wave}`,
    );
  }

  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJson<TodoFile>(getTodoPath(cwd));

  const tasks = data?.tasks ?? [];
  const epic = tasks.find(t => t.id === epicId);
  if (!epic) {
    throw new CleoError(ExitCode.NOT_FOUND, `Epic ${epicId} not found`);
  }

  const children = tasks.filter(t => t.parentId === epicId);
  const waves = computeWaves(children);
  const targetWave = waves.find(w => w.waveNumber === wave);

  if (!targetWave) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Wave ${wave} not found for epic ${epicId}`);
  }

  const startedAt = new Date().toISOString();
  const state: ParallelState = {
    active: true,
    epicId,
    wave,
    startedAt,
    tasks: targetWave.tasks,
  };

  writeParallelState(state, projectRoot);

  return {
    epicId,
    wave,
    tasks: targetWave.tasks,
    taskCount: targetWave.tasks.length,
    startedAt,
  };
}

/** End parallel execution for a wave. */
export function endParallelExecution(
  epicId: string,
  wave: number,
  cwd?: string,
): {
  epicId: string;
  wave: number;
  tasks: string[];
  taskCount: number;
  startedAt: string | null;
  endedAt: string;
  durationMs: number;
  alreadyEnded?: boolean;
} {
  const projectRoot = cwd ?? process.cwd();
  const currentState = readParallelState(projectRoot);

  if (!currentState.active) {
    return {
      epicId,
      wave,
      tasks: [],
      taskCount: 0,
      startedAt: null,
      endedAt: new Date().toISOString(),
      durationMs: 0,
      alreadyEnded: true,
    };
  }

  if (currentState.epicId !== epicId || currentState.wave !== wave) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Active parallel is for epic ${currentState.epicId} wave ${currentState.wave}, not epic ${epicId} wave ${wave}`,
    );
  }

  const duration = currentState.startedAt
    ? Date.now() - new Date(currentState.startedAt).getTime()
    : 0;

  writeParallelState({ active: false }, projectRoot);

  return {
    epicId,
    wave,
    tasks: currentState.tasks || [],
    taskCount: currentState.tasks?.length || 0,
    startedAt: currentState.startedAt || null,
    endedAt: new Date().toISOString(),
    durationMs: duration,
  };
}

/** Get current parallel execution state. */
export function getParallelStatus(cwd?: string): ParallelState {
  return readParallelState(cwd ?? process.cwd());
}
