/**
 * Parallel execution state management.
 * @task T4784
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { computeWaves } from './waves.js';

interface ParallelState {
  active: boolean;
  epicId?: string;
  wave?: number;
  startedAt?: string;
  tasks?: string[];
}

const PARALLEL_STATE_KEY = 'parallel_state';

async function readParallelState(accessor: DataAccessor): Promise<ParallelState> {
  const state = await accessor.getMetaValue<ParallelState>(PARALLEL_STATE_KEY);
  return state ?? { active: false };
}

async function writeParallelState(state: ParallelState, accessor: DataAccessor): Promise<void> {
  await accessor.setMetaValue(PARALLEL_STATE_KEY, state);
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
  const acc = accessor ?? (await getAccessor(cwd));

  const currentState = await readParallelState(acc);
  if (currentState.active) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `Parallel execution already active for epic ${currentState.epicId}, wave ${currentState.wave}`,
    );
  }

  const epic = await acc.loadSingleTask(epicId);
  if (!epic) {
    throw new CleoError(ExitCode.NOT_FOUND, `Epic ${epicId} not found`);
  }

  const children = await acc.getChildren(epicId);
  const waves = computeWaves(children);
  const targetWave = waves.find((w) => w.waveNumber === wave);

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

  await writeParallelState(state, acc);

  return {
    epicId,
    wave,
    tasks: targetWave.tasks,
    taskCount: targetWave.tasks.length,
    startedAt,
  };
}

/** End parallel execution for a wave. */
export async function endParallelExecution(
  epicId: string,
  wave: number,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{
  epicId: string;
  wave: number;
  tasks: string[];
  taskCount: number;
  startedAt: string | null;
  endedAt: string;
  durationMs: number;
  alreadyEnded?: boolean;
}> {
  const acc = accessor ?? (await getAccessor(cwd));
  const currentState = await readParallelState(acc);

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

  await writeParallelState({ active: false }, acc);

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
export async function getParallelStatus(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<ParallelState> {
  const acc = accessor ?? (await getAccessor(cwd));
  return readParallelState(acc);
}
